/**
 * Interview Recovery & Auto-Save
 * Handles localStorage checkpoints, resume on reload, and partial submission on unload
 */

const RecoveryManager = {
  CHECKPOINT_KEY: 'interview_checkpoint_v1',
  CHECKPOINT_INTERVAL_MS: 15000, // Save state every 15 seconds
  CHECKPOINT_EXPIRY_MS: 24 * 60 * 60 * 1000, // 24 hours
  checkpointIntervalId: null,
  isRecoveryDialogOpen: false,

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

  // Save interview state to localStorage
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
        resumeAnalyzed: App.s.resumeAnalyzed,
        transcriptEntries: ReportManager._entries || []
      };
      localStorage.setItem(this.CHECKPOINT_KEY, JSON.stringify(checkpoint));
      console.log('[RecoveryManager] Checkpoint saved', new Date(checkpoint.timestamp).toLocaleTimeString());
    } catch (e) {
      console.warn('[RecoveryManager] Failed to save checkpoint:', e.message);
    }
  },

  // Load checkpoint from localStorage
  loadCheckpoint() {
    try {
      const json = localStorage.getItem(this.CHECKPOINT_KEY);
      if (!json) return null;

      const checkpoint = JSON.parse(json);
      const age = Date.now() - checkpoint.timestamp;

      if (age > this.CHECKPOINT_EXPIRY_MS) {
        console.log('[RecoveryManager] Checkpoint expired (>24h), discarding');
        this.clearCheckpoint();
        return null;
      }

      return checkpoint;
    } catch (e) {
      console.warn('[RecoveryManager] Failed to load checkpoint:', e.message);
      return null;
    }
  },

  // Clear checkpoint from localStorage
  clearCheckpoint() {
    try {
      localStorage.removeItem(this.CHECKPOINT_KEY);
      console.log('[RecoveryManager] Checkpoint cleared');
    } catch (e) {
      console.warn('[RecoveryManager] Failed to clear checkpoint:', e.message);
    }
  },

  // Format time for display (e.g., "2 minutes ago")
  formatTime(ms) {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return 'More than a day ago';
  },

  // Escape HTML to prevent XSS
  escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },

  // Show recovery dialog if checkpoint exists
  showRecoveryDialogIfNeeded() {
    if (this.isRecoveryDialogOpen) return;

    const checkpoint = this.loadCheckpoint();
    if (!checkpoint) return;

    const age = Date.now() - checkpoint.timestamp;
    const formattedTime = this.formatTime(age);
    const stageName = STAGE_LABELS[STAGES[checkpoint.stageIndex]] || 'Unknown stage';

    this.isRecoveryDialogOpen = true;

    // Create modal overlay
    const overlay = document.createElement('div');
    overlay.id = 'recovery-modal-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
    `;

    const modal = document.createElement('div');
    modal.style.cssText = `
      background: var(--bg, white);
      border-radius: 8px;
      padding: 30px;
      max-width: 500px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
      animation: slideUp 0.3s ease-out;
    `;

    modal.innerHTML = `
      <h2 style="margin-top: 0; color: #0066cc;">📋 Interview Paused</h2>
      <p>An interview was interrupted. Would you like to continue where you left off?</p>
      <div style="background: #f0f4ff; padding: 15px; border-radius: 6px; margin: 20px 0; border-left: 4px solid #0066cc;">
        <div style="font-size: 0.9em; opacity: 0.8;">
          <strong>Last saved:</strong> ${formattedTime}<br>
          <strong>Stage:</strong> ${stageName}<br>
          <strong>Candidate:</strong> ${checkpoint.teacherName}
        </div>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
        <button id="recovery-resume-btn" style="padding: 12px; background: #4caf50; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;">
          ✓ Resume Interview
        </button>
        <button id="recovery-discard-btn" style="padding: 12px; background: #f44336; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 600;">
          ✕ Start Fresh
        </button>
      </div>
      <p style="font-size: 0.85em; opacity: 0.7; margin-top: 15px;">
        Note: Audio recording will restart. Previous responses are preserved in the transcript.
      </p>
    `;

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Add CSS animation
    const style = document.createElement('style');
    style.textContent = `
      @keyframes slideUp {
        from { transform: translateY(20px); opacity: 0; }
        to { transform: translateY(0); opacity: 1; }
      }
    `;
    document.head.appendChild(style);

    // Event handlers
    document.getElementById('recovery-resume-btn').addEventListener('click', () => {
      this.resumeInterview(checkpoint, overlay);
    });

    document.getElementById('recovery-discard-btn').addEventListener('click', () => {
      this.discardCheckpoint(overlay);
    });
  },

  // Restore interview state from checkpoint
  resumeInterview(checkpoint, overlay) {
    overlay.remove();
    this.isRecoveryDialogOpen = false;

    // Restore App state
    App.s.teacherName = checkpoint.teacherName;
    App.s.subject = checkpoint.subject;
    App.s.spokenLang = checkpoint.spokenLang;
    App.s.stageIndex = checkpoint.stageIndex;
    App.s.history = checkpoint.history;
    App.s.currentQuestion = checkpoint.currentQuestion;
    App.s.problemQuestions = checkpoint.problemQuestions;
    App.s.problemRoundIndex = checkpoint.problemRoundIndex;
    App.s.problemScores = checkpoint.problemScores;
    App.s.problemCorrectCount = checkpoint.problemCorrectCount;
    App.s.consecutiveWrongProblemAnswers = checkpoint.consecutiveWrongProblemAnswers;
    App.s.awaitingProblemFollowUp = checkpoint.awaitingProblemFollowUp;
    App.s.problemScore = checkpoint.problemScore;
    App.s.startDate = checkpoint.startDate;
    App.s.consecutiveSilences = checkpoint.consecutiveSilences;
    App.s.misconductCount = checkpoint.misconductCount;
    App.s.endedForMisconduct = checkpoint.endedForMisconduct;
    App.s.resumeInfo = checkpoint.resumeInfo;
    App.s.resumeSummary = checkpoint.resumeSummary;
    App.s.resumeAnalyzed = checkpoint.resumeAnalyzed;

    // Restore transcript entries through ReportManager for report generation
    if (checkpoint.transcriptEntries && checkpoint.transcriptEntries.length > 0) {
      checkpoint.transcriptEntries.forEach(entry => {
        ReportManager.addEntry(entry.speaker, entry.text, entry.stage);
      });
    }

    // Re-render UI to match restored state
    App.updateStageUI();
    App.showScreen('interview');

    // Rebuild chat UI from history (Gemini conversation)
    if (checkpoint.history && checkpoint.history.length > 0) {
      const messagesBox = document.getElementById('messages');
      if (messagesBox) {
        // Clear existing messages
        messagesBox.innerHTML = '';

        // Rebuild UI from conversation history
        for (let i = 0; i < checkpoint.history.length; i++) {
          const msg = checkpoint.history[i];
          const text = msg.parts?.[0]?.text || '';
          if (!text) continue;

          if (msg.role === 'user') {
            // User message - manually add to DOM since renderUserMsg may not exist
            const wrap = document.createElement('div');
            wrap.className = 'msg-wrap user';
            wrap.innerHTML = `
              <div class="msg-avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg></div>
              <div class="msg-bubble">
                <p class="msg-text">${this.escapeHtml(text)}</p>
              </div>
            `;
            messagesBox.appendChild(wrap);
            requestAnimationFrame(() => wrap.classList.add('visible'));
          } else if (msg.role === 'model') {
            // AI message - use the existing method
            App.renderAIMsg(text, false);
          }
        }

        // Scroll to bottom
        messagesBox.scrollTop = messagesBox.scrollHeight;
      }
    }

    App.showToast('✓ Interview resumed from checkpoint', 'success');
    console.log('[RecoveryManager] Interview resumed from stage', checkpoint.stageIndex);
    console.log('[RecoveryManager] Restored', checkpoint.history?.length || 0, 'history items');

    // Resume the interview flow: wait for UI to be ready
    setTimeout(async () => {
      try {
        // Ensure VoiceManager is ready
        if (typeof VoiceManager !== 'undefined' && typeof VoiceManager.init === 'function') {
          console.log('[RecoveryManager] Reinitializing VoiceManager');
          await VoiceManager.init(checkpoint.spokenLang || 'en-IN');
        }

        // Start checkpointing and listening
        if (typeof App !== 'undefined') {
          console.log('[RecoveryManager] Starting checkpointing');
          App.startCheckpointing();

          console.log('[RecoveryManager] Starting listening');
          App.startListening();
        }
      } catch (e) {
        console.error('[RecoveryManager] Error resuming interview:', e.message);
        console.error('[RecoveryManager] Stack:', e.stack);
        App.showToast('Interview resumed but audio may need restart. Tap mic to continue.', 'warn');
      }
    }, 800);
  },

  // Discard checkpoint and start fresh
  discardCheckpoint(overlay) {
    overlay.remove();
    this.isRecoveryDialogOpen = false;
    this.clearCheckpoint();
    location.reload(); // Fresh start
  },

  // Submit partial interview data on page unload
  async submitPartialReport() {
    try {
      // Only submit if interview is actually in progress (not setup, not already submitted)
      if (!App.s.teacherName || App.s.stageIndex === 0 && !App.s.history.length) {
        return;
      }

      const recordingId = Recorder ? await Recorder.stop().catch(() => null) : null;

      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Use sendBeacon for reliability on unload
        keepalive: true,
        body: JSON.stringify({
          transcript: ReportManager.getPlainTranscript(),
          teacherName: App.s.teacherName,
          subject: App.s.subject,
          problemScore: App.s.problemScore,
          misconductCount: App.s.misconductCount,
          endedForMisconduct: App.s.endedForMisconduct,
          recordingId: recordingId,
          interrupted: true, // Flag this as an interrupted/partial submission
          stageIndex: App.s.stageIndex,
          interruptedAt: new Date().toISOString()
        })
      });

      if (res.ok) {
        console.log('[RecoveryManager] Partial report submitted on unload');
        this.clearCheckpoint(); // Clean up checkpoint after successful submission
      }
    } catch (e) {
      console.warn('[RecoveryManager] Failed to submit partial report:', e.message);
      // Silently fail - user is already leaving
    }
  }
};

// ─── Initialize Recovery on Page Load ───────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Check for recovered interview on page load
  RecoveryManager.showRecoveryDialogIfNeeded();
});

// ─── Unload Handlers ────────────────────────────────────────────────────────

// Show warning before leaving if interview is active
window.addEventListener('beforeunload', (e) => {
  // Only show warning if interview is actually in progress
  const interviewActive = App.s.teacherName && (App.s.stageIndex > 0 || App.s.history.length > 0);

  if (interviewActive && !App.s.quitting) {
    // Modern browsers ignore the message text, but the event still triggers the dialog
    e.preventDefault();
    e.returnValue = 'Your interview will be lost if you leave. Are you sure?';
    return 'Your interview will be lost if you leave. Are you sure?';
  }
});

// Attempt to submit partial data on page unload
window.addEventListener('unload', () => {
  // Use sendBeacon API for more reliable delivery on unload
  try {
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

    const interviewActive = App.s.teacherName && (App.s.stageIndex > 0 || App.s.history.length > 0);
    if (interviewActive && !App.s.quitting) {
      navigator.sendBeacon('/api/report', JSON.stringify(data));
      console.log('[RecoveryManager] Beacon sent on unload');
    }
  } catch (e) {
    console.warn('[RecoveryManager] Beacon failed:', e.message);
  }
});

// Also handle pagehide (more reliable than unload on some browsers)
window.addEventListener('pagehide', (e) => {
  if (e.persisted === false) { // User is leaving, not using bfcache
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
      }
    } catch (e) {
      // Silently fail on unload
    }
  }
});