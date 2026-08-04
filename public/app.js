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

// Stage opener prompts (trigger AI to begin the stage naturally). Some accept
// a `hasResume` flag so the opener steers toward resume-aware follow-ups
// instead of blindly asking for facts the resume already covers.
const STAGE_OPENERS = {
  WELLBEING:     (name)    => `You are starting the interview. Greet ${name} warmly and ask how they are feeling today. Keep it short.`,
  INTRO:         (name, hasResume) => hasResume
    ? `[NEW_STAGE: INTRO] The candidate's resume is attached in your instructions. Briefly reference something specific from it and ask ONE deeper follow-up question about their role or experience — do not re-ask for facts already in the resume.`
    : `[NEW_STAGE: INTRO] Ask your first question about the teacher's introduction — name, years of experience, or current role.`,
  EDUCATION:     (name, hasResume) => hasResume
    ? `[NEW_STAGE: EDUCATION] The candidate's resume is attached in your instructions. If it already lists their degrees/university, ask ONE deeper follow-up (e.g. about their specialization or a relevant project) instead of re-asking basic facts.`
    : `[NEW_STAGE: EDUCATION] Ask your first question about the teacher's educational background.`,
  TRACK_RECORD:  (name, hasResume) => hasResume
    ? `[NEW_STAGE: TRACK_RECORD] The candidate's resume is attached in your instructions. If achievements/ranks/toppers are already listed there, ask ONE deeper follow-up about one of them instead of asking from scratch.`
    : `[NEW_STAGE: TRACK_RECORD] Ask your first question about the academic ranks or toppers this teacher has produced.`,
  TEACHING_STYLE:()        => `[NEW_STAGE: TEACHING_STYLE] Ask your first question about how this teacher typically explains complex concepts.`,
  METHODOLOGY:   ()        => `[NEW_STAGE: METHODOLOGY] Ask your first question about how many Previous Year Questions (PYQs) the teacher covers in each class.`,
  EVALUATION:    ()        => null, // handled by submitSolution
  WRAP_UP:       ()        => `[NEW_STAGE: WRAP_UP] Thank the teacher for their time and invite any final thoughts.`,
};

const SUBMIT_BTN_MARKUP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg> Submit Solution';

// ─── Whiteboard Timer ─────────────────────────────────────────────────────────
const SOLVE_SECONDS = 90;

// If the candidate stays silent this long after the AI asks a (non-whiteboard)
// question — i.e. hasn't started speaking at all — treat it as no-answer and
// move on rather than waiting forever.
const SILENCE_TIMEOUT_MS = 10000;

// Once the candidate HAS started speaking, a shorter pause is enough to
// consider their answer complete (they don't need another full 10s grace
// period every time they take a breath mid-sentence).
const PAUSE_TIMEOUT_MS = 5000;

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
    spokenLang:    'en-IN',
    stageIndex:    0,
    history:       [],        // Gemini API history (alternating user/model)
    currentQuestion: null,
    problemScore:  0,
    isProcessing:  false,
    startDate:     '',
    dictating:     false,
    dictatedText:  '',
    silenceTimer:  null,
    lastRecognizedText: '',
    consecutiveSilences: 0,
    quitting:      false,
    resumeAnalyzing: false,
    resumeAnalyzed:  false,
    resumeSummary:   null, // summaryText string sent to the AI as resume context
    resumeInfo:      null  // structured { name, yearsExperience, ... } for the confirmation card
  },

  get stage() { return STAGES[this.s.stageIndex]; },

  // ── Setup ──────────────────────────────────────────────────────────────────
  async startInterview() {
    const name    = document.getElementById('teacher-name').value.trim();
    const subject = document.getElementById('subject-select').value;
    const spokenLang = document.getElementById('language-select').value || 'en-IN';

    if (!name)    { this.flashError('teacher-name',    'Please enter your name');      return; }
    if (!subject) { this.flashError('subject-select',  'Please select a subject');     return; }
    if (this.s.resumeAnalyzing) { this.showToast('Please wait — still analysing your resume…', 'warn'); return; }
    if (!this.s.resumeAnalyzed) {
      this.showToast('Please upload your resume/CV before starting the interview.', 'warn');
      const zone = document.getElementById('resume-upload-zone');
      if (zone) { zone.classList.add('error-flash'); setTimeout(() => zone.classList.remove('error-flash'), 2000); }
      return;
    }

    this.s.teacherName = name;
    this.s.subject     = subject;
    this.s.spokenLang  = spokenLang;
    this.s.startDate   = new Date().toLocaleString('en-IN');

    // Recognition listens in whichever language the candidate picked; the AI
    // always speaks back in Indian English (VoiceManager.speak forces this
    // independent of recognition language — see voice.js).
    const { supported } = VoiceManager.init(spokenLang);
    if (!supported) {
      document.getElementById('browser-warning').classList.remove('hidden');
      return;
    }

    document.getElementById('start-btn').disabled = true;
    document.getElementById('start-btn').textContent = 'Initialising…';

    await VoiceManager.loadVoice();
    if (!VoiceManager.isIndianVoice) {
      // Best-effort only: no Indian-English voice was found on this browser/OS,
      // so names and Indian-context words will come out in a generic accent.
      // Nudge toward Edge, which ships a genuine Indian neural voice (Neerja)
      // by default — this doesn't block starting the interview either way.
      this.showToast('No Indian-English voice detected — try Microsoft Edge for authentic pronunciation.', 'info');
    }
    Whiteboard.init('wb-canvas', 'wb-canvas-wrap');

    this.showScreen('interview');
    this.updateStageUI();
    await this.beginStage();
  },

  // ── Resume Upload ──────────────────────────────────────────────────────────
  onResumeSelected(event) {
    const file = event.target.files && event.target.files[0];
    if (file) this._handleResumeFile(file);
  },

  onResumeDragOver(event) {
    event.preventDefault();
    document.getElementById('resume-upload-zone').classList.add('drag-over');
  },

  onResumeDragLeave(event) {
    event.preventDefault();
    document.getElementById('resume-upload-zone').classList.remove('drag-over');
  },

  onResumeDrop(event) {
    event.preventDefault();
    document.getElementById('resume-upload-zone').classList.remove('drag-over');
    const file = event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) this._handleResumeFile(file);
  },

  async _handleResumeFile(file) {
    const DEFAULT_HINT = 'PDF, PNG, JPG or TXT — max 8MB';
    const statusEl = document.getElementById('resume-status');
    const nameEl   = document.getElementById('resume-filename');
    const cardEl   = document.getElementById('resume-summary-card');

    this.s.resumeAnalyzed = false;
    this.s.resumeSummary  = null;
    this.s.resumeInfo     = null;
    cardEl.classList.add('hidden');
    cardEl.innerHTML = '';

    if (!file) { nameEl.textContent = DEFAULT_HINT; statusEl.textContent = ''; return; }

    nameEl.textContent = file.name;

    const fileInput = document.getElementById('resume-input');

    const MAX_BYTES = 8 * 1024 * 1024;
    if (file.size > MAX_BYTES) {
      statusEl.className = 'field-hint resume-status error';
      statusEl.textContent = 'File is too large (max 8MB). Please upload a smaller file.';
      if (fileInput) fileInput.value = '';
      return;
    }

    const extMimeMap = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', txt: 'text/plain' };
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const mimeType = extMimeMap[ext] || file.type;
    if (!mimeType || !Object.values(extMimeMap).includes(mimeType)) {
      statusEl.className = 'field-hint resume-status error';
      statusEl.textContent = 'Unsupported file type. Please upload a PDF, PNG, JPG, or TXT resume.';
      if (fileInput) fileInput.value = '';
      return;
    }

    this.s.resumeAnalyzing = true;
    statusEl.className = 'field-hint resume-status analyzing';
    statusEl.textContent = 'Analysing your resume…';

    try {
      const fileBase64 = await this._readFileAsBase64(file);
      const res = await fetch('/api/parse-resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileBase64, mimeType })
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Resume analysis failed');

      this.s.resumeInfo    = data.resume;
      this.s.resumeSummary = data.resume.summaryText || null;
      this.s.resumeAnalyzed = true;

      statusEl.className = 'field-hint resume-status success';
      statusEl.textContent = '✓ Resume analysed successfully';

      this._renderResumeSummaryCard(data.resume);

      // Pre-fill the name field from the resume if the candidate hasn't typed one yet.
      const nameInput = document.getElementById('teacher-name');
      if (nameInput && !nameInput.value.trim() && data.resume.name) {
        nameInput.value = data.resume.name;
      }
    } catch (e) {
      console.error('Resume analysis error:', e);
      statusEl.className = 'field-hint resume-status error';
      statusEl.textContent = 'Could not analyse this resume. Please try again or use a different file.';
      this.s.resumeAnalyzed = false;
    } finally {
      this.s.resumeAnalyzing = false;
    }
  },

  _readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result); // data: URL, server strips the prefix
      reader.onerror = () => reject(reader.error || new Error('File read failed'));
      reader.readAsDataURL(file);
    });
  },

  _renderResumeSummaryCard(resume) {
    const cardEl = document.getElementById('resume-summary-card');
    if (!cardEl) return;
    const items = [];
    if (resume.yearsExperience)  items.push(`<li>${resume.yearsExperience} of experience</li>`);
    if (resume.currentInstitute) items.push(`<li>${resume.currentInstitute}</li>`);
    if (Array.isArray(resume.education) && resume.education.length) items.push(`<li>${resume.education[0]}</li>`);
    if (Array.isArray(resume.achievements) && resume.achievements.length) items.push(`<li>${resume.achievements[0]}</li>`);

    cardEl.innerHTML = `<strong>${resume.name || 'Candidate'} — detected from resume</strong>${items.length ? `<ul>${items.join('')}</ul>` : ''}`;
    cardEl.classList.remove('hidden');
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

    const triggerMsg = openerFn(this.s.teacherName, !!this.s.resumeSummary);
    if (!triggerMsg) { await this.advanceStage(); return; }

    this.setStatus('thinking');

    try {
      const resp = await this.callChat(triggerMsg, /*hidden*/ true);
      if (this.s.quitting) return; // candidate quit while this was in flight

      this.renderAIMsg(resp.text);
      this.addEntry('AI Interviewer', resp.text, STAGE_LABELS[stage]);

      this.setStatus('speaking');
      VoiceManager.speak(resp.text, () => {
        if (this.s.quitting) return;
        if (resp.stageComplete) { this.advanceStage(); }
        else { this.startListening(); }
      });
    } catch (e) { if (!this.s.quitting) this.handleErr(e); }
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
      if (this.s.quitting) { this.s.isProcessing = false; return; }

      this.renderAIMsg(resp.text);
      this.addEntry('AI Interviewer', resp.text, STAGE_LABELS[this.stage]);

      this.setStatus('speaking');
      VoiceManager.speak(resp.text, () => {
        this.s.isProcessing = false;
        if (this.s.quitting) return;
        // WRAP_UP is the last stage — end after this one reply regardless of
        // whether the model remembered to emit [STAGE_COMPLETE], so the
        // interview can't loop forever waiting for a token that never comes.
        if (resp.stageComplete || this.stage === 'WRAP_UP') { this.advanceStage(); }
        else { this.startListening(); }
      });
    } catch (e) {
      this.s.isProcessing = false;
      if (!this.s.quitting) this.handleErr(e);
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
      stage:        this.stage,
      teacherName:  this.s.teacherName,
      subject:      this.s.subject,
      resumeSummary: this.s.resumeSummary
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
      if (this.s.quitting) return;
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
    this._setDictateBtnLabel(false);

    const btn = document.getElementById('submit-solution-btn');
    btn.disabled = false;
    btn.innerHTML = SUBMIT_BTN_MARKUP;

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
      this._setDictateBtnLabel(false);
      return;
    }

    this.s.dictating = true;
    btn.classList.add('active');
    this._setDictateBtnLabel(true);
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
        this._setDictateBtnLabel(false);
        if (!this.s.dictatedText) panel.classList.add('hidden');
        this.showToast('Could not access microphone for dictation.', 'error');
      }
    );
  },

  _setDictateBtnLabel(active) {
    const btn = document.getElementById('dictate-btn');
    if (!btn) return;
    btn.innerHTML = active
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg> Stop Speaking'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/></svg> No pen? Speak your solution';
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
      if (this.s.quitting) return; // candidate quit while evaluation was in flight
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
        if (this.s.quitting) return;
        if (!ev.followUpQuestion) {
          this.startListening(); return;
        }
        setTimeout(() => {
          if (this.s.quitting) return;
          this.renderAIMsg(ev.followUpQuestion);
          this.addEntry('AI Interviewer', ev.followUpQuestion, 'Solution Evaluation');
          this.s.history.push({ role: 'model', parts: [{ text: ev.followUpQuestion }] });
          VoiceManager.speak(ev.followUpQuestion, () => {
            if (this.s.quitting) return;
            this.startListening();
          });
        }, 700);
      });

    } catch (e) {
      btn.disabled  = false;
      btn.innerHTML = SUBMIT_BTN_MARKUP;
      if (!this.s.quitting) this.handleErr(e);
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
    this.s.lastRecognizedText = '';
    // Initial grace period: the candidate hasn't said anything yet.
    this.armSilenceTimer(SILENCE_TIMEOUT_MS);

    VoiceManager.listen(
      text => {
        this.s.lastRecognizedText = text;
        const el = document.getElementById('status-text');
        if (el) el.textContent = `"${text}"`;
        // They've started answering — from now on only a genuine pause
        // (not the full initial grace period) should end their turn.
        this.armSilenceTimer(PAUSE_TIMEOUT_MS);
      },
      err => {
        this.clearSilenceTimer();
        console.warn('Voice error:', err);
        this.setStatus('idle');
        this.setMic(true);
      }
    );
  },

  armSilenceTimer(timeoutMs) {
    this.clearSilenceTimer();
    this.s.silenceTimer = setTimeout(() => {
      if (!VoiceManager.isListening) return;
      VoiceManager.stopListening();
      const text = (this.s.lastRecognizedText || '').trim();
      if (text) {
        this.setStatus('thinking');
        this.handleAnswer(text);
      } else {
        this.handleSilence();
      }
    }, timeoutMs);
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
      if (this.s.quitting) { this.s.isProcessing = false; return; }

      this.renderAIMsg(resp.text);
      this.addEntry('AI Interviewer', resp.text, STAGE_LABELS[this.stage]);

      this.setStatus('speaking');
      VoiceManager.speak(resp.text, () => {
        this.s.isProcessing = false;
        if (this.s.quitting) return;
        // Same end-of-interview safeguard as handleAnswer — don't keep
        // re-prompting a silent candidate through further WRAP_UP rounds.
        if (resp.stageComplete || this.stage === 'WRAP_UP') { this.advanceStage(); }
        else { this.startListening(); }
      });
    } catch (e) {
      this.s.isProcessing = false;
      if (!this.s.quitting) this.handleErr(e);
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
