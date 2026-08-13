/**
 * admin.js — login + dashboard for reviewing completed interview reports.
 * All data comes from the password-protected /api/admin/* endpoints.
 */
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function getScoreColor(score) {
  if (score >= 80) return '#10b981';
  if (score >= 65) return '#4f86f7';
  if (score >= 50) return '#f59e0b';
  return '#ef4444';
}

function getRecommendationStyle(rec) {
  const map = {
    'Highly Recommended': { bg: '#10b98122', border: '#10b981', color: '#10b981' },
    'Recommended':        { bg: '#4f86f722', border: '#4f86f7', color: '#4f86f7' },
    'Needs Improvement':  { bg: '#f59e0b22', border: '#f59e0b', color: '#f59e0b' },
    'Not Recommended':    { bg: '#ef444422', border: '#ef4444', color: '#ef4444' },
  };
  return map[rec] || map['Recommended'];
}

const Admin = {
  async init() {
    document.getElementById('login-form').addEventListener('submit', e => { e.preventDefault(); this.login(); });
    document.getElementById('logout-btn').addEventListener('click', () => this.logout());
    document.getElementById('back-link').addEventListener('click', () => this.showList());

    const res = await fetch('/api/admin/session');
    const { isAdmin } = await res.json();
    if (isAdmin) this.showDashboard();
    else this.showLogin();
  },

  showLogin() {
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('dashboard-screen').classList.add('hidden');
  },

  showDashboard() {
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('dashboard-screen').classList.remove('hidden');
    this.showList();
  },

  async login() {
    const input = document.getElementById('admin-password');
    const btn = document.getElementById('login-btn');
    const errEl = document.getElementById('login-error');

    btn.disabled = true;
    errEl.textContent = '';

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: input.value })
      });
      const data = await res.json();

      if (!res.ok) {
        errEl.textContent = data.error || 'Login failed';
        input.classList.add('error');
        setTimeout(() => input.classList.remove('error'), 1500);
        return;
      }

      input.value = '';
      this.showDashboard();
    } catch (e) {
      errEl.textContent = 'Connection error — please try again.';
    } finally {
      btn.disabled = false;
    }
  },

  async logout() {
    await fetch('/api/admin/logout', { method: 'POST' });
    this.showLogin();
  },

  showList() {
    document.getElementById('list-view').classList.remove('hidden');
    document.getElementById('detail-view').classList.add('hidden');
    this.loadReports();
  },

  async loadReports() {
    const res = await fetch('/api/admin/reports');
    if (res.status === 401) { this.showLogin(); return; }

    const reports = await res.json();
    const tbody = document.getElementById('reports-tbody');
    const empty = document.getElementById('reports-empty');

    if (!reports.length) {
      tbody.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    tbody.innerHTML = reports.map(r => {
      const rec = r.recommendation || '—';
      const recStyle = getRecommendationStyle(rec);
      const date = new Date(r.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
      return `
        <tr data-id="${escapeHtml(r.id)}">
          <td>${escapeHtml(r.teacherName)} ${r.conductFlagged ? '<span class="conduct-flag-badge" title="Conduct flagged during this interview">⚠️ Flagged</span>' : ''}</td>
          <td>${escapeHtml(r.subject)}</td>
          <td>${date}</td>
          <td style="color:${getScoreColor(r.overallScore || 0)}; font-weight:700;">${r.overallScore ?? '—'}</td>
          <td><span class="rec-badge" style="background:${recStyle.bg};border-color:${recStyle.border};color:${recStyle.color}">${escapeHtml(rec)}</span></td>
        </tr>`;
    }).join('');

    tbody.querySelectorAll('tr').forEach(row => {
      row.addEventListener('click', () => this.viewReport(row.dataset.id));
    });
  },

  async viewReport(id) {
    const res = await fetch(`/api/admin/reports/${encodeURIComponent(id)}`);
    if (res.status === 401) { this.showLogin(); return; }
    if (!res.ok) return;

    const record = await res.json();
    document.getElementById('list-view').classList.add('hidden');
    document.getElementById('detail-view').classList.remove('hidden');
    this.renderReport(record);
  },

  renderReport(record) {
    const container = document.getElementById('report-container');
    const { teacherName, subject, problemScore, createdAt, transcript, recordingId = null, recordingExt = null, report = {} } = record;
    const { overallScore = 0, summary = '', recommendation = 'Recommended', categories = [], strengths = [], improvements = [], engagementNotes = null, conductFlagged = false, misconductCount = 0 } = report;

    const recStyle = getRecommendationStyle(recommendation);
    const date = new Date(createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

    const C = 2 * Math.PI * 54;
    const offset = C * (1 - (overallScore || 0) / 100);

    const catCards = categories.map(cat => `
      <div class="cat-card">
        <div class="cat-header">
          <span class="cat-name">${escapeHtml(cat.name)}</span>
          <span class="cat-score" style="color:${getScoreColor(cat.score)}">${cat.score}%</span>
        </div>
        <div class="cat-bar-track">
          <div class="cat-bar-fill" style="width:${cat.score}%;background:${getScoreColor(cat.score)}"></div>
        </div>
        <p class="cat-feedback">${escapeHtml(cat.feedback)}</p>
      </div>`).join('');

    const strengthItems = strengths.map(s => `<li>${escapeHtml(s)}</li>`).join('');
    const improveItems  = improvements.map(i => `<li>${escapeHtml(i)}</li>`).join('');

    container.innerHTML = `
      ${conductFlagged ? `
      <div class="conduct-flag-banner">
        ⚠️ <strong>Conduct flagged</strong> — this interview was ended early after ${misconductCount} incident(s)
        of abusive/inappropriate language or triggering responses, despite warnings.
      </div>` : ''}

      <div class="report-hero">
        <div>
          <h2 class="report-name">${escapeHtml(teacherName)}</h2>
          <p class="report-meta">${escapeHtml(subject)} · ${date}</p>
        </div>
        <div class="rec-badge" style="background:${recStyle.bg};border-color:${recStyle.border};color:${recStyle.color}">
          ${escapeHtml(recommendation)}
        </div>
      </div>

      <div class="report-top-row">
        <div class="overall-card">
          <svg class="score-ring" viewBox="0 0 120 120">
            <defs>
              <linearGradient id="rg" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#4f86f7"/>
                <stop offset="100%" stop-color="#a855f7"/>
              </linearGradient>
            </defs>
            <circle cx="60" cy="60" r="54" stroke="rgba(255,255,255,0.07)" stroke-width="10" fill="none"/>
            <circle cx="60" cy="60" r="54" stroke="url(#rg)" stroke-width="10" fill="none"
              stroke-dasharray="${C.toFixed(2)}" stroke-dashoffset="${offset.toFixed(2)}"
              stroke-linecap="round" transform="rotate(-90 60 60)"/>
          </svg>
          <div class="score-inner">
            <span class="score-big">${overallScore}</span>
            <span class="score-slash">/100</span>
          </div>
          <p class="score-label">Overall Score</p>
          <p class="prob-pill">Problem Solving: <strong>${problemScore}/10</strong></p>
        </div>

        <div class="summary-card">
          <h4>Interview Summary</h4>
          <p>${escapeHtml(summary)}</p>
          <div class="si-list">
            <div class="si-col">
              <h5>✅ Strengths</h5>
              <ul>${strengthItems}</ul>
            </div>
            <div class="si-col">
              <h5>📈 Improve</h5>
              <ul>${improveItems}</ul>
            </div>
          </div>
          ${engagementNotes ? `<p class="engagement-note"><strong>🎥 Engagement note (from periodic camera snapshots):</strong> ${escapeHtml(engagementNotes)}</p>` : ''}
        </div>
      </div>

      <div class="cats-grid">
        ${catCards}
      </div>

      ${recordingId ? `
      <div class="transcript-section">
        <div class="transcript-header">
          <h4>🎥 Interview Recording</h4>
          <a class="btn-secondary" href="/api/admin/recordings/${encodeURIComponent(recordingId)}"
             download="interview-${encodeURIComponent(teacherName || 'candidate')}.${recordingExt || 'webm'}">⬇ Download Recording</a>
        </div>
        <video controls preload="metadata"
               src="/api/admin/recordings/${encodeURIComponent(recordingId)}"
               style="width:100%;max-height:420px;border-radius:12px;background:#000;margin-top:10px;">
        </video>
      </div>` : ''}

      <div class="transcript-section">
        <div class="transcript-header">
          <h4>Full Interview Transcript</h4>
          <button class="btn-secondary" onclick="window.print()">🖨 Print Report</button>
        </div>
        <div class="transcript-body">
          <pre style="white-space:pre-wrap;font-family:inherit;font-size:13px;color:var(--text-primary);line-height:1.7;">${escapeHtml(transcript)}</pre>
        </div>
      </div>
    `;
  }
};

Admin.init();
