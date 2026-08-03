/**
 * ReportManager — builds the interview transcript in-browser so it can be
 * sent to the server for report generation. The rendered report itself is
 * never shown here — see /admin for reviewing completed interviews.
 */
const ReportManager = (() => {
  const entries = []; // { speaker, text, stage, time }

  function addEntry(speaker, text, stage) {
    entries.push({
      speaker,
      text: text.trim(),
      stage,
      time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
    });
  }

  function getPlainTranscript() {
    let lastStage = '';
    return entries.map(e => {
      let out = '';
      if (e.stage !== lastStage) {
        out += `\n=== ${e.stage.toUpperCase()} ===\n`;
        lastStage = e.stage;
      }
      out += `[${e.time}] ${e.speaker}:\n  ${e.text}\n`;
      return out;
    }).join('');
  }

  return { addEntry, getPlainTranscript };
})();
