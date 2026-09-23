/**
 * admin.js — login + dashboard for reviewing completed interview reports.
 * All data comes from the password-protected /api/admin/* endpoints.
 */
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function fmtScore(score) {
  const n = Number(score);
  return Number.isFinite(n) ? n.toFixed(1) : '—';
}

function fmtTime(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
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
  _allReports: [], // full unfiltered list from the last /api/admin/reports fetch

  async init() {
    document.getElementById('login-form').addEventListener('submit', e => { e.preventDefault(); this.login(); });
    document.getElementById('logout-btn').addEventListener('click', () => this.logout());
    document.getElementById('back-link').addEventListener('click', () => this.showList());
    document.getElementById('errors-back-link').addEventListener('click', () => this.showList());
    document.getElementById('show-errors-btn').addEventListener('click', () => this.showErrors());
    document.getElementById('stats-back-link').addEventListener('click', () => this.showList());
    document.getElementById('show-stats-btn').addEventListener('click', () => this.showStats());

    document.getElementById('search-input').addEventListener('input', () => this.renderReports());
    document.getElementById('subject-filter').addEventListener('change', () => this.renderReports());
    document.getElementById('date-from').addEventListener('change', () => this.renderReports());
    document.getElementById('date-to').addEventListener('change', () => this.renderReports());
    document.getElementById('clear-filters-btn').addEventListener('click', () => this.clearFilters());

    const res = await fetch('/api/admin/session');
    const { isAdmin } = await res.json();
    if (isAdmin) this.showDashboard();
    else this.showLogin();
  },

  clearFilters() {
    document.getElementById('search-input').value = '';
    document.getElementById('subject-filter').value = '';
    document.getElementById('date-from').value = '';
    document.getElementById('date-to').value = '';
    this.renderReports();
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

  async deleteReport(id) {
    try {
      const res = await fetch(`/api/admin/reports/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      });

      if (res.status === 401) {
        this.showLogin();
        return;
      }

      if (!res.ok) {
        alert('Failed to delete report');
        return;
      }

      alert('Report deleted successfully');
      this.loadReports(); // Reload the list
    } catch (e) {
      alert('Error deleting report: ' + e.message);
    }
  },

  showList() {
    document.getElementById('list-view').classList.remove('hidden');
    document.getElementById('detail-view').classList.add('hidden');
    document.getElementById('errors-view').classList.add('hidden');
    document.getElementById('stats-view').classList.add('hidden');
    this.loadReports();
  },

  async showErrors() {
    document.getElementById('list-view').classList.add('hidden');
    document.getElementById('detail-view').classList.add('hidden');
    document.getElementById('stats-view').classList.add('hidden');
    document.getElementById('errors-view').classList.remove('hidden');

    const res = await fetch('/api/admin/client-errors');
    if (res.status === 401) { this.showLogin(); return; }

    const errors = await res.json();
    this.renderErrors(errors);
  },

  // Stats are computed from the full unfiltered report list (a fresh fetch,
  // not just whatever the table's current search/filter happens to show).
  async showStats() {
    document.getElementById('list-view').classList.add('hidden');
    document.getElementById('detail-view').classList.add('hidden');
    document.getElementById('errors-view').classList.add('hidden');
    document.getElementById('stats-view').classList.remove('hidden');

    const res = await fetch('/api/admin/reports');
    if (res.status === 401) { this.showLogin(); return; }

    this._allReports = await res.json();
    this.renderStats(this._allReports);
  },

  renderStats(reports) {
    const container = document.getElementById('stats-container');
    const total = reports.length;
    const incomplete = reports.filter(r => r.interrupted).length;
    const withVideo = reports.filter(r => r.hasVideo).length;

    const RECOMMENDATIONS = ['Highly Recommended', 'Recommended', 'Needs Improvement', 'Not Recommended'];
    const byRec = new Map(RECOMMENDATIONS.map(rec => [rec, 0]));
    reports.forEach(r => {
      if (r.interrupted) return; // incomplete attempts aren't a real recommendation
      byRec.set(r.recommendation, (byRec.get(r.recommendation) || 0) + 1);
    });

    const statCard = (label, value) => `
      <div class="stat-card">
        <span class="stat-value">${value}</span>
        <span class="stat-label">${escapeHtml(label)}</span>
      </div>`;

    const recRow = (rec, count) => {
      const style = getRecommendationStyle(rec);
      return `
        <div class="stat-rec-row">
          <span class="rec-badge" style="background:${style.bg};border-color:${style.border};color:${style.color}">${escapeHtml(rec)}</span>
          <span class="stat-rec-count">${count}</span>
        </div>`;
    };

    container.innerHTML = `
      <div class="stats-grid">
        ${statCard('Total interviews conducted', total)}
        ${statCard('With video recording', withVideo)}
        ${statCard('Completed', total - incomplete)}
        ${statCard('Incomplete / failed', incomplete)}
      </div>
      <div class="stats-rec-section">
        <h4>Recommendation breakdown (completed interviews)</h4>
        ${RECOMMENDATIONS.map(rec => recRow(rec, byRec.get(rec))).join('')}
      </div>
    `;
  },

  renderErrors(errors) {
    const tbody = document.getElementById('errors-tbody');
    const empty = document.getElementById('errors-empty');

    if (!errors.length) {
      tbody.innerHTML = '';
      empty.classList.remove('hidden');
      return;
    }
    empty.classList.add('hidden');

    tbody.innerHTML = errors.map(e => {
      const time = new Date(e.loggedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
      const contactLine = [e.candidatePhone, e.candidateEmail].filter(Boolean).join(' · ');
      return `
        <tr>
          <td><small>${time}</small></td>
          <td>
            ${escapeHtml(e.teacherName || '—')}
            ${contactLine ? `<div class="candidate-contact">${escapeHtml(contactLine)}</div>` : ''}
          </td>
          <td>${escapeHtml(e.context || '—')}</td>
          <td><code>${escapeHtml(e.errorName || 'Unknown')}</code>${e.errorMessage ? `<div class="candidate-contact">${escapeHtml(e.errorMessage)}</div>` : ''}</td>
          <td><small title="${escapeHtml(e.userAgent || '')}">${escapeHtml((e.userAgent || '—').slice(0, 40))}</small></td>
        </tr>`;
    }).join('');
  },

  async loadReports() {
    const res = await fetch('/api/admin/reports');
    if (res.status === 401) { this.showLogin(); return; }

    this._allReports = await res.json();
    this.renderReports();
  },

  // Applies the search box + subject/date filters to the last-fetched list and
  // re-renders the table. Called on load and on every filter control change —
  // the full list already lives in memory (see loadReports), so this stays a
  // pure client-side filter rather than a server round-trip.
  renderReports() {
    const tbody = document.getElementById('reports-tbody');
    const empty = document.getElementById('reports-empty');
    const noMatch = document.getElementById('reports-no-match');

    if (!this._allReports.length) {
      tbody.innerHTML = '';
      empty.classList.remove('hidden');
      noMatch.classList.add('hidden');
      return;
    }
    empty.classList.add('hidden');

    const query = document.getElementById('search-input').value.trim().toLowerCase();
    const subjectFilter = document.getElementById('subject-filter').value;
    const dateFromStr = document.getElementById('date-from').value; // yyyy-mm-dd or ''
    const dateToStr = document.getElementById('date-to').value;
    const dateFrom = dateFromStr ? new Date(`${dateFromStr}T00:00:00`) : null;
    const dateTo = dateToStr ? new Date(`${dateToStr}T23:59:59.999`) : null;

    const reports = this._allReports.filter(r => {
      if (subjectFilter && r.subject !== subjectFilter) return false;

      const created = new Date(r.createdAt);
      if (dateFrom && created < dateFrom) return false;
      if (dateTo && created > dateTo) return false;

      if (query) {
        const haystack = [r.teacherName, r.candidatePhone, r.candidateEmail].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(query)) return false;
      }

      return true;
    });

    if (!reports.length) {
      tbody.innerHTML = '';
      noMatch.classList.remove('hidden');
      return;
    }
    noMatch.classList.add('hidden');

    tbody.innerHTML = reports.map(r => {
      const rec = r.recommendation || '—';
      const recStyle = getRecommendationStyle(rec);
      const date = new Date(r.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
      const interruptedBadge = r.interrupted ? '<span class="interrupted-badge" title="Interview was interrupted (refresh, network, or exit)">⏸️ Incomplete</span>' : '';
      const stageLabel = r.interrupted && r.interruptedAt !== undefined ? {0: 'Wellbeing', 1: 'Resume Q&A', 2: 'Problem Solving', 3: 'Wrap-up'}[r.interruptedAt] || 'Unknown' : '';
      const stageText = r.interrupted && stageLabel ? ` (stopped at: ${stageLabel})` : '';
      const repeatContact = r.candidateEmail || r.candidatePhone || '';
      const repeatBadge = r.priorAttempts > 0
        ? `<span class="repeat-badge" data-repeat-contact="${escapeHtml(repeatContact)}" title="Same email or phone appears on ${r.priorAttempts} other interview(s) — click to see them all">🔁 Repeat (${r.priorAttempts + 1}x)</span>`
        : '';
      const contactLine = [r.candidatePhone, r.candidateEmail].filter(Boolean).join(' · ');
      return `
        <tr data-id="${escapeHtml(r.id)}" style="${r.interrupted ? 'opacity: 0.85; background-color: rgba(250,204,21,0.05);' : ''}">
          <td class="clickable-cell">
            ${escapeHtml(r.teacherName)}
            ${r.conductFlagged ? '<span class="conduct-flag-badge" title="Conduct flagged during this interview">⚠️ Flagged</span>' : ''}
            ${interruptedBadge}
            ${repeatBadge}
            ${contactLine ? `<div class="candidate-contact">${escapeHtml(contactLine)}</div>` : ''}
          </td>
          <td class="clickable-cell">${escapeHtml(r.subject)}</td>
          <td class="clickable-cell"><small>${date}${stageText}</small></td>
          <td class="clickable-cell" style="color:${getScoreColor(r.overallScore || 0)}; font-weight:700;">${r.overallScore != null ? fmtScore(r.overallScore) : '—'}</td>
          <td class="clickable-cell"><span class="rec-badge" style="background:${recStyle.bg};border-color:${recStyle.border};color:${recStyle.color}">${escapeHtml(rec)}</span></td>
          <td class="action-cell" onclick="event.stopPropagation()"><button class="btn-delete" data-id="${escapeHtml(r.id)}" title="Delete this report">🗑️ Delete</button></td>
        </tr>`;
    }).join('');

    tbody.querySelectorAll('tr').forEach(row => {
      // Click anywhere in the row except the action cell to view details
      row.querySelectorAll('.clickable-cell').forEach(cell => {
        cell.addEventListener('click', () => this.viewReport(row.dataset.id));
      });

      // Repeat-candidate badge: filter the list down to this candidate's
      // other attempts instead of opening the row's own report.
      const repeatBadge = row.querySelector('.repeat-badge');
      if (repeatBadge) {
        repeatBadge.addEventListener('click', (e) => {
          e.stopPropagation();
          document.getElementById('search-input').value = repeatBadge.dataset.repeatContact;
          this.renderReports();
        });
      }

      // Delete button click handler
      row.querySelector('.btn-delete').addEventListener('click', async (e) => {
        const id = row.dataset.id;
        if (confirm(`Are you sure you want to delete the report for ${row.dataset.name || 'this candidate'}? This cannot be undone.`)) {
          await this.deleteReport(id);
        }
      });
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

  seekVideo(seconds) {
    const video = document.getElementById('report-video');
    if (!video) return;
    video.currentTime = seconds;
    video.play().catch(() => {}); // autoplay can be blocked; seeking still worked either way
  },

  renderReport(record) {
    const container = document.getElementById('report-container');
    const { teacherName, candidatePhone = null, candidateEmail = null, subject, problemScore, createdAt, transcript, recordingId = null, recordingExt = null, chapters = [], report = {}, repeatAttempts = [] } = record;
    const { overallScore = 0, summary = '', recommendation = 'Recommended', categories = [], strengths = [], improvements = [], engagementNotes = null, conductFlagged = false, misconductCount = 0 } = report;

    const recStyle = getRecommendationStyle(recommendation);
    const date = new Date(createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

    const C = 2 * Math.PI * 54;
    const offset = C * (1 - (overallScore || 0) / 100);

    const catCards = categories.map(cat => `
      <div class="cat-card">
        <div class="cat-header">
          <span class="cat-name">${escapeHtml(cat.name)}</span>
          <span class="cat-score" style="color:${getScoreColor(cat.score)}">${fmtScore(cat.score)}%</span>
        </div>
        <div class="cat-bar-track">
          <div class="cat-bar-fill" style="width:${cat.score}%;background:${getScoreColor(cat.score)}"></div>
        </div>
        <p class="cat-feedback">${escapeHtml(cat.feedback)}</p>
      </div>`).join('');

    const strengthItems = strengths.map(s => `<li>${escapeHtml(s)}</li>`).join('');
    const improveItems  = improvements.map(i => `<li>${escapeHtml(i)}</li>`).join('');

    const repeatItems = repeatAttempts.map(a => {
      const aDate = new Date(a.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
      return `
        <li class="repeat-attempt-item" data-id="${escapeHtml(a.id)}">
          <span>${aDate} · ${escapeHtml(a.subject)}${a.interrupted ? ' (incomplete)' : ''}</span>
          <span style="color:${getScoreColor(a.overallScore || 0)}; font-weight:700;">${a.overallScore != null ? fmtScore(a.overallScore) + '/100' : '—'}</span>
        </li>`;
    }).join('');

    container.innerHTML = `
      ${conductFlagged ? `
      <div class="conduct-flag-banner">
        ⚠️ <strong>Conduct flagged</strong> — this interview was ended early after ${misconductCount} incident(s)
        of abusive/inappropriate language or triggering responses, despite warnings.
      </div>` : ''}

      ${repeatAttempts.length ? `
      <div class="repeat-banner">
        🔁 <strong>Repeat candidate</strong> — the same email or phone appears on ${repeatAttempts.length} other interview${repeatAttempts.length > 1 ? 's' : ''}:
        <ul class="repeat-attempt-list">${repeatItems}</ul>
      </div>` : ''}

      <div class="report-hero">
        <div>
          <h2 class="report-name">${escapeHtml(teacherName)}</h2>
          <p class="report-meta">${escapeHtml(subject)} · ${date}</p>
          ${(candidatePhone || candidateEmail) ? `<p class="report-meta">${[candidatePhone, candidateEmail].filter(Boolean).map(escapeHtml).join(' · ')}</p>` : ''}
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
            <span class="score-big">${fmtScore(overallScore)}</span>
            <span class="score-slash">/100</span>
          </div>
          <p class="score-label">Overall Score</p>
          <p class="prob-pill">Problem Solving: <strong>${fmtScore(problemScore)}/10</strong></p>
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
        <video id="report-video" controls preload="metadata"
               src="/api/admin/recordings/${encodeURIComponent(recordingId)}"
               style="width:100%;max-height:420px;border-radius:12px;background:#000;margin-top:10px;">
        </video>
        ${chapters.length ? `
        <div class="chapter-chips">
          ${chapters.map(c => `
            <button type="button" class="chapter-chip" onclick="Admin.seekVideo(${Number(c.seconds) || 0})">
              <span class="chapter-chip-time">${fmtTime(c.seconds)}</span>
              <span class="chapter-chip-label">${escapeHtml(c.label)}</span>
            </button>`).join('')}
        </div>` : ''}
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

    container.querySelectorAll('.repeat-attempt-item').forEach(item => {
      item.addEventListener('click', () => this.viewReport(item.dataset.id));
    });
  }
};

Admin.init();
