/**
 * store.js — persists completed interview reports to disk so they survive
 * past the browser session and can only be read back through the
 * password-protected admin API (see server.js), never by the candidate.
 *
 * The storage root is configurable via PERSISTENT_DATA_DIR so it can point at
 * a mounted persistent disk in production — most hosts (Render included) wipe
 * the default app directory on every redeploy/restart, which would silently
 * delete every past report (and, via server.js's RECORDINGS_DIR, every saved
 * interview recording) otherwise.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_ROOT = process.env.PERSISTENT_DATA_DIR
  ? path.resolve(process.env.PERSISTENT_DATA_DIR)
  : path.join(__dirname, 'data');
const DATA_DIR = path.join(DATA_ROOT, 'reports');
fs.mkdirSync(DATA_DIR, { recursive: true });

if (!process.env.PERSISTENT_DATA_DIR) {
  console.warn(`\n⚠️  PERSISTENT_DATA_DIR is not set — reports and recordings are stored under ${DATA_ROOT}.`);
  console.warn('   On most hosts (Render included) this directory is WIPED on every redeploy/restart.');
  console.warn('   Attach a persistent disk and set PERSISTENT_DATA_DIR to its mount path to keep them.\n');
}

const ID_RE = /^[0-9a-f-]+$/i;

// A single interview attempt can legitimately submit a report more than once
// — most commonly the normal-completion beacon from generateReport() racing
// the beforeunload safety-net beacon fired when the candidate closes the
// resulting "thank you" tab, but also any retried fetch fallback. Every
// submission for one attempt carries the same client-generated sessionId, so
// rather than minting a fresh file (and a duplicate admin-dashboard row)
// every time, this upserts: the file is named after the sessionId, and a
// final (non-interrupted) report already on disk is never clobbered by a
// late-arriving interrupted duplicate for that same session.
function saveReport({ sessionId = null, teacherName, subject, problemScore, transcript, report, recordingId = null, recordingExt = null, interrupted = false, chapters = [] }) {
  const id = (typeof sessionId === 'string' && ID_RE.test(sessionId)) ? sessionId : crypto.randomUUID();
  const file = path.join(DATA_DIR, `${id}.json`);

  if (fs.existsSync(file)) {
    try {
      const existing = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (existing.interrupted === false && interrupted) {
        console.log(`[store] Skipped duplicate interrupted report for ${id} (${teacherName}) — final report already on disk`);
        return id;
      }
    } catch {
      // Corrupt existing file — fall through and overwrite it below.
    }
  }

  const record = {
    id,
    createdAt: new Date().toISOString(),
    teacherName,
    subject,
    problemScore,
    transcript,
    report,
    recordingId, // data/recordings/<recordingId>.<recordingExt>, or null if none was captured
    // 'webm' on most browsers, 'mp4' when recorded on iOS Safari (no webm
    // MediaRecorder support there) — null alongside a null recordingId.
    recordingExt,
    interrupted, // true if interview was interrupted/incomplete
    chapters // [{ label, seconds }] video chapter markers for the admin dashboard, or []
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2));
  console.log(`[store] Saved report ${id} for ${teacherName} ${interrupted ? '(INTERRUPTED)' : ''}`);
  return id;
}

function listReports() {
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const record = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      return {
        id: record.id,
        createdAt: record.createdAt,
        teacherName: record.teacherName,
        subject: record.subject,
        overallScore: record.report?.overallScore ?? null,
        recommendation: record.report?.recommendation ?? null,
        conductFlagged: record.report?.conductFlagged ?? false,
        interrupted: record.interrupted ?? false,
        interruptedAt: record.interruptedAt ?? undefined
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getReport(id) {
  if (!ID_RE.test(id)) return null;
  const file = path.join(DATA_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function deleteReport(id) {
  if (!ID_RE.test(id)) return false;
  const file = path.join(DATA_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return false;

  try {
    // Get the report to find recording file if it exists
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));

    // Delete the JSON report file
    fs.unlinkSync(file);
    console.log(`[store] Deleted report: ${id}`);

    // Delete the recording file if it exists
    if (record.recordingId && record.recordingExt) {
      const recordingPath = path.join(DATA_ROOT, 'recordings', `${record.recordingId}.${record.recordingExt}`);
      if (fs.existsSync(recordingPath)) {
        fs.unlinkSync(recordingPath);
        console.log(`[store] Deleted recording: ${record.recordingId}.${record.recordingExt}`);
      }
    }

    return true;
  } catch (e) {
    console.error(`[store] Error deleting report ${id}:`, e.message);
    return false;
  }
}

module.exports = { saveReport, listReports, getReport, deleteReport };
