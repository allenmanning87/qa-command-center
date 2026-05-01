import { getConfigStatus } from './api.js';

// ── Route → View module map ───────────────────────────────────────────────────
const routes = {
  'home':   () => import('./views/home.js'),
  'time':   () => import('./views/time-tracker.js'),
  'kanban': () => import('./views/kanban.js'),
  'jira':   () => import('./views/jira-metrics.js'),
};

// ── Router ────────────────────────────────────────────────────────────────────
function getView() {
  const hash = location.hash.replace('#', '') || 'home';
  return routes[hash] ? hash : 'home';
}

async function navigate() {
  const view = getView();
  setActiveNav(view);

  const content = document.getElementById('content');
  content.innerHTML = '<div class="loading-state">Loading...</div>';

  try {
    const module = await routes[view]();
    content.innerHTML = module.render();
    if (module.init) await module.init();
  } catch (err) {
    content.innerHTML = `<div class="alert alert-error">Failed to load view: ${err.message}</div>`;
    console.error(err);
  }
}

function setActiveNav(view) {
  document.querySelectorAll('.tab-link').forEach(link => {
    const isActive = link.dataset.view === view;
    link.classList.toggle('active', isActive);
  });
}

// ── JIRA status indicator + token expiry banner ───────────────────────────────
async function updateJiraStatus() {
  const dot  = document.getElementById('jira-status-indicator');
  const text = document.getElementById('jira-status-text');
  try {
    const status = await getConfigStatus();
    if (status.jiraConfigured) {
      dot.className  = 'status-dot status-ok';
      text.textContent = `JIRA: Connected`;
      text.title       = status.jiraBaseUrl;
    } else {
      dot.className  = 'status-dot status-warn';
      text.textContent = 'JIRA: Not configured';
      text.title       = 'Check your .env file';
    }
    checkTokenExpiry(status.jiraTokenExpires);
  } catch {
    dot.className    = 'status-dot status-error';
    text.textContent = 'JIRA: Server error';
  }
}

function checkTokenExpiry(expiresStr) {
  if (!expiresStr) return;

  const banner = document.getElementById('token-banner');
  const msg    = document.getElementById('token-banner-msg');

  const expires  = new Date(expiresStr);
  const today    = new Date();
  today.setHours(0, 0, 0, 0);
  expires.setHours(0, 0, 0, 0);

  const daysLeft = Math.round((expires - today) / (1000 * 60 * 60 * 24));

  if (daysLeft <= 0) {
    banner.className = 'token-banner token-banner-error';
    msg.textContent = `Your JIRA API token expired on ${expiresStr}. Generate a new one at id.atlassian.com and update your .env file.`;
    banner.style.display = 'flex';
  } else if (daysLeft === 1) {
    banner.className = 'token-banner token-banner-warn';
    msg.textContent = `Your JIRA API token expires tomorrow (${expiresStr}). Generate a new one today at id.atlassian.com and update your .env file.`;
    banner.style.display = 'flex';
  }
  // More than 1 day away — stay hidden
}

// ── Theme ─────────────────────────────────────────────────────────────────────

function applyTheme(isDark) {
  document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
  const btn = document.getElementById('btn-theme-toggle');
  if (btn) btn.textContent = isDark ? 'Light' : 'Dark';
  if (typeof Chart !== 'undefined') {
    Chart.defaults.color       = isDark ? '#8b949e' : '#6b7280';
    Chart.defaults.borderColor = isDark ? '#30363d' : '#e5e7eb';
  }
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('acc-theme'); } catch {}
  applyTheme(saved === 'dark');
}

function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  try { localStorage.setItem('acc-theme', isDark ? 'light' : 'dark'); } catch {}
  applyTheme(!isDark);
}

// ── Init ──────────────────────────────────────────────────────────────────────
initTheme();   // apply before first render to prevent flash
window.addEventListener('hashchange', navigate);
navigate();
updateJiraStatus();
document.getElementById('btn-theme-toggle')?.addEventListener('click', toggleTheme);
