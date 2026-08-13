/**
 * App — main interview state machine.
 * Depends on: VoiceManager, ReportManager, getRandomQuestions (questions.js)
 */

// ─── Stage Configuration ──────────────────────────────────────────────────────
// WRAP_UP is reached only as a closing announcement from _concludeProblemSolving()
// — once all PROBLEM_SOLVE_QUESTION_COUNT whiteboard rounds are done, the
// interview concludes immediately with no further question of any kind.
const STAGES = [
  'WELLBEING',
  'RESUME_QA',
  'PROBLEM_SOLVE',
  'WRAP_UP'
];

const STAGE_LABELS = {
  WELLBEING:     'Well-being Check',
  RESUME_QA:     'Interview Questions',
  PROBLEM_SOLVE: 'Problem Solving',
  WRAP_UP:       'Wrap Up'
};

// Number of resume-based questions asked one-by-one during RESUME_QA, before
// moving on to the whiteboard problem-solving question: 5 general questions
// plus a 6th always about institutes worked at before the current role and
// any ranks/toppers produced there (see /api/generate-questions). This is a
// hard safety cap on top of the server's own count.
const MAX_RESUME_QUESTIONS = 6;

// Fixed opening line for the one stage that still runs a free-flowing LLM chat.
// RESUME_QA and PROBLEM_SOLVE have their own dedicated flows (see
// beginResumeQA/launchProblemSolving), and WRAP_UP is a scripted closing
// announcement from submitSolution() with no reply expected.
const STAGE_OPENERS = {
  WELLBEING: (name) => `Hi ${name}, welcome to your interview with Vedantu! Before we get started, how are you feeling today?`,
};

const SUBMIT_BTN_MARKUP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg> Submit Solution';

// ─── Whiteboard Timer ─────────────────────────────────────────────────────────
const SOLVE_SECONDS = 90;

// Number of distinct problem-solving (whiteboard) questions asked during
// PROBLEM_SOLVE, each with its own 90-second timer and a spoken follow-up
// question about the candidate's approach once they submit.
const PROBLEM_SOLVE_QUESTION_COUNT = 3;

// If the candidate stays silent this long after the AI asks a (non-whiteboard)
// question — i.e. hasn't started speaking at all — treat it as no-answer and
// move on rather than waiting forever.
const SILENCE_TIMEOUT_MS = 10000;

// Once the candidate HAS started speaking, a shorter pause is enough to
// consider their answer complete (they don't need another full 10s grace
// period every time they take a breath mid-sentence).
const PAUSE_TIMEOUT_MS = 3000;

// If that happens this many times in a row, end the interview early instead
// of continuing to prompt an interviewee who isn't responding.
const MAX_CONSECUTIVE_SILENCES = 5;

// A candidate gets up to this many polite warnings for abusive/triggering
// messages (detected server-side, see /api/check-conduct and /api/chat) before
// the next flagged message ends the interview outright. Purely a label for
// warning-count messages here — the actual threshold logic lives server-side
// in server.js's checkConduct/MAX_CONDUCT_WARNINGS, which this must match.
const MAX_CONDUCT_WARNINGS = 2;

// ─── Camera (engagement snapshots) ────────────────────────────────────────────
// How often a webcam frame is grabbed and sent for a brief engagement/attentiveness
// note — kept infrequent since this is a lightweight qualitative aid for the admin
// report, not a continuous recording or real-time emotion-detection system.
const CAMERA_CAPTURE_INTERVAL_MS = 30000;

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
    problemQuestions: null,   // array of PROBLEM_SOLVE_QUESTION_COUNT distinct whiteboard questions for this subject
    problemRoundIndex: 0,     // index into problemQuestions of the round currently being solved
    problemScores: [],        // score (0-10) from each round, averaged into problemScore for the report
    awaitingProblemFollowUp: false, // true while listening for the answer to a problem-solving follow-up question
    problemScore:  0,
    isProcessing:  false,
    startDate:     '',
    dictating:     false,
    dictatedText:  '',
    silenceTimer:  null,
    lastRecognizedText: '',
    consecutiveSilences: 0,
    misconductCount: 0,       // number of conduct warnings issued so far this interview
    endedForMisconduct: false, // true only if the interview was actually terminated for conduct —
                                // a candidate who was warned but behaved afterward is NOT flagged
    quitting:      false,
    resumeAnalyzing: false,
    resumeAnalyzed:  false,
    resumeSummary:   null, // summaryText string sent to the AI as resume context
    resumeInfo:      null, // structured { name, yearsExperience, ... } for the confirmation card
    resumeQuestions: null, // array of up to MAX_RESUME_QUESTIONS pre-generated questions
    resumeQIndex:    0,    // index into resumeQuestions of the question currently being asked
    cameraEnabled:   false,
    cameraStream:    null, // active MediaStream from getUserMedia, released once the interview ends
    cameraCaptureIntervalId: null
  },

  // The AI bubble currently being revealed word-by-word in sync with speech:
  // { spans, revealed } or null (see renderAIMsg/_revealSpokenWords).
  _live: null,

  get stage() { return STAGES[this.s.stageIndex]; },

  // iPadOS reports as "MacIntel" with touch points (no more "iPad" in its UA
  // by default), so both checks are needed to catch every iOS/iPadOS device.
  _isIOSDevice() {
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  },

  // ── Setup ──────────────────────────────────────────────────────────────────
  async startInterview() {
    // Must run synchronously in this click handler, before any `await` below —
    // iOS Safari only unlocks audio playback for the rest of the page when the
    // unlocking call happens in the same task as the user gesture that
    // triggered it (see VoiceManager.unlockAudio's own comment for why).
    VoiceManager.unlockAudio();

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

    // Recognition listens in whichever language the candidate picked; the AI
    // always speaks back in Indian English (VoiceManager.speak forces this
    // independent of recognition language — see voice.js). init() also asks
    // the server whether the Sarvam voice engines are available. Checked
    // before requesting camera access so an unsupported browser fails fast
    // without prompting for a permission that would go unused anyway.
    const { supported } = await VoiceManager.init(spokenLang);
    if (!supported) {
      // "Switch to Chrome or Edge" is impossible on iOS — every browser there
      // (including ones named Chrome/Edge) is Safari/WebKit underneath and
      // has no speech recognition at all. This path is only reachable when
      // the server has no Sarvam key configured, in which case iOS genuinely
      // cannot run the interview at all — say so plainly instead.
      const msgEl = document.getElementById('browser-warning-text');
      if (msgEl) {
        msgEl.textContent = this._isIOSDevice()
          ? 'Voice features aren’t available in any browser on iPhone/iPad. Please use a desktop or laptop computer with Google Chrome or Microsoft Edge instead.'
          : 'Voice features require Google Chrome or Microsoft Edge. Please switch browsers and reload.';
      }
      document.getElementById('browser-warning').classList.remove('hidden');
      return;
    }

    // Reveal each AI bubble's words in sync with the spoken audio.
    VoiceManager.setProgressHook(n => this._revealSpokenWords(n));

    const startBtn = document.getElementById('start-btn');
    const startBtnOriginalHTML = startBtn.innerHTML;

    if (!this.s.cameraEnabled) {
      startBtn.disabled = true;
      startBtn.textContent = 'Waiting for camera permission…';
      const granted = await this._requestCameraAccess();
      if (!granted) {
        startBtn.disabled = false;
        startBtn.innerHTML = startBtnOriginalHTML;
        this.showToast('Camera access is required to start the interview. Please allow camera permission and try again.', 'warn');
        return;
      }
    }

    this.s.teacherName = name;
    this.s.subject     = subject;
    this.s.spokenLang  = spokenLang;
    this.s.startDate   = new Date().toLocaleString('en-IN');

    startBtn.disabled = true;
    startBtn.textContent = 'Initialising…';

    // Start synthesizing the opening line now, while voices load and the
    // recorder spins up — by the time beginStage() speaks it, the audio is
    // usually already cached and playback starts instantly.
    const wellbeingOpener = STAGE_OPENERS.WELLBEING && STAGE_OPENERS.WELLBEING(name);
    if (wellbeingOpener) VoiceManager.prefetch(wellbeingOpener);

    await VoiceManager.loadVoice();
    // With Sarvam TTS active the spoken voice is always Indian (Bulbul), so
    // the browser-voice nudge only applies in browser-fallback mode.
    if (!VoiceManager.usesSarvamTTS && !VoiceManager.isIndianVoice) {
      // Best-effort only: no Indian-English voice was found on this browser/OS,
      // so names and Indian-context words will come out in a generic accent.
      // Nudge toward Edge, which ships a genuine Indian neural voice (Neerja)
      // by default — this doesn't block starting the interview either way.
      this.showToast('No Indian-English voice detected — try Microsoft Edge for authentic pronunciation.', 'info');
    }
    Whiteboard.init('wb-canvas', 'wb-canvas-wrap');
    this._startCameraCapture();

    // Record the full interview (camera video + mic audio), streamed to the
    // server in chunks as it happens. Requested here, still within the "Begin
    // Interview" click's permission context. Best-effort: a denied mic or
    // unsupported browser just means no recording — never a blocked interview.
    await Recorder.start(this.s.cameraStream);

    this.showScreen('interview');
    this.updateStageUI();
    await this.beginStage();
  },

  // ── Camera Access (periodic engagement snapshots) ─────────────────────────
  // Permission is requested here — triggered directly by the "Begin Interview"
  // click, a user gesture — which surfaces the browser's own native camera
  // permission prompt rather than any custom UI.
  async _requestCameraAccess() {
    try {
      // facingMode:'user' asks for the selfie camera specifically — phones/
      // tablets have a rear camera too, and without this the browser/OS choice
      // of default camera is inconsistent (especially on Android), which
      // would capture the wrong thing for both the recording and the periodic
      // engagement snapshots. 'ideal' (not 'exact') so a device that can't
      // honor it still returns whatever camera it has instead of failing.
      // width/height likewise as 'ideal' — phone front cameras are natively
      // widescreen and forcing 320×240 (4:3) would crop/zoom the picture
      // farther than a plain "prefer roughly this size" request.
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'user' }, width: { ideal: 320 }, height: { ideal: 240 } },
        audio: false
      });
      this.s.cameraStream  = stream;
      this.s.cameraEnabled = true;
      const video = document.getElementById('camera-preview-video');
      if (video) video.srcObject = stream;
      return true;
    } catch (e) {
      console.warn('Camera access error:', e);
      this.s.cameraEnabled = false;
      return false;
    }
  },

  // Grabs the current webcam frame as a JPEG data URL, or null if the camera
  // isn't ready yet (e.g. the very first tick before video metadata loads).
  _captureCameraFrame() {
    const video  = document.getElementById('camera-preview-video');
    const canvas = document.getElementById('camera-capture-canvas');
    if (!video || !canvas || !this.s.cameraStream || video.readyState < 2) return null;
    canvas.width  = video.videoWidth  || 320;
    canvas.height = video.videoHeight || 240;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.7);
  },

  _startCameraCapture() {
    this._stopCameraCapture();
    if (!this.s.cameraEnabled) return;
    this.s.cameraCaptureIntervalId = setInterval(() => this._analyzeCameraFrame(), CAMERA_CAPTURE_INTERVAL_MS);
  },

  _stopCameraCapture() {
    if (this.s.cameraCaptureIntervalId) {
      clearInterval(this.s.cameraCaptureIntervalId);
      this.s.cameraCaptureIntervalId = null;
    }
  },

  // Turns the camera light off once the interview ends — no reason to keep
  // capturing after the last snapshot is logged.
  _releaseCameraStream() {
    if (this.s.cameraStream) {
      this.s.cameraStream.getTracks().forEach(t => t.stop());
      this.s.cameraStream = null;
    }
  },

  // Fire-and-forget: a failed or slow snapshot analysis should never disrupt
  // the interview, so errors are swallowed (logged only) rather than surfaced.
  async _analyzeCameraFrame() {
    if (this.s.quitting) return;
    const imageBase64 = this._captureCameraFrame();
    if (!imageBase64) return;

    const stageLabel = STAGE_LABELS[this.stage] || this.stage;
    try {
      const res = await fetch('/api/analyze-expression', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64, stageLabel })
      });
      const data = await res.json();
      if (!res.ok || !data.success || this.s.quitting) return;
      this.addEntry('Camera Analysis (internal — not shown to candidate)', data.notes, stageLabel);
    } catch (e) {
      console.warn('Camera analysis error:', e);
    }
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

    if (stage === 'RESUME_QA') {
      await this.beginResumeQA();
      return;
    }

    // WELLBEING/WRAP_UP openers are fixed, canned lines rather than LLM-generated —
    // an LLM call here would receive only a bracketed meta-instruction with no real
    // candidate message to respond to, and models can unreliably echo that
    // instruction back as prose instead of just speaking the actual line (the exact
    // failure this replaced). The candidate's actual reply to this line still goes
    // through the normal LLM chat in handleAnswer.
    const openerFn = STAGE_OPENERS[stage];
    const openerText = openerFn ? openerFn(this.s.teacherName) : null;
    if (!openerText) { await this.advanceStage(); return; }

    this.renderAIMsg(openerText);
    this.addEntry('AI Interviewer', openerText, STAGE_LABELS[stage]);
    // Keep the model's chat history in sync so its next reply has context for
    // what was already said, even though this line wasn't itself LLM-generated.
    // Gemini's chat API requires history to start with a 'user' turn, so seed a
    // minimal synthetic one ahead of it — it's never rendered or spoken, just
    // context for the API call.
    this.s.history.push({ role: 'user', parts: [{ text: `(Interview stage begins: ${stage})` }] });
    this.s.history.push({ role: 'model', parts: [{ text: openerText }] });

    this.setStatus('speaking');
    VoiceManager.speak(openerText, () => {
      if (this.s.quitting) return;
      this.startListening();
    });
  },

  // ── Resume Q&A (exactly-once, no follow-ups) ───────────────────────────────
  // Fetches (once) the fixed set of 6 resume-aware questions and asks them
  // strictly one at a time — no LLM follow-ups, no re-probing. This is what
  // keeps the interview to a bounded question count instead of the open-ended
  // [STAGE_COMPLETE]-driven chat used by WELLBEING/WRAP_UP. The 6th question
  // is always about institutes worked at before the current role and any
  // ranks/toppers produced there (see /api/generate-questions).
  async beginResumeQA() {
    this.setStatus('thinking');
    try {
      if (!this.s.resumeQuestions) {
        const res = await fetch('/api/generate-questions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            resumeSummary: this.s.resumeSummary,
            resumeInfo:    this.s.resumeInfo,
            subject:       this.s.subject,
            teacherName:   this.s.teacherName
          })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Could not prepare interview questions');
        this.s.resumeQuestions = data.questions.slice(0, MAX_RESUME_QUESTIONS);
        // All questions are known now — synthesize them ahead of time so each
        // one starts speaking instantly when its turn comes.
        this.s.resumeQuestions.forEach(q => VoiceManager.prefetch(q));
      }
      if (this.s.quitting) return;
      this.s.resumeQIndex = 0;
      await this.askResumeQuestion();
    } catch (e) { if (!this.s.quitting) this.handleErr(e); }
  },

  async askResumeQuestion() {
    if (this.s.quitting) return;
    const q = this.s.resumeQuestions[this.s.resumeQIndex];
    const label = `Question ${this.s.resumeQIndex + 1} of ${this.s.resumeQuestions.length}`;

    this.renderAIMsg(q);
    this.addEntry('AI Interviewer', q, label);

    this.setStatus('speaking');
    VoiceManager.speak(q, () => {
      if (this.s.quitting) return;
      this.startListening();
    });
  },

  // Moves to the next of the 5 questions, or on to PROBLEM_SOLVE once all
  // have been asked (regardless of answer quality — no follow-ups here).
  async advanceResumeQuestion() {
    if (this.s.quitting) return;
    this.s.resumeQIndex++;
    if (this.s.resumeQIndex >= this.s.resumeQuestions.length) {
      await this.advanceStage();
    } else {
      await this.askResumeQuestion();
    }
  },

  async handleAnswer(text) {
    if (this.s.isProcessing || !text.trim()) return;
    this.s.isProcessing = true;
    this.setMic(false);
    this.s.consecutiveSilences = 0; // a real answer came in, regardless of entry point — reset the streak

    if (this.s.awaitingProblemFollowUp) {
      this.s.awaitingProblemFollowUp = false;
      return this._handleProblemFollowUpAnswer(text);
    }

    const label = this.stage === 'RESUME_QA'
      ? `Question ${this.s.resumeQIndex + 1} of ${this.s.resumeQuestions.length}`
      : STAGE_LABELS[this.stage];
    this.renderUserMsg(text);
    this.addEntry('Teacher', text, label);

    if (this.stage === 'RESUME_QA') {
      // RESUME_QA doesn't call /api/chat (its questions are pre-generated and
      // asked deterministically), so it needs its own conduct check — /api/chat's
      // built-in check never runs for this stage otherwise.
      this.setStatus('thinking');
      try {
        const conduct = await this._checkConduct(text);
        if (this.s.quitting) { this.s.isProcessing = false; return; }
        if (await this._handleConductResult(conduct, label)) return;

        // React to what they actually said (e.g. empathetic if they say they
        // haven't achieved something, warm if they have) rather than silently
        // jumping to the next question — a flat, disconnected transition would
        // make the candidate feel unheard.
        const askedQuestion = this.s.resumeQuestions[this.s.resumeQIndex];
        const ack = await this._getAcknowledgment(askedQuestion, text);
        if (this.s.quitting) { this.s.isProcessing = false; return; }

        this.renderAIMsg(ack);
        this.addEntry('AI Interviewer', ack, label);

        this.setStatus('speaking');
        VoiceManager.speak(ack, () => {
          this.s.isProcessing = false;
          if (this.s.quitting) return;
          setTimeout(() => { if (!this.s.quitting) this.advanceResumeQuestion(); }, 500);
        });
      } catch (e) {
        this.s.isProcessing = false;
        if (!this.s.quitting) this.handleErr(e);
      }
      return;
    }

    this.setStatus('thinking');

    try {
      const resp = await this.callChat(text, /*hidden*/ false);
      if (this.s.quitting) { this.s.isProcessing = false; return; }

      // The 3rd flagged offense ends the interview outright — handled
      // separately below, since it doesn't continue the normal Q&A flow.
      if (resp.misconductEnd) {
        this.s.isProcessing = false;
        this.s.misconductCount++;
        this.addEntry('Conduct Flag (internal — not shown to candidate)', `Flagged message ended the interview: "${text}"`, label);
        await this.endInterviewForMisconduct(resp.text);
        return;
      }
      if (resp.misconductWarning) {
        this.s.misconductCount++;
        this.addEntry('Conduct Flag (internal — not shown to candidate)', `Flagged message, warning ${this.s.misconductCount} of ${MAX_CONDUCT_WARNINGS}: "${text}"`, label);
      }

      this.renderAIMsg(resp.text);
      this.addEntry('AI Interviewer', resp.text, STAGE_LABELS[this.stage]);

      this.setStatus('speaking');
      VoiceManager.speak(resp.text, () => {
        this.s.isProcessing = false;
        if (this.s.quitting) return;
        if (resp.stageComplete) { this.advanceStage(); }
        else { this.startListening(); }
      });
    } catch (e) {
      this.s.isProcessing = false;
      if (!this.s.quitting) this.handleErr(e);
    }
  },

  // ── Conduct Monitoring ─────────────────────────────────────────────────────
  async _checkConduct(text) {
    const res = await fetch('/api/check-conduct', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userMessage: text, teacherName: this.s.teacherName, misconductCount: this.s.misconductCount })
    });
    if (!res.ok) throw new Error('Conduct check failed');
    return res.json();
  },

  // Returns true if the turn was consumed by a conduct warning or interview-
  // ending response (caller should stop rather than continue the normal flow);
  // false if the answer was clean.
  async _handleConductResult(conduct, label) {
    if (!conduct.flagged) return false;

    this.s.misconductCount++;

    if (conduct.misconductEnd) {
      this.s.isProcessing = false;
      this.addEntry('Conduct Flag (internal — not shown to candidate)', `Flagged message ended the interview during "${label}"`, label);
      await this.endInterviewForMisconduct(conduct.text);
      return true;
    }

    this.addEntry('Conduct Flag (internal — not shown to candidate)', `Flagged message during "${label}", warning ${this.s.misconductCount} of ${MAX_CONDUCT_WARNINGS}`, label);
    this.renderAIMsg(conduct.text);
    this.addEntry('AI Interviewer', conduct.text, label);

    this.setStatus('speaking');
    VoiceManager.speak(conduct.text, () => {
      this.s.isProcessing = false;
      if (this.s.quitting) return;
      this.startListening(); // give them another chance to answer the same question properly
    });
    return true;
  },

  // Fetches a short, tone-matched reaction to a RESUME_QA answer (e.g.
  // empathetic if they say they haven't achieved something) — never throws,
  // since a flat/wrong tone is a UX quality issue, not something that should
  // ever block the interview from moving to the next question.
  async _getAcknowledgment(question, answer) {
    try {
      const res = await fetch('/api/acknowledge-answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, answer, teacherName: this.s.teacherName })
      });
      const data = await res.json();
      return (data && data.text) || 'Thank you for sharing that.';
    } catch (e) {
      console.warn('Acknowledgment error:', e);
      return 'Thank you for sharing that.';
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
      resumeSummary: this.s.resumeSummary,
      misconductCount: this.s.misconductCount
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

    return data; // { text, stageComplete, misconductWarning, misconductEnd }
  },

  // ── Problem Solving (Whiteboard) ───────────────────────────────────────────
  async launchProblemSolving() {
    this.clearSilenceTimer(); // whiteboard uses its own 90s Timer, not this
    // Spoken after every solution submission — warm it once up front.
    VoiceManager.prefetch('Thank you for sharing your approach.');
    this.s.problemQuestions   = await this._fetchProblemQuestions(this.s.subject, PROBLEM_SOLVE_QUESTION_COUNT);
    this.s.problemRoundIndex  = 0;
    this.s.problemScores      = [];

    const total = this.s.problemQuestions.length;
    // Deliberately tone-neutral (not "Wonderful!") — this fixed line always
    // fires right after the RESUME_QA acknowledgment, whose tone depends on
    // what the candidate just said, so an unconditionally upbeat opener here
    // could clash with e.g. an empathetic reaction to a disappointing answer.
    // Numericals/derivations are graded on the whole approach, so warn the
    // candidate up front that bare answers won't score well on those.
    const anyWork = this.s.problemQuestions.some(q => q.requiresWork);
    const announcement = `Alright, we've had a good conversation. I'd now like to see your ${this.s.subject} problem-solving approach across ${total} questions. You'll have 90 seconds for each — write with a pen or stylus, or speak your solution if you don't have one, and I'll follow up on your approach after each one.${anyWork ? ' Where a question needs a full solution, do show your complete step-by-step working — your method matters as much as the final answer.' : ''}`;

    this.renderAIMsg(announcement);
    this.addEntry('AI Interviewer', announcement, 'Problem Solving');
    this.setStatus('speaking');

    VoiceManager.speak(announcement, () => {
      if (this.s.quitting) return;
      this.startProblemRound();
    });
  },

  // Pulls this subject's whiteboard questions from the server's bank of real
  // JEE/NEET exam questions (/api/problem-questions). Falls back to the small
  // built-in QUESTIONS_DB (questions.js) when the subject isn't covered by the
  // bank (Computer Science, English) or the request fails — starting the
  // problem-solving stage must never be blocked on this.
  async _fetchProblemQuestions(subject, count) {
    try {
      const res = await fetch(`/api/problem-questions?subject=${encodeURIComponent(subject)}&count=${count}`);
      if (!res.ok) throw new Error('bank returned ' + res.status);
      const data = await res.json();
      if (!Array.isArray(data.questions) || !data.questions.length) throw new Error('empty bank response');
      return data.questions;
    } catch (e) {
      console.warn('Question bank unavailable, using built-in questions:', e.message);
      return getRandomQuestions(subject, count);
    }
  },

  startProblemRound() {
    if (this.s.quitting) return;
    const q = this.s.problemQuestions[this.s.problemRoundIndex];
    this.s.currentQuestion = q;
    this.showScreen('problem');
    this.renderProblem(q);
  },

  // Typesets any LaTeX in the element ($…$, $$…$$, \(…\), \[…\]) via KaTeX's
  // auto-render — bank questions from the JEE/NEET dumps are full of it.
  // No-ops harmlessly for plain-text questions or if the CDN script failed.
  _renderMath(el) {
    if (!el || typeof window.renderMathInElement !== 'function') return;
    try {
      window.renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false }
        ],
        throwOnError: false
      });
    } catch (e) {
      console.warn('KaTeX render failed:', e);
    }
  },

  renderProblem(q) {
    const qText = document.getElementById('q-text');
    qText.innerHTML = q.question.replace(/\n/g, '<br>');
    this._renderMath(qText);
    document.getElementById('q-topic').textContent   = q.topic;
    document.getElementById('q-diff').textContent    = q.difficulty;
    document.getElementById('q-subj').textContent    = `${q.subject} · Q${this.s.problemRoundIndex + 1}/${this.s.problemQuestions.length}`;
    document.getElementById('q-diagram-tag').classList.toggle('hidden', !q.hasDiagram);
    document.getElementById('q-work-tag').classList.toggle('hidden', !q.requiresWork);

    // The diagram is part of the question itself (given, to be interpreted) —
    // not something the candidate is asked to draw as their answer.
    const diagramContainer = document.getElementById('q-diagram-container');
    if (q.hasDiagram && q.diagramSvg) {
      diagramContainer.innerHTML = q.diagramSvg;
      diagramContainer.classList.remove('hidden');
    } else {
      diagramContainer.innerHTML = '';
      diagramContainer.classList.add('hidden');
    }

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
      this.s.dictating = false;
      document.getElementById('dictate-btn').classList.remove('active');
      // Sarvam engine: resolves once the final dictated segment has been
      // transcribed, so s.dictatedText is complete before it's read below.
      // Immediate for the browser engine.
      await VoiceManager.stopDictation();
    } else {
      // Dictation may have been stopped manually a moment ago with its last
      // segment still transcribing — wait for that text to land too.
      await VoiceManager.waitForDictation();
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
          dictatedText: dictatedText || null,
          // Grounding truth for diagram-based questions — the evaluator never
          // sees the diagram image itself, so this fills in what it needs to
          // check correctness (e.g. what each labelled part actually is).
          evalContext: this.s.currentQuestion.evalContext || null,
          // Numericals/derivations: the evaluator grades the full step-by-step
          // approach (method, setup, steps, units), not just the final answer.
          requiresWork: !!this.s.currentQuestion.requiresWork
        })
      });
      const ev = await res.json();
      if (this.s.quitting) return; // candidate quit while evaluation was in flight
      this.s.problemScores.push(ev.score ?? 5);
      // Kept as a single number for backward compatibility with the report
      // payload — the average across all rounds so far.
      this.s.problemScore = Math.round(this.s.problemScores.reduce((a, b) => a + b, 0) / this.s.problemScores.length);

      const roundLabel = `Problem Solving (Q${this.s.problemRoundIndex + 1}/${this.s.problemQuestions.length})`;

      // Log solution in transcript
      const summary = [
        hasDrawing ? '[Handwritten solution submitted on whiteboard]' : null,
        dictatedText ? `Dictated: ${dictatedText}` : null,
        (!hasDrawing && !dictatedText) ? '[No solution submitted — time expired]' : null
      ].filter(Boolean).join(' | ');
      this.addEntry('Teacher (Solution)', summary, roundLabel);

      // The correctness verdict/feedback is for the admin report only — like the
      // final report itself, it's never shown or spoken to the candidate. Log it
      // to the transcript for review only.
      this.addEntry('AI Interviewer (internal evaluation — not shown to candidate)', `${ev.workShown ? `Working shown: ${ev.workShown} | ` : ''}${ev.evaluation} ${ev.feedback}`, roundLabel);

      this.showScreen('interview');
      this.updateStageUI();

      const ackText = 'Thank you for sharing your approach.';
      this.renderAIMsg(ackText);
      this.addEntry('AI Interviewer', ackText, roundLabel);
      this.s.history.push({ role: 'user', parts: [{ text: '(Interview stage begins: EVALUATION)' }] });
      this.s.history.push({ role: 'model', parts: [{ text: ackText }] });

      this.setStatus('speaking');
      VoiceManager.speak(ackText, () => {
        if (this.s.quitting) return;
        if (ev.followUpQuestion) {
          setTimeout(() => { if (!this.s.quitting) this._askProblemFollowUp(ev.followUpQuestion, roundLabel); }, 700);
        } else {
          this._advanceProblemRound();
        }
      });

    } catch (e) {
      btn.disabled  = false;
      btn.innerHTML = SUBMIT_BTN_MARKUP;
      if (!this.s.quitting) this.handleErr(e);
    }
  },

  // Speaks a probing question about the candidate's reasoning/approach on the
  // solution they just submitted (e.g. "why did you use X approach here"),
  // then listens for their answer — this never reveals correctness, only asks
  // about their thinking, so it's safe to speak aloud unlike the evaluation itself.
  _askProblemFollowUp(question, roundLabel) {
    if (this.s.quitting) return;
    this.renderAIMsg(question);
    this.addEntry('AI Interviewer', question, roundLabel);
    this.s.history.push({ role: 'model', parts: [{ text: question }] });

    this.setStatus('speaking');
    this.s.awaitingProblemFollowUp = true;
    VoiceManager.speak(question, () => {
      if (this.s.quitting) return;
      this.startListening();
    });
  },

  // Handles the candidate's spoken answer to a problem-solving follow-up
  // question — still conduct-checked like every other answer, then moves on
  // to the next round (or concludes if that was the last one). Dispatched from
  // handleAnswer() via the awaitingProblemFollowUp flag rather than by stage,
  // since PROBLEM_SOLVE doesn't otherwise drive conversational turns.
  async _handleProblemFollowUpAnswer(text) {
    const roundLabel = `Problem Solving Follow-up (Q${this.s.problemRoundIndex + 1}/${this.s.problemQuestions.length})`;
    this.renderUserMsg(text);
    this.addEntry('Teacher', text, roundLabel);

    this.setStatus('thinking');
    try {
      const conduct = await this._checkConduct(text);
      if (this.s.quitting) { this.s.isProcessing = false; return; }
      // If flagged-but-warned, _handleConductResult below re-arms startListening()
      // for a retry — that retry answer must come back here too, not fall through
      // to RESUME_QA/WELLBEING handling.
      if (conduct.flagged && !conduct.misconductEnd) this.s.awaitingProblemFollowUp = true;
      if (await this._handleConductResult(conduct, roundLabel)) return;

      this.s.isProcessing = false;
      await this._advanceProblemRound();
    } catch (e) {
      this.s.isProcessing = false;
      if (!this.s.quitting) this.handleErr(e);
    }
  },

  // Moves to the next problem-solving question, or concludes the interview
  // once all PROBLEM_SOLVE_QUESTION_COUNT rounds are done.
  async _advanceProblemRound() {
    if (this.s.quitting) return;
    this.s.problemRoundIndex++;
    if (this.s.problemRoundIndex >= this.s.problemQuestions.length) {
      await this._concludeProblemSolving();
    } else {
      this.startProblemRound();
    }
  },

  // All problem-solving rounds are done — the interview concludes immediately
  // with a short closing statement, no further question of any kind.
  async _concludeProblemSolving() {
    if (this.s.quitting) return;
    this.s.stageIndex = STAGES.indexOf('WRAP_UP');
    this.showScreen('interview');
    this.updateStageUI();

    const closing = `Thank you for interviewing with Vedantu, ${this.s.teacherName}. We'll get back to you with a follow-up soon.`;
    this.renderAIMsg(closing);
    this.addEntry('AI Interviewer', closing, 'Wrap Up');

    this.setStatus('speaking');
    VoiceManager.speak(closing, () => {
      if (this.s.quitting) return;
      this.generateReport();
    });
  },

  // ── Report ─────────────────────────────────────────────────────────────────
  // The evaluation report is generated and stored on the server only — it is
  // never sent back to or rendered in the candidate's browser. The candidate
  // just sees a thank-you screen; results are reviewed later via /admin.
  async generateReport() {
    this._stopCameraCapture();
    this.showScreen('loading');

    // Stop the recording and wait for its final chunk to reach the server
    // BEFORE releasing the camera stream (stopping the tracks would cut the
    // recorder off mid-chunk). Returns null if recording never ran or failed.
    const recordingId = await Recorder.stop().catch(() => null);
    this._releaseCameraStream();
    VoiceManager.releaseMic(); // the STT capture stream, separate from the recorder's

    try {
      const res = await fetch('/api/report', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript:      ReportManager.getPlainTranscript(),
          teacherName:     this.s.teacherName,
          subject:         this.s.subject,
          problemScore:    this.s.problemScore,
          misconductCount: this.s.misconductCount,
          endedForMisconduct: this.s.endedForMisconduct,
          recordingId // links the report to data/recordings/<id>.webm (or null)
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
      update => {
        // update.text is the live transcript so far — from the browser engine
        // directly, or from the parallel live-preview recognizer in Sarvam
        // mode (display only; the answer submitted is Sarvam's transcript).
        // It's null on plain voice-activity pings (Sarvam without Web Speech).
        if (update && typeof update.text === 'string') {
          this.s.lastRecognizedText = update.text;
          const el = document.getElementById('status-text');
          if (el) el.textContent = `"${update.text}"`;
        }
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
    this.s.silenceTimer = setTimeout(async () => {
      if (!VoiceManager.isListening) return;
      // finishListening() stops capture and returns the final transcript —
      // immediate for the browser engine, a short server round-trip while the
      // audio is transcribed for Sarvam (hence 'thinking' before awaiting).
      this.setStatus('thinking');
      let text = '';
      try {
        text = ((await VoiceManager.finishListening()) || '').trim();
      } catch (e) {
        console.warn('Transcription error:', e);
      }
      if (this.s.quitting) return;
      if (text) {
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

    const label = this.s.awaitingProblemFollowUp
      ? `Problem Solving Follow-up (Q${this.s.problemRoundIndex + 1}/${this.s.problemQuestions.length})`
      : this.stage === 'RESUME_QA'
        ? `Question ${this.s.resumeQIndex + 1} of ${this.s.resumeQuestions.length}`
        : STAGE_LABELS[this.stage];
    this.addEntry('Teacher', '[No response — moved on after 10s of silence]', label);

    this.s.consecutiveSilences++;
    if (this.s.consecutiveSilences >= MAX_CONSECUTIVE_SILENCES) {
      this.s.isProcessing = false;
      await this.endInterviewEarly();
      return;
    }

    if (this.s.awaitingProblemFollowUp) {
      this.s.awaitingProblemFollowUp = false;
      this.s.isProcessing = false;
      await this._advanceProblemRound();
      return;
    }

    if (this.stage === 'RESUME_QA') {
      this.s.isProcessing = false;
      await this.advanceResumeQuestion();
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
        if (resp.stageComplete) { this.advanceStage(); }
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

  // Called once a candidate's flagged message pushes them past MAX_CONDUCT_WARNINGS
  // (see checkConduct in server.js) — the candidate has already been warned that
  // many times and this offense ends the interview outright. Reuses the `quitting`
  // flag exactly like quitInterview()/endInterviewEarly() so any in-flight
  // chat/TTS callback from a prior turn is ignored rather than racing with the
  // report generation this triggers.
  async endInterviewForMisconduct(closingText) {
    this.s.quitting = true;
    this.s.endedForMisconduct = true; // only this — not a mere warning — gets flagged in the report
    this.clearSilenceTimer();

    this.renderAIMsg(closingText);
    this.addEntry('AI Interviewer', closingText, STAGE_LABELS[this.stage] || 'Wrap Up');

    this.setStatus('speaking');
    VoiceManager.speak(closingText, () => {
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

  // AI messages default to progressive: the bubble appears at full size but
  // with its words invisible, and each word is revealed as the voice actually
  // speaks it (driven by VoiceManager's progress hook). Pass progressive=false
  // for AI lines that are never spoken (e.g. the technical-error notice).
  renderAIMsg(text, progressive = true) {
    // A new AI bubble supersedes any still-revealing one.
    this._completeLiveBubble();
    const wrap = this._appendMsg('ai', text, progressive);
    if (progressive && wrap) {
      this._live = {
        spans: Array.from(wrap.querySelectorAll('.msg-text .w')),
        revealed: 0
      };
    }
  },

  renderUserMsg(text) {
    this._appendMsg('user', text);
  },

  // Reveals AI-bubble words up to `count` (Infinity = all) — fired by
  // VoiceManager as the audio reaches each word.
  _revealSpokenWords(count) {
    const live = this._live;
    if (!live) return;
    const upto = Math.min(count, live.spans.length);
    while (live.revealed < upto) {
      live.spans[live.revealed++].classList.remove('unspoken');
    }
    if (live.revealed >= live.spans.length) this._live = null;
  },

  _completeLiveBubble() {
    this._revealSpokenWords(Infinity);
    this._live = null;
  },

  _escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  _appendMsg(role, text, hideWords = false) {
    const box = document.getElementById('messages');
    if (!box) return null;

    // AI text is split into word spans so it can be revealed in sync with the
    // spoken audio; hidden words still occupy space, so the bubble keeps its
    // final size and nothing reflows as words appear.
    const msgHtml = role === 'ai'
      ? String(text).trim().split(/\s+/)
          .map(w => `<span class="w${hideWords ? ' unspoken' : ''}">${this._escapeHtml(w)}</span>`)
          .join(' ')
      : this._escapeHtml(text);

    const wrap = document.createElement('div');
    wrap.className = `msg-wrap ${role}`;
    wrap.innerHTML = `
      <div class="msg-avatar">${role === 'ai' ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/><path d="M9 8h.01M15 8h.01" stroke-width="2"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>'}</div>
      <div class="msg-bubble">
        <p class="msg-text">${msgHtml}</p>
      </div>
    `;
    box.appendChild(wrap);
    requestAnimationFrame(() => wrap.classList.add('visible'));
    wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return wrap;
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
    this.renderAIMsg('I apologise, there was a technical issue. Please try again.', /*progressive*/ false);
    this.showToast('Connection error — please check the server is running.', 'error');
  }
};
