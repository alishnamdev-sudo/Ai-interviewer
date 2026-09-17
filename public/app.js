/**
 * App — main interview state machine.
 * Depends on: VoiceManager, ReportManager, getRandomQuestions (questions.js)
 */

// ─── Stage Configuration ──────────────────────────────────────────────────────
// WRAP_UP is reached only as a closing announcement from _concludeProblemSolving()
// — once all PROBLEM_SOLVE_QUESTION_COUNT whiteboard rounds are done (or the
// candidate gets MAX_CONSECUTIVE_WRONG_PROBLEM_ANSWERS in a row wrong), the
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

// Fixed opening line for the one stage whose first line isn't itself
// LLM-generated. RESUME_QA is a free-flowing LLM chat like WELLBEING, just
// seeded with a hidden system note instead of a canned line (see
// beginStage) so its opening question is resume-informed rather than
// scripted; PROBLEM_SOLVE has its own dedicated flow (launchProblemSolving);
// WRAP_UP is a scripted closing announcement from submitSolution() with no
// reply expected.
const STAGE_OPENERS = {
  WELLBEING: (name) => `Hi ${name}, welcome to your interview with Vedantu! Before we get started, how are you feeling today?`,
};

// Spoken in place of an AI reply when the chat model is unreachable even after
// the server- and client-side retries (see App._recoverTurn) — natural,
// interviewer-style questions so the candidate never sees an error. General
// enough to fit any teacher, and never repeated within one interview.
const FALLBACK_QUESTIONS = [
  (s) => `Thank you for sharing that. Could you walk me through how you plan a typical ${s} lesson, from preparation to how you check that students have understood?`,
  (s) => `That's helpful. Tell me about a time a student was really struggling with a ${s} concept — how did you help them get past it?`,
  (s) => `Could you describe how you handle a class where students are at very different levels in ${s}?`,
  (s) => `How do you keep students engaged during a live class, especially when their attention starts to drift?`,
  (s) => `What do you do when a student asks a ${s} question you don't immediately know the answer to?`,
  (s) => `How do you use tests or assessments to adjust the way you teach ${s}?`
];
// After this many consecutive fallbacks in RESUME_QA, move on to problem
// solving (which doesn't depend on the chat model) rather than keep asking
// canned questions while the model is down.
const MAX_FALLBACK_STREAK = 3;

const SUBMIT_BTN_MARKUP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg> Submit Solution';

// ─── Whiteboard Timer ─────────────────────────────────────────────────────────
// Dynamic timer: 120 seconds for questions 1-3 (Level 1), 150 seconds for questions 4-8
function getTimerDuration(roundIndex) {
  if (roundIndex < 3) return 120; // Questions 1-3: 120 seconds
  return 150; // Questions 4-8: 150 seconds
}

// Number of distinct problem-solving (whiteboard) questions asked during
// PROBLEM_SOLVE, each with its own dynamic timer (120s for Q1-3, 150s for Q4-8) and a spoken
// follow-up question about the candidate's approach once they submit — unless the
// interview ends early, see the early-exit constants below.
const PROBLEM_SOLVE_QUESTION_COUNT = 8;

// If the candidate gets this many whiteboard rounds wrong in a row (per the
// evaluator's own isCorrect verdict — including a round where nothing was
// submitted before time ran out), stop the problem-solving stage right there
// rather than continuing through the remaining rounds: skip that round's
// follow-up question entirely and go straight to the closing announcement.
// A single correct round anywhere resets the streak.
const MAX_CONSECUTIVE_WRONG_PROBLEM_ANSWERS = 3;

// Performance checkpoint evaluated once, right after this whiteboard round is
// scored: the candidate must be performing well enough by here to justify the
// remaining rounds. Must be less than PROBLEM_SOLVE_QUESTION_COUNT for the
// checkpoint to ever apply.
const PROBLEM_SOLVE_CHECKPOINT_ROUND = 5;
// Accuracy required at the checkpoint to continue on to
// PROBLEM_SOLVE_QUESTION_COUNT — below this, the interview concludes right
// there instead of continuing through the remaining rounds.
const PROBLEM_SOLVE_CHECKPOINT_MIN_ACCURACY = 0.8;

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
  remaining: 0,
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
    candidatePhone: '',
    candidateEmail: '',
    subject:       '',
    spokenLang:    'en-IN',
    stageIndex:    0,
    history:       [],        // Gemini API history (alternating user/model)
    currentQuestion: null,
    problemQuestions: null,   // array of PROBLEM_SOLVE_QUESTION_COUNT distinct whiteboard questions for this subject
    problemRoundIndex: 0,     // index into problemQuestions of the round currently being solved
    problemScores: [],        // score (0-10) from each round, averaged into problemScore for the report
    problemCorrectCount: 0,   // count of isCorrect:true rounds so far; drives the accuracy checkpoint
    problemUngradedCount: 0,  // rounds the evaluator couldn't score (connection problem) — excluded from the checkpoint
    consecutiveWrongProblemAnswers: 0, // resets on any correct round; see MAX_CONSECUTIVE_WRONG_PROBLEM_ANSWERS
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
    fallbacksUsed:   [],      // indexes into FALLBACK_QUESTIONS already spoken (see _recoverTurn)
    fallbackStreak:  0,       // consecutive AI turns that needed a fallback; reset by any successful reply
    endedForMisconduct: false, // true only if the interview was actually terminated for conduct —
                                // a candidate who was warned but behaved afterward is NOT flagged
    quitting:      false,
    sessionId:       null, // unique per interview attempt — lets the server dedupe the normal
                            // completion report against the beforeunload safety-net beacon that
                            // fires right after it (see _setupUnloadHandler/generateReport)
    reportSubmitted: false,
    resumeAnalyzing: false,
    resumeAnalyzed:  false,
    resumeSummary:   null, // summaryText string sent to the AI as resume context
    resumeInfo:      null, // structured { name, yearsExperience, ... } — confirmation card + sent to /api/chat
    cameraEnabled:   false,
    cameraStream:    null, // active MediaStream from getUserMedia, released once the interview ends
    cameraCaptureIntervalId: null,
    streamId:        null // HR live stream ID for real-time monitoring
  },

  // The AI bubble currently being revealed word-by-word in sync with speech:
  // { spans, revealed } or null (see renderAIMsg/_revealSpokenWords).
  _live: null,

  get stage() { return STAGES[this.s.stageIndex]; },

  // Cleanup on page unload - save report and end stream even if user closes tab/navigates away
  _setupUnloadHandler() {
    window.addEventListener('beforeunload', () => {
      // Save partial report if interview was in progress. Guarded by
      // reportSubmitted too: generateReport() already sent the real (possibly
      // final) report for this sessionId before this handler can run on a
      // normal completion — without this check every completed interview
      // would additionally submit a spurious "interrupted" duplicate the
      // instant the candidate closes the thank-you tab.
      if (this.s.teacherName && !this.s.quitting && !this.s.reportSubmitted && this.s.stageIndex > 0) {
        const reportData = {
          sessionId: this.s.sessionId,
          transcript: ReportManager.getPlainTranscript(),
          teacherName: this.s.teacherName,
          candidatePhone: this.s.candidatePhone,
          candidateEmail: this.s.candidateEmail,
          subject: this.s.subject,
          problemScore: this.s.problemScore,
          misconductCount: this.s.misconductCount,
          endedForMisconduct: this.s.endedForMisconduct,
          recordingId: null,
          interrupted: true,
          interruptedAt: this.s.stageIndex
        };
        if (navigator.sendBeacon) {
          const blob = new Blob([JSON.stringify(reportData)], { type: 'application/json' });
          navigator.sendBeacon('/api/report', blob);
        }
      }

      // End stream
      if (this.s.streamId && !this.s.quitting) {
        const streamEndPayload = JSON.stringify({ streamId: this.s.streamId });
        if (navigator.sendBeacon) {
          const blob = new Blob([streamEndPayload], { type: 'application/json' });
          navigator.sendBeacon('/api/stream/end', blob);
        }
      }
    });
  },

  // iPadOS reports as "MacIntel" with touch points (no more "iPad" in its UA
  // by default), so both checks are needed to catch every iOS/iPadOS device.
  _isIOSDevice() {
    const ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  },

  // The AI addresses the candidate by first name only in everything it
  // speaks — this.s.teacherName (typed at setup, possibly auto-filled from
  // the resume) is the full name, kept as-is for the transcript/report.
  _firstName() {
    return (this.s.teacherName || '').trim().split(/\s+/)[0] || 'there';
  },

  // ── Resilient fetch ────────────────────────────────────────────────────────
  // Every interview-critical API call goes through here: each attempt has a
  // hard timeout (a hung request must not freeze the interview) and transient
  // failures — network drops on mobile, 5xx/429 from the server, a cold-started
  // host — are retried with backoff before the caller ever sees an error.
  // Returns the parsed JSON body.
  // deadlineMs caps the TOTAL time across all attempts. Without it the
  // per-attempt timeouts would stack — three 25s attempts is 75s of silence
  // for a candidate mid-conversation. A fast failure (a dropped mobile
  // connection) still leaves room to retry; a slow one simply gives up so the
  // caller can recover in good time.
  async _fetchJSON(url, options = {}, { attempts = 3, timeoutMs = 30000, deadlineMs = Infinity } = {}) {
    const delays = [700, 1800];
    const startedAt = Date.now();
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const remaining = deadlineMs - (Date.now() - startedAt);
      if (attempt > 1 && remaining <= 1000) break; // not enough budget left to be worth another try
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), Math.min(timeoutMs, Math.max(remaining, 1000)));
      try {
        const res = await fetch(url, { ...options, signal: ctrl.signal });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const e = new Error(body.details || body.error || `Server error ${res.status}`);
          // A genuine client error won't change on retry; 5xx/429 might.
          e.permanent = res.status < 500 && res.status !== 429;
          throw e;
        }
        return await res.json();
      } catch (e) {
        lastErr = e;
        if (e.permanent || this.s.quitting || attempt >= attempts) break;
        console.warn(`[fetch] ${url} attempt ${attempt}/${attempts} failed (${e.name === 'AbortError' ? 'timeout' : e.message}) — retrying`);
        await new Promise(r => setTimeout(r, delays[attempt - 1] || 2000));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  },

  // ── Setup ──────────────────────────────────────────────────────────────────
  async startInterview() {
    // Must run synchronously in this click handler, before any `await` below —
    // iOS Safari only unlocks audio playback for the rest of the page when the
    // unlocking call happens in the same task as the user gesture that
    // triggered it (see VoiceManager.unlockAudio's own comment for why).
    VoiceManager.unlockAudio();

    const name    = document.getElementById('teacher-name').value.trim();
    const phone   = document.getElementById('teacher-phone').value.trim();
    const email   = document.getElementById('teacher-email').value.trim();
    const subject = document.getElementById('subject-select').value;
    const spokenLang = document.getElementById('language-select').value || 'en-IN';

    if (!name)    { this.flashError('teacher-name',    'Please enter your name');      return; }
    if (!phone)   { this.flashError('teacher-phone',   'Please enter your phone number'); return; }
    if (!/^[+]?[\d\s-]{7,15}$/.test(phone)) { this.flashError('teacher-phone', 'Please enter a valid phone number'); return; }
    if (!email)   { this.flashError('teacher-email',   'Please enter your email address'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { this.flashError('teacher-email', 'Please enter a valid email address'); return; }
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
    this.s.candidatePhone = phone;
    this.s.candidateEmail = email;
    this.s.subject     = subject;
    this.s.spokenLang  = spokenLang;
    this.s.startDate   = new Date().toLocaleString('en-IN');
    this.s.sessionId   = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

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
    this._setupUnloadHandler(); // Setup cleanup for stream when page closes

    // CRITICAL: Request fullscreen FIRST on mobile
    // This prevents permission dialog from being blocked by page UI
    try {
      await this._requestFullscreen();
    } catch (e) {
      console.warn('Fullscreen request failed (non-critical):', e);
    }

    // NOW request camera — permission dialog appears in fullscreen
    this._startCameraCapture();

    // Record the full interview (camera video + mic audio), streamed to the
    // server in chunks as it happens. Requested here, still within the "Begin
    // Interview" click's permission context. Best-effort: a denied mic or
    // unsupported browser just means no recording — never a blocked interview.
    const recording = await Recorder.start(this.s.cameraStream);
    if (recording) ReportManager.markRecordingStart();

    // Register the recording as a live stream so HR can watch it from the
    // dashboard while it's being written (the live view reads the very file
    // the recorder appends to — so no recording means nothing to watch).
    if (recording) {
      try {
        const streamRes = await fetch('/api/stream/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            recordingId: Recorder.recordingId,
            candidateName: this.s.teacherName,
            subject: this.s.subject
          })
        });
        if (streamRes.ok) {
          const { streamId } = await streamRes.json();
          this.s.streamId = streamId;
          this.s.streamWatchUrl = `${window.location.origin}/hr-watch/${streamId}`;
          console.log('[Stream] Live monitoring initiated:', streamId);
          console.log('[Stream] HR watch URL:', this.s.streamWatchUrl);
        }
      } catch (e) {
        console.warn('[Stream] Failed to initiate live stream:', e);
      }
    }

    // Set up fullscreen and tab-switching monitoring
    this._setupFullscreenMonitoring();
    this._setupTabSwitchingDetection();

    // Start periodic checkpointing for recovery on accidental refresh
    RecoveryManager.startCheckpointing();

    this.showScreen('interview');
    this.updateStageUI();
    await this.beginStage();
  },

  // ── Fullscreen Management ──────────────────────────────────────────────────
  async _requestFullscreen() {
    try {
      const elem = document.documentElement;
      if (elem.requestFullscreen) {
        await elem.requestFullscreen();
      } else if (elem.webkitRequestFullscreen) {
        await elem.webkitRequestFullscreen();
      } else if (elem.mozRequestFullScreen) {
        await elem.mozRequestFullScreen();
      } else if (elem.msRequestFullscreen) {
        await elem.msRequestFullscreen();
      }
    } catch (err) {
      console.warn('Fullscreen request failed:', err);
      this.showToast('⚠️ Please switch to fullscreen mode for the best interview experience.', 'warn');
    }
  },

  _setupFullscreenMonitoring() {
    const checkFullscreen = () => {
      const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
      if (!isFullscreen && !this.s.quitting) {
        this.showToast('⚠️ Please return to fullscreen mode to continue the interview.', 'warn');
        this._requestFullscreen().catch(() => {});
      }
    };

    document.addEventListener('fullscreenchange', checkFullscreen);
    document.addEventListener('webkitfullscreenchange', checkFullscreen);
    document.addEventListener('mozfullscreenchange', checkFullscreen);
    document.addEventListener('msfullscreenchange', checkFullscreen);
  },

  _setupTabSwitchingDetection() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && !this.s.quitting) {
        this.showToast('⚠️ Tab switching is not allowed during the interview. Please return to this tab.', 'warn');
        this.addEntry('System', '[Candidate switched tabs — warning issued]', STAGE_LABELS[this.stage] || 'Interview');
      }
    });

    window.addEventListener('blur', () => {
      if (!this.s.quitting) {
        this.addEntry('System', '[Browser window lost focus]', STAGE_LABELS[this.stage] || 'Interview');
      }
    });
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
      // Request BOTH camera and microphone upfront to trigger a unified 
      // permission prompt (crucial for iOS Safari reliability).
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'user' }, width: { ideal: 320 }, height: { ideal: 240 } },
        audio: { echoCancellation: true, noiseSuppression: true }
      });
      this.s.cameraStream  = stream;
      this.s.cameraEnabled = true;
      const video = document.getElementById('camera-preview-video');
      if (video) video.srcObject = stream;
      return true;
    } catch (e) {
      console.warn('Camera access error:', e);
      this._reportClientError('camera-permission', e);
      this.s.cameraEnabled = false;
      return false;
    }
  },

  // Fire-and-forget diagnostic beacon so a failure the candidate never sees
  // an error for (by design — see catch above) still leaves a trail for
  // debugging. sendBeacon survives the page navigating away right after;
  // fetch+keepalive is the fallback where sendBeacon isn't available.
  // Never throws, never awaited, never shown to the candidate.
  _reportClientError(context, err) {
    try {
      const payload = JSON.stringify({
        context,
        errorName: err && err.name,
        errorMessage: err && err.message,
        teacherName: document.getElementById('teacher-name')?.value.trim() || null,
        candidatePhone: document.getElementById('teacher-phone')?.value.trim() || null,
        candidateEmail: document.getElementById('teacher-email')?.value.trim() || null,
        subject: document.getElementById('subject-select')?.value || null
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/client-error', new Blob([payload], { type: 'application/json' }));
      } else {
        fetch('/api/client-error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(() => {});
      }
    } catch (_) {
      // Diagnostics must never disrupt the actual interview flow.
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
    const DEFAULT_HINT = 'PDF, PNG, JPG, TXT or Word — max 8MB';
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

    const extMimeMap = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', txt: 'text/plain', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const mimeType = extMimeMap[ext] || file.type;
    if (!mimeType || !Object.values(extMimeMap).includes(mimeType)) {
      statusEl.className = 'field-hint resume-status error';
      statusEl.textContent = 'Unsupported file type. Please upload a PDF, PNG, JPG, TXT, or Word resume.';
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
    ReportManager.markChapter(STAGE_LABELS[stage]);

    if (stage === 'PROBLEM_SOLVE') {
      await this.launchProblemSolving();
      return;
    }

    // RESUME_QA's opening question is LLM-generated (resume-informed) rather
    // than a canned line — seeded with a hidden system note the same way
    // handleSilence() nudges the model without a real candidate message. From
    // here on the candidate's replies flow through the ordinary handleAnswer
    // -> callChat path below, exactly like WELLBEING/WRAP_UP.
    if (stage === 'RESUME_QA') {
      this.setStatus('thinking');
      try {
        const resp = await this.callChat(
          '[SYSTEM NOTE: The interview questions stage begins now. Ask your first question — behave like an experienced, thorough teacher-hiring interviewer and use the candidate\'s resume to ask a well-informed, specific opening question rather than a generic one.]',
          /*hidden*/ true
        );
        if (this.s.quitting) return;
        this.renderAIMsg(resp.text);
        this.addEntry('AI Interviewer', resp.text, STAGE_LABELS[stage]);
        this.setStatus('speaking');
        VoiceManager.speak(resp.text, () => {
          if (this.s.quitting) return;
          if (resp.stageComplete) { this.advanceStage(); } else { this.startListening(); }
        });
      } catch (e) { this._recoverTurn(e); }
      return;
    }

    // WELLBEING/WRAP_UP openers are fixed, canned lines rather than LLM-generated —
    // an LLM call here would receive only a bracketed meta-instruction with no real
    // candidate message to respond to, and models can unreliably echo that
    // instruction back as prose instead of just speaking the actual line (the exact
    // failure this replaced). The candidate's actual reply to this line still goes
    // through the normal LLM chat in handleAnswer.
    const openerFn = STAGE_OPENERS[stage];
    const openerText = openerFn ? openerFn(this._firstName()) : null;
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

  async handleAnswer(text) {
    if (this.s.isProcessing || !text.trim()) return;
    this.s.isProcessing = true;
    this.setMic(false);
    this.s.consecutiveSilences = 0; // a real answer came in, regardless of entry point — reset the streak

    if (this.s.awaitingProblemFollowUp) {
      this.s.awaitingProblemFollowUp = false;
      return this._handleProblemFollowUpAnswer(text);
    }

    const label = STAGE_LABELS[this.stage];
    this.renderUserMsg(text);
    this.addEntry('Teacher', text, label);

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
      this._recoverTurn(e, text);
    }
  },

  // ── Turn Recovery ──────────────────────────────────────────────────────────
  // Last line of defence for a conversational turn: the chat model is still
  // unreachable after the server's retries AND the client's retries. Rather
  // than show the candidate an error, the interviewer asks a sensible
  // general question and the interview carries on. The failure is recorded in
  // the transcript for the admin only.
  //
  // candidateAnswer (when the failure followed a real answer) is pushed into
  // history alongside the fallback question, so the alternating user/model
  // sequence stays intact for the next successful call.
  _recoverTurn(err, candidateAnswer = null) {
    this.s.isProcessing = false;
    this.clearSilenceTimer();
    if (this.s.quitting) return;

    console.warn('[recover] AI turn failed, using fallback:', err && err.message);
    const label = STAGE_LABELS[this.stage];
    this.addEntry(
      'System (internal note — not shown to candidate)',
      `AI reply unavailable after retries (${err && err.message}); interviewer continued with a fallback question.`,
      label
    );

    this.s.fallbackStreak++;

    // Persistent outage: stop asking canned questions and move to the next
    // stage, which doesn't depend on the conversational model.
    const nextUnused = FALLBACK_QUESTIONS.findIndex((_, i) => !this.s.fallbacksUsed.includes(i));
    if (this.s.fallbackStreak > MAX_FALLBACK_STREAK || nextUnused === -1) {
      this.addEntry(
        'System (internal note — not shown to candidate)',
        'Chat model unavailable for several consecutive turns — advanced to the next stage early.',
        label
      );
      this.advanceStage().catch(err => this.handleErr(err));
      return;
    }

    this.s.fallbacksUsed.push(nextUnused);
    const question = FALLBACK_QUESTIONS[nextUnused](this.s.subject || 'your subject');

    this.s.history.push({
      role:  'user',
      parts: [{ text: candidateAnswer || '(the candidate did not respond)' }]
    });
    this.s.history.push({ role: 'model', parts: [{ text: question }] });

    this.renderAIMsg(question);
    this.addEntry('AI Interviewer', question, label);
    this.setStatus('speaking');
    VoiceManager.speak(question, () => {
      if (this.s.quitting) return;
      this.startListening();
    });
  },

  // ── Conduct Monitoring ─────────────────────────────────────────────────────
  // Fails open: conduct screening is a best-effort safeguard, so if the check
  // itself is unavailable the answer is treated as clean rather than letting
  // it interrupt the interview.
  async _checkConduct(text) {
    try {
      return await this._fetchJSON('/api/check-conduct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userMessage: text, teacherName: this.s.teacherName, misconductCount: this.s.misconductCount })
      }, { attempts: 2, timeoutMs: 9000, deadlineMs: 11000 });
    } catch (e) {
      console.warn('[conduct] check unavailable, treating answer as clean:', e.message);
      return { flagged: false, text: null, misconductWarning: false, misconductEnd: false };
    }
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
      resumeInfo:   this.s.resumeInfo,
      misconductCount: this.s.misconductCount
    };

    const data = await this._fetchJSON('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }, { attempts: 3, timeoutMs: 25000, deadlineMs: 27000 });

    if (!data || typeof data.text !== 'string' || !data.text.trim()) {
      throw new Error('empty AI reply');
    }

    // Commit the turn to local history only once the reply is in hand — a
    // failed call must not leave a dangling user turn that would break the
    // alternating user/model history sent with every later request.
    this.s.history.push({ role: 'user',  parts: [{ text: userMessage }] });
    this.s.history.push({ role: 'model', parts: [{ text: data.text }] });
    this.s.fallbackStreak = 0;

    return data; // { text, stageComplete, misconductWarning, misconductEnd }
  },

  // ── Problem Solving (Whiteboard) ───────────────────────────────────────────
  async launchProblemSolving() {
    this.clearSilenceTimer(); // whiteboard uses its own 90s Timer, not this
    // Spoken after every solution submission — warm it once up front.
    VoiceManager.prefetch('Thank you for sharing your approach.');
    this.s.problemQuestions   = [];
    this.s.problemRoundIndex  = 0;
    this.s.problemScores      = [];
    this.s.problemCorrectCount = 0;
    this.s.problemUngradedCount = 0;
    this.s.consecutiveWrongProblemAnswers = 0;

    const total = PROBLEM_SOLVE_QUESTION_COUNT;
    // Deliberately tone-neutral (not "Wonderful!") — this fixed line always
    // fires right after the RESUME_QA acknowledgment, whose tone depends on
    // what the candidate just said, so an unconditionally upbeat opener here
    // could clash with e.g. an empathetic reaction to a disappointing answer.
    // Numericals/derivations are graded on the whole approach, so warn the
    // candidate up front that bare answers won't score well on those.
    const announcement = `Alright, we've had a good conversation. I'd now like to see your ${this.s.subject} problem-solving approach across ${total} questions. You'll have 90 seconds for each — write with a pen or stylus, or speak your solution if you don't have one, and I'll follow up on your approach after each one. The questions will gradually increase in difficulty as you progress.`;

    this.renderAIMsg(announcement);
    this.addEntry('AI Interviewer', announcement, 'Problem Solving');
    this.setStatus('speaking');

    VoiceManager.speak(announcement, () => {
      if (this.s.quitting) return;
      this.startProblemRound();
    });
  },

  // Pulls whiteboard questions from the server's bank of real JEE/NEET exam
  // questions (/api/problem-questions), with progressive difficulty based on
  // roundIndex. Falls back to the small built-in QUESTIONS_DB (questions.js)
  // when the subject isn't covered by the bank (Computer Science, English) or
  // the request fails — starting the problem-solving stage must never be blocked.
  async _fetchProblemQuestions(subject, count, roundIndex = 0) {
    try {
      const data = await this._fetchJSON(
        `/api/problem-questions?subject=${encodeURIComponent(subject)}&count=${count}&roundIndex=${roundIndex}`,
        {},
        { attempts: 2, timeoutMs: 12000 }
      );
      if (!Array.isArray(data.questions) || !data.questions.length) throw new Error('empty bank response');
      return data.questions;
    } catch (e) {
      console.warn('Question bank unavailable, using built-in questions:', e.message);
      return getRandomQuestions(subject, count);
    }
  },

  async startProblemRound() {
    if (this.s.quitting) return;

    // Fetch the next question based on the current round index (progressive difficulty)
    const questions = await this._fetchProblemQuestions(this.s.subject, 1, this.s.problemRoundIndex);
    if (!questions || questions.length === 0) {
      // No question could be produced from any source (bank and built-in set
      // both empty for this subject). Returning here would leave the candidate
      // staring at a screen with nothing to do — conclude the stage gracefully
      // instead of stalling.
      console.error('Failed to fetch question for round', this.s.problemRoundIndex);
      this.addEntry(
        'System (internal note — not shown to candidate)',
        `No problem-solving question was available for round ${this.s.problemRoundIndex + 1} — problem solving ended here.`,
        'Problem Solving'
      );
      await this._concludeProblemSolving();
      return;
    }

    const q = questions[0];
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
    document.getElementById('q-subj').textContent    = `${q.subject} · Q${this.s.problemRoundIndex + 1}/${PROBLEM_SOLVE_QUESTION_COUNT}`;
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

    const timerDuration = getTimerDuration(this.s.problemRoundIndex);
    Timer.start(timerDuration, (remaining, total) => this.updateTimerUI(remaining, total), () => {
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
      // The server already returns a graceful fallback verdict when the model
      // fails, so reaching the catch below means the request itself couldn't
      // get through even after retries — record the round neutrally rather
      // than penalising the candidate for a network problem.
      let ev;
      let evalUnavailable = false;
      try {
        ev = await this._fetchJSON('/api/evaluate', {
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
        }, { attempts: 3, timeoutMs: 45000, deadlineMs: 70000 });
      } catch (e) {
        console.warn('[evaluate] unavailable after retries:', e.message);
        evalUnavailable = true;
        ev = {
          isCorrect: false,
          score: 5, // neutral placeholder so the round average isn't skewed either way
          evaluation: 'Automatic evaluation was unavailable (connection problem) — the solution was recorded but could not be graded automatically. Please review it from the recording and whiteboard.',
          feedback: '',
          followUpQuestion: null
        };
      }
      if (this.s.quitting) return; // candidate quit while evaluation was in flight
      this.s.problemScores.push(ev.score ?? 5);
      // Kept as a single number for backward compatibility with the report
      // payload — the average across all rounds so far. Rounded to one decimal
      // place rather than a whole number so it keeps the precision of the
      // per-round scores instead of flattening real differences between
      // candidates into the same integer.
      this.s.problemScore = Math.round((this.s.problemScores.reduce((a, b) => a + b, 0) / this.s.problemScores.length) * 10) / 10;

      // A wrong round (including submitting nothing) extends the streak; any
      // correct round resets it and counts toward the accuracy checkpoint below.
      // An ungraded round (evaluator unreachable) counts as neither — a
      // connection problem must never push a candidate toward an early exit.
      if (!evalUnavailable) {
        if (ev.isCorrect) this.s.problemCorrectCount++;
        this.s.consecutiveWrongProblemAnswers = ev.isCorrect ? 0 : this.s.consecutiveWrongProblemAnswers + 1;
      } else {
        this.s.problemUngradedCount++;
      }

      // Two early-exit triggers, both producing the same effect (skip this
      // round's follow-up, go straight to the closing announcement instead of
      // the remaining rounds) — only the reason logged for the admin differs:
      //  1. MAX_CONSECUTIVE_WRONG_PROBLEM_ANSWERS wrong rounds in a row, at any point.
      //  2. At the PROBLEM_SOLVE_CHECKPOINT_ROUND-th round specifically, accuracy
      //     so far hasn't met PROBLEM_SOLVE_CHECKPOINT_MIN_ACCURACY — meeting or
      //     beating it there is what earns the remaining rounds.
      let endEarlyReason = null;
      if (this.s.consecutiveWrongProblemAnswers >= MAX_CONSECUTIVE_WRONG_PROBLEM_ANSWERS) {
        endEarlyReason = `${MAX_CONSECUTIVE_WRONG_PROBLEM_ANSWERS} consecutive incorrect/insufficient answers`;
      } else if (this.s.problemScores.length === PROBLEM_SOLVE_CHECKPOINT_ROUND) {
        // Ungraded rounds (evaluator unreachable) are excluded from the
        // denominator — a candidate must never be cut short because a network
        // problem made some of their rounds impossible to score.
        const graded = this.s.problemScores.length - this.s.problemUngradedCount;
        const accuracy = graded > 0 ? this.s.problemCorrectCount / graded : 1;
        if (accuracy < PROBLEM_SOLVE_CHECKPOINT_MIN_ACCURACY) {
          const tally = `${this.s.problemCorrectCount}/${graded} correct`;
          endEarlyReason = `below the ${Math.round(PROBLEM_SOLVE_CHECKPOINT_MIN_ACCURACY * 100)}% accuracy checkpoint at question ${PROBLEM_SOLVE_CHECKPOINT_ROUND} (${tally})`;
        }
      }
      const endEarly = !!endEarlyReason;

      const roundLabel = `Problem Solving (Q${this.s.problemRoundIndex + 1}/${PROBLEM_SOLVE_QUESTION_COUNT})`;

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
      if (endEarly) {
        this.addEntry('AI Interviewer (internal note — not shown to candidate)', `Problem-solving ended early — ${endEarlyReason}.`, roundLabel);
      }

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
        if (endEarly) {
          this._concludeProblemSolving();
        } else if (ev.followUpQuestion) {
          setTimeout(() => { if (!this.s.quitting) this._askProblemFollowUp(ev.followUpQuestion, roundLabel); }, 700);
        } else {
          this._advanceProblemRound();
        }
      });

    } catch (e) {
      // The evaluation call itself already has its own fallback above, so this
      // only catches an unexpected local failure (e.g. exporting the canvas).
      // Restore the button and keep the interview moving rather than stranding
      // the candidate on the whiteboard screen.
      console.error('[submitSolution] unexpected failure:', e);
      btn.disabled  = false;
      btn.innerHTML = SUBMIT_BTN_MARKUP;
      if (this.s.quitting) return;
      this.addEntry('System (internal note — not shown to candidate)', `Solution submission failed unexpectedly: ${e.message}`, `Problem Solving (Q${this.s.problemRoundIndex + 1}/${PROBLEM_SOLVE_QUESTION_COUNT})`);
      this.showScreen('interview');
      this.updateStageUI();
      const ackText = 'Thank you for sharing your approach.';
      this.renderAIMsg(ackText);
      this.addEntry('AI Interviewer', ackText, `Problem Solving (Q${this.s.problemRoundIndex + 1}/${PROBLEM_SOLVE_QUESTION_COUNT})`);
      this.setStatus('speaking');
      VoiceManager.speak(ackText, () => {
        if (!this.s.quitting) this._advanceProblemRound();
      });
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
    const roundLabel = `Problem Solving Follow-up (Q${this.s.problemRoundIndex + 1}/${PROBLEM_SOLVE_QUESTION_COUNT})`;
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
      // The follow-up answer is already logged to the transcript above, so
      // nothing is lost — just move on to the next round silently.
      console.warn('[problem follow-up] failed, advancing round:', e.message);
      this.s.isProcessing = false;
      if (!this.s.quitting) await this._advanceProblemRound();
    }
  },

  // Moves to the next problem-solving question, or concludes the interview
  // once all PROBLEM_SOLVE_QUESTION_COUNT rounds are done. (Ending early after
  // MAX_CONSECUTIVE_WRONG_PROBLEM_ANSWERS wrong rounds in a row is handled
  // directly from submitSolution() instead — it never reaches this function.)
  async _advanceProblemRound() {
    if (this.s.quitting) return;
    this.s.problemRoundIndex++;
    if (this.s.problemRoundIndex >= PROBLEM_SOLVE_QUESTION_COUNT) {
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
    ReportManager.markChapter(STAGE_LABELS.WRAP_UP); // WRAP_UP skips beginStage() (see STAGES comment above), so it needs its own marker
    this.showScreen('interview');
    this.updateStageUI();

    const closing = `Thank you for interviewing with Vedantu, ${this._firstName()}. We'll get back to you with a follow-up soon.`;
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
  async generateReport(interrupted = false) {
    // Stop checkpointing and clear recovery data on normal completion
    RecoveryManager.stopCheckpointing();

    this._stopCameraCapture();
    if (!interrupted) this.showScreen('loading');

    // Stop the recording and wait for its final chunk to reach the server
    // BEFORE releasing the camera stream (stopping the tracks would cut the
    // recorder off mid-chunk). Returns null if recording never ran or failed.
    const recordingId = await Recorder.stop().catch(() => null);
    this._releaseCameraStream();
    VoiceManager.releaseMic(); // the STT capture stream, separate from the recorder's

    // End the HR live stream (critical - must happen before page unload)
    if (this.s.streamId) {
      const streamEndPayload = JSON.stringify({ streamId: this.s.streamId });
      // Use sendBeacon for reliability if available (survives page unload)
      if (navigator.sendBeacon) {
        navigator.sendBeacon('/api/stream/end', streamEndPayload);
      } else {
        fetch('/api/stream/end', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: streamEndPayload
        }).catch(e => console.warn('[Stream] Failed to end stream:', e));
      }
    }

    try {
      const reportData = {
        sessionId:       this.s.sessionId,
        transcript:      ReportManager.getPlainTranscript(),
        chapters:        ReportManager.getChapters(),
        teacherName:     this.s.teacherName,
        candidatePhone:  this.s.candidatePhone,
        candidateEmail:  this.s.candidateEmail,
        subject:         this.s.subject,
        problemScore:    this.s.problemScore,
        misconductCount: this.s.misconductCount,
        endedForMisconduct: this.s.endedForMisconduct,
        recordingId, // links the report to data/recordings/<id>.webm (or null)
        interrupted: interrupted ? true : false,
        interruptedAt: interrupted ? this.s.stageIndex : null
      };

      // Use sendBeacon for critical reliability (survives page unload)
      const payload = JSON.stringify(reportData);
      const blob = new Blob([payload], { type: 'application/json' });
      const success = navigator.sendBeacon('/api/report', blob);

      if (!success) {
        // Fallback to a retrying fetch if sendBeacon is unavailable or refused
        // the payload (it has a size cap) — the report is the whole point of
        // the interview, so it gets several attempts before giving up.
        await this._fetchJSON('/api/report', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload
        }, { attempts: 4, timeoutMs: 30000 });
      }

      // Clear recovery data on successful submission
      RecoveryManager.clearCheckpoint();
      // A real submission for this sessionId is now on the server, so the
      // beforeunload safety net (which would otherwise fire an interrupted
      // duplicate the moment this tab closes) can stand down.
      this.s.reportSubmitted = true;
      if (!interrupted) this.showScreen('report');
    } catch (e) {
      console.error('[Report] Failed to submit:', e);
      if (!interrupted) {
        this.showScreen('report');
        // The interview itself finished normally, so the tone stays calm — but
        // the team does need to know the submission didn't land, otherwise the
        // candidate's interview would be lost silently.
        document.getElementById('report-container').innerHTML =
          `<p class="error-msg">Thank you for completing your interview. Your responses could not be uploaded automatically — please let the recruitment team know so they can retrieve them.</p>`;
      }
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
      ? `Problem Solving Follow-up (Q${this.s.problemRoundIndex + 1}/${PROBLEM_SOLVE_QUESTION_COUNT})`
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
      this._recoverTurn(e);
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

  // Last-resort handler for an unexpected failure with no turn to recover.
  // Deliberately says NOTHING to the candidate — an interview must never show
  // an error message or a broken-looking apology bubble. Recoverable
  // conversational failures are handled by App._recoverTurn instead; this only
  // restores the controls so the candidate can keep speaking, and records the
  // failure in the transcript for the admin.
  handleErr(e) {
    console.error(e);
    this.clearSilenceTimer();
    this.setStatus('idle');
    this.setMic(true);
    if (typeof this.addEntry === 'function') {
      this.addEntry(
        'System (internal note — not shown to candidate)',
        `Unexpected client error: ${e && e.message}`,
        STAGE_LABELS[this.stage] || ''
      );
    }
  }
};
