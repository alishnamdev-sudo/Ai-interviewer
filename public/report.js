/**
 * ReportManager — builds the interview transcript in-browser so it can be
 * sent to the server for report generation. The rendered report itself is
 * never shown here — see /admin for reviewing completed interviews.
 */
const ReportManager = (() => {
  const entries = []; // { speaker, text, stage, time }
  const chapters = []; // { label, seconds } — one marker per interview stage, used by
                        // the admin dashboard to let a reviewer jump straight to a
                        // section of the recording instead of scrubbing/waiting for it
                        // to buffer.
  let recordingStartedAt = null;

  // Called right after MediaRecorder actually starts (see Recorder.start() in app.js)
  // so chapter offsets line up with the recording's own timeline, not the interview's.
  function markRecordingStart() {
    recordingStartedAt = Date.now();
  }

  // One marker per stage — safe to call more than once for the same label (e.g. a
  // stage re-entered on recovery), only the first call sticks.
  function markChapter(label) {
    if (!label || chapters.some(c => c.label === label)) return;
    const seconds = recordingStartedAt ? Math.max(0, Math.round((Date.now() - recordingStartedAt) / 1000)) : 0;
    chapters.push({ label, seconds });
  }

  function getChapters() {
    return chapters.slice();
  }

  function addEntry(speaker, text, stage) {
    entries.push({
      speaker,
      text: text.trim(),
      stage,
      time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
    });
  }

  // Proctoring tallies, summarised at the top of the transcript so reviewers
  // (and the scoring model) see them without scanning every entry.
  const proctor = { tabSwitches: 0, awayMs: 0, focusLosses: 0 };

  function noteTabSwitch() { proctor.tabSwitches++; }
  function noteReturn(ms) { proctor.awayMs += ms; }
  function noteFocusLoss() { proctor.focusLosses++; }

  function proctorSummary() {
    if (!proctor.tabSwitches && !proctor.focusLosses) return '';
    return `[Proctoring summary] Tab switches: ${proctor.tabSwitches} (total time away: ${Math.round(proctor.awayMs / 1000)}s) | Window focus lost: ${proctor.focusLosses}\n`;
  }

  function getPlainTranscript() {
    let lastStage = '';
    return proctorSummary() + entries.map(e => {
      let out = '';
      if (e.stage !== lastStage) {
        out += `\n=== ${e.stage.toUpperCase()} ===\n`;
        lastStage = e.stage;
      }
      out += `[${e.time}] ${e.speaker}:\n  ${e.text}\n`;
      return out;
    }).join('');
  }

  return { addEntry, getPlainTranscript, markRecordingStart, markChapter, getChapters, noteTabSwitch, noteReturn, noteFocusLoss };
})();
