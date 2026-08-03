/**
 * store.js — persists completed interview reports to disk so they survive
 * past the browser session and can only be read back through the
 * password-protected admin API (see server.js), never by the candidate.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data', 'reports');
fs.mkdirSync(DATA_DIR, { recursive: true });

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
        recommendation: record.report?.recommendation ?? null
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
