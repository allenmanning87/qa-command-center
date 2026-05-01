require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');

const db = new Database(path.join(DATA_DIR, 'app.db'));
// Add new tables here as CREATE TABLE IF NOT EXISTS — runs on every startup, safe for existing DBs.
// Column additions: ALTER TABLE ... ADD COLUMN ... guarded by a column-existence check.
db.exec(`CREATE TABLE IF NOT EXISTS collections (name TEXT PRIMARY KEY, data TEXT NOT NULL)`);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── JIRA Proxy ────────────────────────────────────────────────────────────────
// Forwards /api/jira/* to your JIRA Cloud instance, injecting auth headers.
// This avoids CORS issues when calling JIRA from a browser.
app.all('/api/jira/*', async (req, res) => {
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;

  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    return res.status(503).json({
      error: 'JIRA not configured. Copy .env.example to .env and fill in your credentials.',
    });
  }

  const jiraPath = req.path.replace('/api/jira', '');
  const url = `${JIRA_BASE_URL}/rest/api/3${jiraPath}`;
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');

  try {
    const response = await axios({
      method: req.method,
      url,
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      params: req.query,
      data: req.body,
    });
    res.json(response.data);
  } catch (err) {
    const status = err.response?.status || 500;
    const message =
      err.response?.data?.errorMessages?.[0] ||
      err.response?.data?.message ||
      err.message;
    res.status(status).json({ error: message });
  }
});

// ── Local Data Storage ────────────────────────────────────────────────────────
// SQLite-backed persistence. Each "collection" is a row in the collections table.
// GET returns the parsed JSON (null if the collection doesn't exist).
// PUT replaces the row entirely.
app.get('/api/data/:collection', (req, res) => {
  try {
    const row = db.prepare('SELECT data FROM collections WHERE name = ?').get(req.params.collection);
    res.json(row ? JSON.parse(row.data) : null);
  } catch {
    res.json(null);
  }
});

app.put('/api/data/:collection', (req, res) => {
  try {
    db.prepare('INSERT OR REPLACE INTO collections (name, data) VALUES (?, ?)').run(req.params.collection, JSON.stringify(req.body));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Config ────────────────────────────────────────────────────────────────────
app.get('/api/config', (req, res) => {
  res.json({ orgSubtitle: process.env.ORG_SUBTITLE || '' });
});

// ── Config Status ─────────────────────────────────────────────────────────────
app.get('/api/config/status', (req, res) => {
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_TOKEN_EXPIRES } = process.env;
  res.json({
    jiraConfigured: !!(JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN),
    jiraBaseUrl: JIRA_BASE_URL || null,
    jiraTokenExpires: JIRA_TOKEN_EXPIRES || null,
  });
});

// ── JIRA Connection Test ──────────────────────────────────────────────────────
// Calls /rest/api/3/myself to verify credentials actually work.
app.get('/api/jira-test', async (req, res) => {
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    return res.status(503).json({ error: 'JIRA not configured in .env' });
  }
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
  try {
    const response = await axios.get(`${JIRA_BASE_URL}/rest/api/3/myself`, {
      headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    });
    res.json({ ok: true, user: response.data });
  } catch (err) {
    const status = err.response?.status || 500;
    const detail = JSON.stringify(err.response?.data || err.message);
    res.status(status).json({ ok: false, status, detail });
  }
});

// ── Claude Usage Auto-Update ──────────────────────────────────────────────────
const CLAUDE_USAGE_DIR = path.join(__dirname, '..', 'claude-usage');

let claudeUsageProcess = null;
let claudeUsageStatus = { lastChecked: null, status: 'unknown', message: 'Not yet checked', lastError: null };

function startPythonServer() {
  if (claudeUsageProcess) {
    claudeUsageProcess.kill();
    claudeUsageProcess = null;
  }
  const startScript = 'import sys; sys.path.insert(0,"."); from cli import cmd_scan; from dashboard import serve; cmd_scan(); serve()';
  claudeUsageProcess = spawn('python', ['-c', startScript], {
    cwd: CLAUDE_USAGE_DIR,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, PORT: '8080' },
  });
  let stderrLines = [];
  claudeUsageProcess.stderr.on('data', (data) => {
    const lines = data.toString().split('\n').filter(l => l.trim());
    stderrLines = [...stderrLines, ...lines].slice(-20);
  });
  claudeUsageProcess.on('exit', (code) => {
    claudeUsageProcess = null;
    claudeUsageStatus = {
      ...claudeUsageStatus,
      lastError: code !== 0 && stderrLines.length ? stderrLines.join('\n') : null,
    };
    setTimeout(startPythonServer, 3000);
  });
}

function checkForUpdates(isStartup = false) {
  execFile('git', ['-C', CLAUDE_USAGE_DIR, 'pull'], (err, stdout) => {
    const now = new Date().toISOString();
    if (err) {
      claudeUsageStatus = { lastChecked: now, status: 'error', message: 'git pull failed — see server.log' };
      console.error('[claude-usage] git pull failed:', err.message);
      return;
    }
    if (!stdout.includes('Already up to date')) {
      claudeUsageStatus = { lastChecked: now, status: 'updated', message: 'Updated — restarting' };
      startPythonServer();
    } else {
      claudeUsageStatus = { lastChecked: now, status: 'up-to-date', message: 'Up to date' };
      if (isStartup) startPythonServer();
    }
  });
}

checkForUpdates(true);
setInterval(checkForUpdates, 24 * 60 * 60 * 1000);

app.get('/api/claude-usage/status', (req, res) => {
  res.json({ ...claudeUsageStatus, repoFound: fs.existsSync(CLAUDE_USAGE_DIR) });
});

app.get('/api/claude-usage/ping', async (req, res) => {
  try {
    await axios.get('http://localhost:8080', { timeout: 2000 });
    res.json({ running: true });
  } catch {
    res.json({ running: false });
  }
});

app.listen(PORT, () => {
  console.log(`\nQA Command Center running at http://localhost:${PORT}\n`);
});
