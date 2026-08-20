/**
 * store.js — persists completed interview reports to disk so they survive
 * past the browser session and can only be read back through the
 * password-protected admin API (see server.js), never by the candidate.
 *
 * The storage path is configurable via REPORTS_DATA_DIR so it can point at a
 * mounted persistent disk in production — most hosts (Render included) wipe
 * the default app directory on every redeploy/restart, which would silently
 * delete every past report otherwise.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.REPORTS_DATA_DIR
  ? path.resolve(process.env.REPORTS_DATA_DIR)
  : path.join(__dirname, 'data', 'reports');
fs.mkdirSync(DATA_DIR, { recursive: true });

if (!process.env.REPORTS_DATA_DIR) {
  console.warn(`\n⚠️  REPORTS_DATA_DIR is not set — reports are stored at ${DATA_DIR}.`);
  console.warn('   On most hosts (Render included) this directory is WIPED on every redeploy/restart.');
  console.warn('   Attach a persistent disk and set REPORTS_DATA_DIR to its mount path to keep reports.\n');
}

const ID_RE = /^[0-9a-f-]+$/i;

function saveReport({ teacherName, subject, problemScore, transcript, report }) {
  const id = crypto.randomUUID();
  const record = {
    id,
    createdAt: new Date().toISOString(),
    teacherName,
    subject,
    problemScore,
    transcript,
    report
  };
  fs.writeFileSync(path.join(DATA_DIR, `${id}.json`), JSON.stringify(record, null, 2));
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
        conductFlagged: record.report?.conductFlagged ?? false
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

module.exports = { saveReport, listReports, getReport };
