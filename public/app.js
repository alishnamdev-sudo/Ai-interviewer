/**
 * App — main interview state machine.
 * Depends on: VoiceManager, ReportManager, getRandomQuestion (questions.js)
 */

// ─── Stage Configuration ──────────────────────────────────────────────────────
const STAGES = [
  'WELLBEING',
  'INTRO',
  'EDUCATION',
  'TRACK_RECORD',
  'TEACHING_STYLE',
  'METHODOLOGY',
  'PROBLEM_SOLVE',
  'EVALUATION',
  'WRAP_UP'
];

const STAGE_LABELS = {
  WELLBEING:     'Well-being Check',
  INTRO:         'Introduction',
  EDUCATION:     'Educational Background',
  TRACK_RECORD:  'Academic Track Record',
  TEACHING_STYLE:'Teaching Style',
  METHODOLOGY:   'Teaching Methodology',
  PROBLEM_SOLVE: 'Problem Solving',
  EVALUATION:    'Solution Evaluation',
  WRAP_UP:       'Wrap Up'
};

// Stage opener prompts (trigger AI to begin the stage naturally)
const STAGE_OPENERS = {
  WELLBEING:     (name)    => `You are starting the interview. Greet ${name} warmly and ask how they are feeling today. Keep it short.`,
  INTRO:         ()        => `[NEW_STAGE: INTRO] Ask your first question about the teacher's introduction — name, years of experience, or current role.`,
  EDUCATION:     ()        => `[NEW_STAGE: EDUCATION] Ask your first question about the teacher's educational background.`,
  TRACK_RECORD:  ()        => `[NEW_STAGE: TRACK_RECORD] Ask your first question about the academic ranks or toppers this teacher has produced.`,
  TEACHING_STYLE:()        => `[NEW_STAGE: TEACHING_STYLE] Ask your first question about how this teacher typically explains complex concepts.`,
  METHODOLOGY:   ()        => `[NEW_STAGE: METHODOLOGY] Ask your first question about how many Previous Year Questions (PYQs) the teacher covers in each class.`,
  EVALUATION:    ()        => null, // handled by submitSolution
  WRAP_UP:       ()        => `[NEW_STAGE: WRAP_UP] Thank the teacher for their time and invite any final thoughts.`,
};

// ─── Whiteboard Timer ─────────────────────────────────────────────────────────
const SOLVE_SECONDS = 90;

// If the candidate stays silent this long after the AI asks a (non-whiteboard)
// question, treat it as no-answer and move on rather than waiting forever.
const SILENCE_TIMEOUT_MS = 10000;

// If that happens this many times in a row, end the interview early instead
// of continuing to prompt an interviewee who isn't responding.
const MAX_CONSECUTIVE_SILENCES = 5;

const Timer = {
  remaining: SOLVE_SECONDS,
  intervalId: null,
  onExpire: null,

  start(seconds, onTick, onExpire) {
    this.stop();
    this.remaining = seconds;
    this.onExpire = onExpire;
    onTick(this.remaining, seconds);
    this.intervalId = setInterval(() => {
      this.remaining--;
      onTick(this.remaining, seconds);
      if (this.remaining <= 0) {
        this.stop();
        if (this.onExpire) this.onExpire();
      }
    }, 1000);
  },

  stop() {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
  }
};

// ─── App Object ───────────────────────────────────────────────────────────────
const App = {
  s: {
    teacherName:   '',
    subject:       '',
    stageIndex:    0,
    history:       [],        // Gemini API history (alternating user/model)
    currentQuestion: null,
    problemScore:  0,
    isProcessing:  false,
    startDate:     '',
    dictating:     false,
    dictatedText:  '',
    silenceTimer:  null,
    consecutiveSilences: 0,
    quitting:      false
  },

  get stage() { return STAGES[this.s.stageIndex]; },

  // ── Setup ──────────────────────────────────────────────────────────────────
  async startInterview() {
    const name    = document.getElementById('teacher-name').value.trim();
    const subject = document.getElementById('subject-select').value;

    if (!name)    { this.flashError('teacher-name',    'Please enter your name');      return; }
    if (!subject) { this.flashError('subject-select',  'Please select a subject');     return; }

    this.s.teacherName = name;
    this.s.subject     = subject;
    this.s.startDate   = new Date().toLocaleString('en-IN');

    const { supported } = VoiceManager.init();
    if (!supported) {
      document.getElementById('browser-warning').classList.remove('hidden');
      return;
    }

    document.getElementById('start-btn').disabled = true;
    document.getElementById('start-btn').textContent = 'Initialising…';

    await VoiceManager.loadVoice();
    Whiteboard.init('wb-canvas', 'wb-canvas-wrap');

    this.showScreen('interview');
    this.updateStageUI();
    await this.beginStage();
  },

  // ── Stage Management ───────────────────────────────────────────────────────
  async beginStage() {
    const stage = this.stage;

    if (stage === 'PROBLEM_SOLVE') {
      await this.launchProblemSolving();
      return;
    }

    const openerFn = STAGE_OPENERS[stage];
    if (!openerFn) { await this.advanceStage(); return; }

    const triggerMsg = openerFn(this.s.teacherName);
    if (!triggerMsg) { await this.advanceStage(); return; }

    this.setStatus('thinking');

    try {
      const resp = await this.callChat(triggerMsg, /*hidden*/ true);
      this.renderAIMsg(resp.text);
      this.addEntry('AI Interviewer', resp.text, STAGE_LABELS[stage]);

      this.setStatus('speaking');
      VoiceManager.speak(resp.text, () => {
        if (resp.stageComplete) { this.advanceStage(); }
        else { this.startListening(); }
      });
    } catch (e) { this.handleErr(e); }
  },

  async handleAnswer(text) {
    if (this.s.isProcessing || !text.trim()) return;
    this.s.isProcessing = true;
    this.setMic(false);
    this.s.consecutiveSilences = 0; // a real answer came in, regardless of entry point — reset the streak

    this.renderUserMsg(text);
    this.addEntry('Teacher', text, STAGE_LABELS[this.stage]);

    this.setStatus('thinking');

    try {
      const resp = await this.callChat(text, /*hidden*/ false);
      this.renderAIMsg(resp.text);
      this.addEntry('AI Interviewer', resp.text, STAGE_LABELS[this.stage]);

      this.setStatus('speaking');
      VoiceManager.speak(resp.text, () => {
        this.s.isProcessing = false;
        // WRAP_UP is the last stage — end after this one reply regardless of
        // whether the model remembered to emit [STAGE_COMPLETE], so the
        // interview can't loop forever waiting for a token that never comes.
        if (resp.stageComplete || this.stage === 'WRAP_UP') { this.advanceStage(); }
        else { this.startListening(); }
      });
    } catch (e) {
      this.s.isProcessing = false;
      this.handleErr(e);
    }
  },

  async advanceStage() {
    this.s.stageIndex++;
    if (this.s.stageIndex >= STAGES.length) {
      await this.generateReport();
    } else {
      this.updateStageUI();
      await this.beginStage();
    }
  },

  // ── Gemini API Proxy ───────────────────────────────────────────────────────
  async callChat(userMessage, hidden) {
    // History to send = everything BEFORE this new message
    const historyToSend = [...this.s.history];

    const body = {
      history:     historyToSend,
      userMessage,
      stage:       this.stage,
      teacherName: this.s.teacherName,
      subject:     this.s.subject
    };

    // Add user turn to local history
    this.s.history.push({ role: 'user', parts: [{ text: userMessage }] });

    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.details || 'Server error ' + res.status);
    }

    const data = await res.json();

    // Add model turn to local history
    this.s.history.push({ role: 'model', parts: [{ text: data.text }] });

    return data; // { text, stageComplete }
  },

  // ── Problem Solving (Whiteboard) ───────────────────────────────────────────
  async launchProblemSolving() {
    this.clearSilenceTimer(); // whiteboard uses its own 90s Timer, not this
    const q = getRandomQuestion(this.s.subject);
    this.s.currentQuestion = q;

    const announcement = `Wonderful! We've had a great conversation. I'd now like to see your ${this.s.subject} problem-solving approach. You'll have 90 seconds to solve a problem on the whiteboard — write with a pen or stylus, or speak your solution if you don't have one.`;

    this.renderAIMsg(announcement);
    this.addEntry('AI Interviewer', announcement, 'Problem Solving');
    this.setStatus('speaking');

    VoiceManager.speak(announcement, () => {
      this.showScreen('problem');
      this.renderProblem(q);
    });
  },

  renderProblem(q) {
    document.getElementById('q-text').innerHTML      = q.question.replace(/\n/g, '<br>');
    document.getElementById('q-topic').textContent   = q.topic;
    document.getElementById('q-diff').textContent    = q.difficulty;
    document.getElementById('q-subj').textContent    = q.subject;

    Whiteboard.clear();
    Whiteboard.setTool('pen');
    this.s.dictating = false;
    this.s.dictatedText = '';
    document.getElementById('dictation-panel').classList.add('hidden');
    document.getElementById('dictation-text').textContent = '';
    document.getElementById('dictate-btn').classList.remove('active');
    document.getElementById('dictate-btn').textContent = '🎤 No pen? Speak your solution';

    const btn = document.getElementById('submit-solution-btn');
    btn.disabled = false;
    btn.innerHTML = '✔ Submit Solution';

    // Canvas is inside a screen that was just made visible (display:none -> flex).
    // Querying layout here forces the browser to flush that style change first,
    // so the wrap element already reports its real size — no rAF/timeout needed.
    Whiteboard.resize();

    Timer.start(SOLVE_SECONDS, (remaining, total) => this.updateTimerUI(remaining, total), () => {
      this.showToast("Time's up! Submitting your solution…", 'warn');
      this.submitSolution(/*auto*/ true);
    });
  },

  updateTimerUI(remaining, total) {
    const text = document.getElementById('timer-text');
    const ring = document.getElementById('timer-ring-fg');
    const badge = document.getElementById('timer-badge');
    if (!text || !ring || !badge) return;

    const m = Math.floor(Math.max(remaining, 0) / 60);
    const s = Math.max(remaining, 0) % 60;
    text.textContent = `${m}:${String(s).padStart(2, '0')}`;

    const C = 2 * Math.PI * 16;
    const offset = C * (1 - Math.max(remaining, 0) / total);
    ring.style.strokeDasharray = C.toFixed(2);
    ring.style.strokeDashoffset = offset.toFixed(2);

    badge.classList.toggle('warning', remaining <= 30 && remaining > 10);
    badge.classList.toggle('danger', remaining <= 10);
  },

  toggleDictation() {
    const btn = document.getElementById('dictate-btn');
    const panel = document.getElementById('dictation-panel');
    const textEl = document.getElementById('dictation-text');

    if (this.s.dictating) {
      VoiceManager.stopDictation();
      this.s.dictating = false;
      btn.classList.remove('active');
      btn.textContent = '🎤 No pen? Speak your solution';
      return;
    }

    this.s.dictating = true;
    btn.classList.add('active');
    btn.textContent = '⏹ Stop Speaking';
    panel.classList.remove('hidden');

    VoiceManager.startDictation(
      interim => { textEl.textContent = (this.s.dictatedText + ' ' + interim).trim(); },
      finalChunk => {
        this.s.dictatedText = (this.s.dictatedText + ' ' + finalChunk).trim();
        textEl.textContent = this.s.dictatedText;
      },
      err => {
        console.warn('Dictation error:', err);
        this.s.dictating = false;
        btn.classList.remove('active');
        btn.textContent = '🎤 No pen? Speak your solution';
        if (!this.s.dictatedText) panel.classList.add('hidden');
        this.showToast('Could not access microphone for dictation.', 'error');
      }
    );
  },

  async submitSolution(auto = false) {
    Timer.stop();
    if (this.s.dictating) {
      VoiceManager.stopDictation();
      this.s.dictating = false;
      document.getElementById('dictate-btn').classList.remove('active');
    }

    const hasDrawing = Whiteboard.hasContent();
    const dictatedText = (this.s.dictatedText || '').trim();

    if (!auto && !hasDrawing && !dictatedText) {
      this.showToast('Please write on the whiteboard or speak your solution before submitting.', 'warn');
      // give them the remaining time back since nothing was actually submitted
      Timer.start(Math.max(Timer.remaining, 10), (r, t) => this.updateTimerUI(r, t), () => {
        this.showToast("Time's up! Submitting your solution…", 'warn');
        this.submitSolution(true);
      });
      return;
    }

    const btn     = document.getElementById('submit-solution-btn');
    btn.disabled  = true;
    btn.innerHTML = '<span class="spinner"></span> Evaluating…';

    try {
      const res = await fetch('/api/evaluate', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          question:    this.s.currentQuestion.question,
          subject:     this.s.subject,
          imageBase64: hasDrawing ? Whiteboard.exportPNG() : null,
          dictatedText: dictatedText || null
        })
      });
      const ev = await res.json();
      this.s.problemScore = ev.score ?? 5;

      // Log solution in transcript
      const summary = [
        hasDrawing ? '[Handwritten solution submitted on whiteboard]' : null,
        dictatedText ? `Dictated: ${dictatedText}` : null,
        (!hasDrawing && !dictatedText) ? '[No solution submitted — time expired]' : null
      ].filter(Boolean).join(' | ');
      this.addEntry('Teacher (Solution)', summary, 'Problem Solving');

      // Advance to EVALUATION stage
      this.s.stageIndex = STAGES.indexOf('EVALUATION');
      this.showScreen('interview');
      this.updateStageUI();

      // Compose evaluation speech
      const evalSpeech = `${ev.evaluation} ${ev.feedback}`;
      this.renderAIMsg(evalSpeech);
      this.addEntry('AI Interviewer', evalSpeech, 'Solution Evaluation');
      this.s.history.push({ role: 'model', parts: [{ text: evalSpeech }] });

      this.setStatus('speaking');
      VoiceManager.speak(evalSpeech, () => {
        if (!ev.followUpQuestion) {
          this.startListening(); return;
        }
        setTimeout(() => {
          this.renderAIMsg(ev.followUpQuestion);
          this.addEntry('AI Interviewer', ev.followUpQuestion, 'Solution Evaluation');
          this.s.history.push({ role: 'model', parts: [{ text: ev.followUpQuestion }] });
          VoiceManager.speak(ev.followUpQuestion, () => {
            this.startListening();
          });
        }, 700);
      });

    } catch (e) {
      btn.disabled  = false;
      btn.innerHTML = '✔ Submit Solution';
      this.handleErr(e);
    }
  },

  // ── Report ─────────────────────────────────────────────────────────────────
  // The evaluation report is generated and stored on the server only — it is
  // never sent back to or rendered in the candidate's browser. The candidate
  // just sees a thank-you screen; results are reviewed later via /admin.
  async generateReport() {
    this.showScreen('loading');

    try {
      const res = await fetch('/api/report', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript:   ReportManager.getPlainTranscript(),
          teacherName:  this.s.teacherName,
          subject:      this.s.subject,
          problemScore: this.s.problemScore
        })
      });
      if (!res.ok) throw new Error('Server error ' + res.status);

      this.showScreen('report');
    } catch (e) {
      this.showScreen('report');
      document.getElementById('report-container').innerHTML =
        `<p class="error-msg">⚠️ Something went wrong submitting your interview. Please let the recruitment team know.</p>`;
    }
  },

  // ── Mic Button ─────────────────────────────────────────────────────────────
  onMicClick() {
    if (VoiceManager.isListening) {
      this.clearSilenceTimer();
      VoiceManager.stopListening();
      this.setStatus('idle');
      return;
    }
    // Tapping the mic while the AI is still talking interrupts it (barge-in)
    // and starts listening immediately — startListening() handles the cancel.
    this.startListening();
  },

  // Starts listening for the candidate's answer. Called automatically once the
  // AI finishes speaking, or manually via the mic button (which also serves as
  // the interrupt/barge-in control while the AI is still speaking). Does NOT
  // apply during the whiteboard problem-solving screen — that has its own
  // 90-second Timer and doesn't call this.
  startListening() {
    if (VoiceManager.isListening) return;
    if (VoiceManager.isSpeaking) VoiceManager.stopSpeaking();

    this.setStatus('listening');
    this.setMic(true, true);
    this.armSilenceTimer();

    VoiceManager.listen(
      finalText => {
        this.clearSilenceTimer();
        this.setStatus('thinking');
        this.handleAnswer(finalText);
      },
      interim => {
        this.armSilenceTimer(); // speech activity — push the silence deadline out
        const el = document.getElementById('status-text');
        if (el) el.textContent = `"${interim}"`;
      },
      err => {
        this.clearSilenceTimer();
        console.warn('Voice error:', err);
        this.setStatus('idle');
        this.setMic(true);
      }
    );
  },

  armSilenceTimer() {
    this.clearSilenceTimer();
    this.s.silenceTimer = setTimeout(() => {
      if (!VoiceManager.isListening) return;
      VoiceManager.stopListening();
      this.handleSilence();
    }, SILENCE_TIMEOUT_MS);
  },

  clearSilenceTimer() {
    if (this.s.silenceTimer) {
      clearTimeout(this.s.silenceTimer);
      this.s.silenceTimer = null;
    }
  },

  // Candidate didn't answer within SILENCE_TIMEOUT_MS — nudge the AI to
  // acknowledge the silence and move on, without inventing a fake spoken answer.
  // After MAX_CONSECUTIVE_SILENCES in a row, end the interview instead.
  async handleSilence() {
    if (this.s.isProcessing) return;
    this.s.isProcessing = true;
    this.setMic(false);

    this.addEntry('Teacher', '[No response — moved on after 10s of silence]', STAGE_LABELS[this.stage]);

    this.s.consecutiveSilences++;
    if (this.s.consecutiveSilences >= MAX_CONSECUTIVE_SILENCES) {
      this.s.isProcessing = false;
      await this.endInterviewEarly();
      return;
    }

    this.setStatus('thinking');

    try {
      const resp = await this.callChat(
        '[SYSTEM NOTE: The candidate did not respond within 10 seconds. Briefly acknowledge the silence in one short phrase, then move on — ask a different question next, do not repeat the one they just missed.]',
        /*hidden*/ true
      );
      this.renderAIMsg(resp.text);
      this.addEntry('AI Interviewer', resp.text, STAGE_LABELS[this.stage]);

      this.setStatus('speaking');
      VoiceManager.speak(resp.text, () => {
        this.s.isProcessing = false;
        // Same end-of-interview safeguard as handleAnswer — don't keep
        // re-prompting a silent candidate through further WRAP_UP rounds.
        if (resp.stageComplete || this.stage === 'WRAP_UP') { this.advanceStage(); }
        else { this.startListening(); }
      });
    } catch (e) {
      this.s.isProcessing = false;
      this.handleErr(e);
    }
  },

  // Called when the candidate has missed MAX_CONSECUTIVE_SILENCES questions in a
  // row — stop prompting and go straight to the report with whatever transcript
  // exists so far, rather than continuing to talk to an unresponsive candidate.
  async endInterviewEarly() {
    this.clearSilenceTimer();
    const closing = "It looks like we're having trouble hearing from you, so we'll end the interview here. Thank you for your time today.";
    this.renderAIMsg(closing);
    this.addEntry('AI Interviewer', closing, STAGE_LABELS[this.stage] || 'Wrap Up');

    this.setStatus('speaking');
    VoiceManager.speak(closing, () => {
      this.generateReport();
    });
  },

  // Candidate chose to end the interview themselves (the "Quit Interview"
  // button, available on both the chat and whiteboard screens). Stops
  // whatever's in flight and submits the transcript collected so far.
  async quitInterview() {
    if (this.s.quitting) return;

    const ok = confirm('End the interview now? Your responses so far will be submitted for review and this cannot be undone.');
    if (!ok) return;

    this.s.quitting = true;

    this.clearSilenceTimer();
    Timer.stop();
    if (this.s.dictating) {
      VoiceManager.stopDictation();
      this.s.dictating = false;
    }
    VoiceManager.stopListening();
    VoiceManager.stopSpeaking();
    this.s.isProcessing = false;

    this.addEntry('Teacher', '[Interview ended early by candidate]', STAGE_LABELS[this.stage] || 'Wrap Up');

    await this.generateReport();
  },

  // ── UI Helpers ─────────────────────────────────────────────────────────────
  showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = document.getElementById(`screen-${name}`);
    if (el) el.classList.add('active');
  },

  updateStageUI() {
    const label    = STAGE_LABELS[this.stage] || this.stage;
    const progress = (this.s.stageIndex / (STAGES.length - 1)) * 100;

    const labelEl = document.getElementById('stage-label');
    const barEl   = document.getElementById('stage-progress-bar');
    if (labelEl) labelEl.textContent  = label;
    if (barEl)   barEl.style.width    = `${progress}%`;

    // Stage dots
    document.querySelectorAll('.stage-dot').forEach((dot, i) => {
      dot.classList.toggle('done',   i < this.s.stageIndex);
      dot.classList.toggle('active', i === this.s.stageIndex);
    });
  },

  renderAIMsg(text) {
    this._appendMsg('ai', text);
  },

  renderUserMsg(text) {
    this._appendMsg('user', text);
  },

  _appendMsg(role, text) {
    const box = document.getElementById('messages');
    if (!box) return;

    const wrap = document.createElement('div');
    wrap.className = `msg-wrap ${role}`;
    wrap.innerHTML = `
      <div class="msg-avatar">${role === 'ai' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/><path d="M9 8h.01M15 8h.01" stroke-width="2"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>'}</div>
      <div class="msg-bubble">
        <p class="msg-text">${text}</p>
      </div>
    `;
    box.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add('visible'));
    wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  addEntry(speaker, text, stage) {
    ReportManager.addEntry(speaker, text, stage);
  },

  setStatus(status) {
    // status: 'idle' | 'listening' | 'thinking' | 'speaking'
    const map = {
      idle:      'Tap the mic to speak',
      listening: 'Listening…',
      thinking:  'Thinking…',
      speaking:  'AI is speaking… (tap mic to jump in)'
    };
    const el = document.getElementById('status-text');
    if (el) el.textContent = map[status] || '';

    const wv = document.getElementById('waveform');
    if (wv) {
      wv.className = 'waveform';
      if (status === 'speaking')  wv.classList.add('active', 'speaking');
      if (status === 'listening') wv.classList.add('active', 'recording');
    }

    // The mic stays tappable while the AI is speaking so the candidate can
    // interrupt (barge-in) — only 'thinking' (a pending network call, nothing
    // to interrupt yet) actually disables it.
    const mic = document.getElementById('mic-btn');
    if (mic) {
      mic.classList.remove('listening', 'disabled', 'interruptible');
      mic.disabled = false;
      if (status === 'listening') mic.classList.add('listening');
      if (status === 'thinking') { mic.classList.add('disabled'); mic.disabled = true; }
      if (status === 'speaking') mic.classList.add('interruptible');
    }
  },

  setMic(enabled, listening = false) {
    const btn = document.getElementById('mic-btn');
    if (!btn) return;
    btn.disabled = !enabled;
    btn.classList.toggle('listening', listening);
  },

  showToast(msg, type = 'info') {
    const t = document.createElement('div');
    t.className = `toast toast-${type}`;
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 400); }, 3200);
  },

  flashError(id, msg) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add('error');
    el.placeholder = msg;
    setTimeout(() => el.classList.remove('error'), 2000);
  },

  handleErr(e) {
    console.error(e);
    this.clearSilenceTimer();
    this.setStatus('idle');
    this.setMic(true);
    this.renderAIMsg('I apologise, there was a technical issue. Please try again.');
    this.showToast('Connection error — please check the server is running.', 'error');
  }
};
