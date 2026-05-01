import { getData, getConfigStatus } from '../api.js';

export function render() {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  return `
    <div class="page-header">
      <div class="flex-between">
        <div>
          <div class="page-title">Welcome back</div>
          <div class="page-subtitle" id="home-subtitle">${today}</div>
        </div>
      </div>
    </div>

    <div class="stats-row" id="home-stats">
      <div class="stat-card">
        <div class="stat-value" id="stat-jira">—</div>
        <div class="stat-label">JIRA Status</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="stat-queries">—</div>
        <div class="stat-label">Saved JIRA Queries</div>
      </div>
    </div>

    <div class="card" style="padding: 0; overflow: hidden;">
      <div class="card-header" style="padding: 16px 20px 0;">
        <div class="card-title">Claude Usage</div>
        <a href="http://localhost:8080" target="_blank" class="btn btn-sm btn-secondary">Open in new tab</a>
      </div>
      <div id="claude-usage-status-bar" style="padding: 4px 20px 12px; font-size: 12px; color: var(--text-muted);"></div>
      <div id="claude-usage-fallback" class="empty-state" style="display: none;"></div>
      <iframe id="claude-usage-frame" src="http://localhost:8080" style="width: 100%; height: 640px; border: none; display: none;"></iframe>
    </div>
  `;
}

export async function init() {
  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  });

  const [configStatus, queries, ping, usageStatus, config] = await Promise.all([
    getConfigStatus().catch(() => ({ jiraConfigured: false })),
    getData('jql-queries').catch(() => []),
    fetch('/api/claude-usage/ping').then(r => r.json()).catch(() => ({ running: false })),
    fetch('/api/claude-usage/status').then(r => r.json()).catch(() => ({ lastChecked: null, status: 'unknown', message: '', repoFound: null, lastError: null })),
    fetch('/api/config').then(r => r.json()).catch(() => ({ orgSubtitle: '' })),
  ]);

  if (config.orgSubtitle) {
    document.getElementById('home-subtitle').textContent = `${config.orgSubtitle} · ${today}`;
  }

  const statJira = document.getElementById('stat-jira');
  if (configStatus.jiraConfigured) {
    statJira.innerHTML = '<span class="badge badge-green">Connected</span>';
  } else {
    statJira.innerHTML = '<span class="badge badge-orange">Not set up</span>';
  }

  document.getElementById('stat-queries').textContent = (queries || []).length;

  const frame = document.getElementById('claude-usage-frame');
  const fallback = document.getElementById('claude-usage-fallback');
  const statusBar = document.getElementById('claude-usage-status-bar');

  if (ping.running) {
    frame.style.display = 'block';
  } else if (!usageStatus.repoFound) {
    fallback.innerHTML = `
      <div class="empty-state-title">claude-usage repo not set up</div>
      <div class="empty-state-desc">This is an optional external dependency. Clone it alongside this repo to enable the Claude usage widget.</div>
      <pre style="text-align:left;background:var(--bg);padding:8px 12px;border-radius:4px;font-size:12px;margin:8px 0;">git clone https://github.com/phuryn/claude-usage ../claude-usage</pre>
      <div class="empty-state-desc">No pip install needed &mdash; stdlib only. Restart the server after cloning.</div>
      <a href="https://github.com/phuryn/claude-usage" target="_blank" class="btn btn-sm btn-secondary" style="margin-top:8px;">View on GitHub</a>
    `;
    fallback.style.display = 'block';
  } else {
    let html = `
      <div class="empty-state-title">Claude usage server is not running</div>
      <div class="empty-state-desc">Restart the Command Center server &mdash; it will auto-start the Python process.</div>
    `;
    if (usageStatus.lastError) {
      html += `<pre style="text-align:left;background:var(--bg);padding:8px 12px;border-radius:4px;font-size:11px;white-space:pre-wrap;max-width:600px;margin:8px auto;">${escapeHtml(usageStatus.lastError)}</pre>`;
    }
    fallback.innerHTML = html;
    fallback.style.display = 'block';
  }

  if (usageStatus.lastChecked) {
    const checked = new Date(usageStatus.lastChecked).toLocaleString('en-US', {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    });
    statusBar.textContent = `${usageStatus.message} · Last checked ${checked}`;
  }
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
