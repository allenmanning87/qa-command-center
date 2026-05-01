# QA Command Center

A personal QA engineering dashboard and portfolio project. Tracks JIRA metrics, test suite health, AI skill progression, career milestones, employment strategy, and Claude usage — all in a single local web app.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **NVM for Windows** | [github.com/coreybutler/nvm-windows](https://github.com/coreybutler/nvm-windows) — required by the one-click launcher |
| **Node.js v22.22.2** | `nvm install 22.22.2` — version is pinned in `.nvmrc`; `npm start` works with any Node v22.x |
| **Python 3.10+** | Required for the `claude-usage` sibling repo (stdlib only — no pip install). Tested on 3.14.x |
| **Visual Studio Build Tools** | Required by `better-sqlite3` on Windows. Select the "Desktop development with C++" workload. On Linux: `build-essential` |
| **Claude Code CLI** | `npm install -g @anthropic-ai/claude-code` — required for skills/commands integration |
| **Git** | Required by the `new-terminal` scripts and the claude-usage auto-update |

---

## External Dependencies

The **Claude Usage** widget on the home view requires the [`claude-usage`](https://github.com/phuryn/claude-usage) repo cloned as a sibling:

```
git clone https://github.com/phuryn/claude-usage ../claude-usage
```

This must live at `../claude-usage` relative to this repo (e.g. `C:\Git-Repositories\claude-usage` on the default Windows path). Without it, the widget shows a setup prompt — all other features work normally. No pip install needed; it uses stdlib only.

---

## Setup

1. **Clone to the right location**

   ```
   git clone https://github.com/<your-username>/qa-command-center C:\Git-Repositories\qa-command-center
   ```

   If you clone elsewhere, update `REPOS_PARENT` in your `.env` to match, and update the path in `new-terminal.bat` / `new-terminal.ps1`.

2. **Install Node.js via NVM**

   ```
   nvm install 22.22.2
   nvm use 22.22.2
   ```

3. **Install dependencies**

   ```
   npm install
   ```

4. **Configure environment**

   ```
   copy .env.example .env
   ```

   Open `.env` and fill in your JIRA credentials and release pipeline config. See `.env.example` for all available variables and their descriptions.

5. **Initialize data files**

   ```
   copy data\milestones.example.json data\milestones.json
   copy data\ai-skills.example.json data\ai-skills.json
   copy data\test-suite.example.json data\test-suite.json
   copy data\jql-queries.example.json data\jql-queries.json
   copy data\strategy.example.json data\strategy.json
   copy data\jira-settings.example.json data\jira-settings.json
   copy data\time-config.example.json data\time-config.json
   copy data\time-entries.example.json data\time-entries.json
   copy data\runtime.example.json data\runtime.json
   ```

   The app populates these files as you use it. The stubs are empty — no real data included.

6. **Configure Claude Code integration** *(optional)*

   Run `setup.bat` as Administrator to create symlinks so Claude Code picks up the skills and commands from this repo:

   ```
   setup.bat
   ```

   If it fails with a permissions error, right-click → Run as administrator. If the junction targets already exist as real directories, the script removes them first — move any files into the repo before running.

7. **Start the app**

   ```
   npm start
   ```

   Open [http://localhost:3000](http://localhost:3000) in your browser.

8. **One-click launcher** *(optional)*

   Double-click `Launch Command Center.bat` — it resolves the correct Node version from `.nvmrc` via NVM, starts the server, and opens your default browser automatically. Requires NVM for Windows.

---

## Project structure

| Path | Description |
|---|---|
| `server.js` | Express server — JIRA proxy, local data storage, claude-usage watcher |
| `public/` | Frontend SPA (vanilla JS, no framework) |
| `public/js/views/` | One JS file per section/view |
| `public/css/main.css` | Full design system with CSS custom properties |
| `data/` | Local JSON persistence (gitignored; backed by SQLite) |
| `tests/` | E2E test files (TestCafe) |
| `.claude/commands/` | Claude Code slash commands — release pipeline, go-live testing, XML generation |
| `.claude/skills/` | Claude Code skills — build, design, review, deploy |
| `.claude/docs/` | Internal design docs and tech debt log |
| `.env.example` | Template for all required environment variables |
| `setup.bat` | One-time setup script to configure Claude Code symlinks |
| `Launch Command Center.bat` | One-click launcher (NVM-aware, opens default browser) |
| `new-terminal.bat` / `new-terminal.ps1` | Scripts to open a new terminal at a sibling repo |
