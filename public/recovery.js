/**
 * Interview Auto-Save & Partial Submission
 * Saves incomplete interviews for admin review without offering resume to candidates
 */

const RecoveryManager = {
  CHECKPOINT_KEY: 'interview_checkpoint_v1',
  CHECKPOINT_INTERVAL_MS: 15000, // Save state every 15 seconds
  checkpointIntervalId: null,

  // Start periodic checkpointing once interview begins
  startCheckpointing() {
    if (this.checkpointIntervalId) return;
    this.checkpointIntervalId = setInterval(() => {
      if (!App.s.quitting) {
        this.saveCheckpoint();
      }
    }, this.CHECKPOINT_INTERVAL_MS);
  },

  // Stop checkpointing (call on interview end)
  stopCheckpointing() {
    if (this.checkpointIntervalId) {
      clearInterval(this.checkpointIntervalId);
      this.checkpointIntervalId = null;
    }
  },

  // Save interview state to localStorage for partial submission
  saveCheckpoint() {
    try {
      const checkpoint = {
        timestamp: Date.now(),
        teacherName: App.s.teacherName,
        subject: App.s.subject,
        spokenLang: App.s.spokenLang,
        stageIndex: App.s.stageIndex,
        history: App.s.history,
        currentQuestion: App.s.currentQuestion,
        problemQuestions: App.s.problemQuestions,
        problemRoundIndex: App.s.problemRoundIndex,
        problemScores: App.s.problemScores,
        problemCorrectCount: App.s.problemCorrectCount,
        consecutiveWrongProblemAnswers: App.s.consecutiveWrongProblemAnswers,
        awaitingProblemFollowUp: App.s.awaitingProblemFollowUp,
        problemScore: App.s.problemScore,
        startDate: App.s.startDate,
        consecutiveSilences: App.s.consecutiveSilences,
        misconductCount: App.s.misconductCount,
        endedForMisconduct: App.s.endedForMisconduct,
        resumeInfo: App.s.resumeInfo,
        resumeSummary: App.s.resumeSummary,
        resumeAnalyzed: App.s.resumeAnalyzed
      };
      localStorage.setItem(this.CHECKPOINT_KEY, JSON.stringify(checkpoint));
    } catch (e) {
      console.warn('[RecoveryManager] Failed to save checkpoint:', e.message);
    }
  },

  // Load checkpoint from localStorage
  loadCheckpoint() {
    try {
      const json = localStorage.getItem(this.CHECKPOINT_KEY);
      if (!json) return null;
      return JSON.parse(json);
    } catch (e) {
      console.warn('[RecoveryManager] Failed to load checkpoint:', e.message);
      return null;
    }
  },

  // Clear checkpoint from localStorage
  clearCheckpoint() {
    try {
      localStorage.removeItem(this.CHECKPOINT_KEY);
    } catch (e) {
      console.warn('[RecoveryManager] Failed to clear checkpoint:', e.message);
    }
  },

  // Submit partial interview data on page unload (NO resume dialog shown to candidate)
  async submitPartialReport() {
    try {
      if (!App.s.teacherName || (App.s.stageIndex === 0 && !App.s.history.length)) {
        return;
      }

      const recordingId = Recorder ? await Recorder.stop().catch(() => null) : null;

      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          transcript: ReportManager.getPlainTranscript(),
          teacherName: App.s.teacherName,
          subject: App.s.subject,
          problemScore: App.s.problemScore,
          misconductCount: App.s.misconductCount,
          endedForMisconduct: App.s.endedForMisconduct,
          recordingId: recordingId,
          interrupted: true,
          stageIndex: App.s.stageIndex,
          interruptedAt: new Date().toISOString()
        })
      });

      if (res.ok) {
        console.log('[RecoveryManager] Partial report submitted on unload');
        this.clearCheckpoint();
      }
    } catch (e) {
      console.warn('[RecoveryManager] Failed to submit partial report:', e.message);
    }
  }
};

// ─── Unload Handlers ────────────────────────────────────────────────────────

// Show warning before leaving if interview is active
window.addEventListener('beforeunload', (e) => {
  const interviewActive = App.s.teacherName && (App.s.stageIndex > 0 || App.s.history.length > 0);

  if (interviewActive && !App.s.quitting) {
    e.preventDefault();
    e.returnValue = 'Your interview data will be lost if you leave. Are you sure?';
    return 'Your interview data will be lost if you leave. Are you sure?';
  }
});

// Submit partial data when page is being unloaded
// Using pagehide instead of unload for better browser compatibility
// and to avoid Permissions Policy violations
window.addEventListener('pagehide', (e) => {
  try {
    const interviewActive = App.s.teacherName && (App.s.stageIndex > 0 || App.s.history.length > 0);
    if (interviewActive && !App.s.quitting) {
      const data = {
        transcript: ReportManager ? ReportManager.getPlainTranscript() : '',
        teacherName: App.s.teacherName,
        subject: App.s.subject,
        problemScore: App.s.problemScore,
        misconductCount: App.s.misconductCount,
        endedForMisconduct: App.s.endedForMisconduct,
        interrupted: true,
        stageIndex: App.s.stageIndex,
        interruptedAt: new Date().toISOString()
      };
      navigator.sendBeacon('/api/report', JSON.stringify(data));
      console.log('[RecoveryManager] Partial report sent via beacon on pagehide');
    }
  } catch (e) {
    console.warn('[RecoveryManager] Beacon failed:', e.message);
  }
});