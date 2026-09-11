# QA Command Center — Project Context

A personal dashboard for tracking JIRA metrics, test suite health, AI skill progression, career milestones, and employment strategy. **Single user. Prioritize information density and efficiency over decorative design.**

## Tech stack

| Layer | Details |
|---|---|
| Server | Node.js + Express (`server.js`) — do not redesign this |
| Frontend | Vanilla JS ES modules, no framework |
| Routing | Hash-based SPA (`public/js/app.js`) |
| Styles | Plain CSS with custom properties (`public/css/main.css`) |
| Views | One JS file per section in `public/js/views/` |
| Charts | Chart.js 4.x (already loaded via CDN) |
| Data | Local JSON files via `/api/data/:collection` |

## Design system

```css
--sidebar-bg: #1a2035;  --bg: #f0f2f6;  --surface: #ffffff;
--blue: #3b82f6;  --border: #e5e7eb;  --radius: 8px;
--font: 'Segoe UI', system-ui;
```

**Reuse these classes — don't reinvent:**
`card`, `card-header`, `card-title`, `stats-row`, `stat-card`, `section-grid`, `section-card`, `btn`, `btn-primary`, `btn-secondary`, `btn-sm`, `badge`, `badge-blue/green/orange/red/gray`, `table`, `table-wrap`, `form-group`, `form-label`, `form-input`, `form-textarea`, `form-select`, `alert`, `empty-state`, `milestone-item`, `query-item`, `pagination`

## Layout

```
topbar (48px) → tab-bar (42px) → token-banner (conditional) → #content.content-area
```

## Key files

- `public/index.html` — shell, tab nav, token banner
- `public/css/main.css` — full design system
- `public/js/app.js` — router + JIRA status indicator
- `public/js/charts.js` — shared Chart.js components (read before writing any viz)
- `public/js/drag-sort.js` — shared single-container drag-to-reorder utility (`makeSortable`)
- `public/js/views/home.js`, `jira-metrics.js`, `kanban.js`, `time-tracker.js`

## Multi-repo convention

All sibling repos live at `<REPOS_PARENT>\<repo-name>` alongside this one. `REPOS_PARENT` is set in `.env` (default: `C:\Git-Repositories`). The `/terminal` command and `new-terminal` scripts read this value automatically — no other configuration needed when adding a new repo.

## New machine setup

After cloning this repo on a new machine, run `setup.bat` from the repo root **once**. It creates three directory junctions so Claude Code picks up all skills and commands from the repo instead of the default `~/.claude/` locations:

| Junction (created at) | Points to |
|---|---|
| `%USERPROFILE%\.claude\commands` | `.claude\commands\` in this repo |
| `%USERPROFILE%\.claude\skills` | `.claude\skills\` in this repo |

If `setup.bat` fails with a permissions error, run it as Administrator (right-click → Run as administrator). If the junction targets already exist as real directories, the script will remove them first before creating the junctions — any files in those directories should be moved into the repo before running.

After setup, edits to skills/commands in this repo take effect immediately — no re-linking needed.

## DRY — shared modules first

Before writing any visualization, table, or sortable-list code, check the shared modules:

**`public/js/charts.js`**

| Function | Use for |
|---|---|
| `renderDoughnut(container, grouped, opts)` | Any pie/donut chart |
| `renderIssueTable(container, issues, opts)` | Any JIRA issue results table |
| `groupIssuesBy(issues, groupBy)` | Grouping issues before charting |

New viz types go into `charts.js` first, then get called from the view. Never copy-paste chart/table code between views.

**`public/js/drag-sort.js`**

| Function | Use for |
|---|---|
| `makeSortable(container, items, { renderRow, onReorder })` | Any single-container drag-to-reorder list |

Renders `.column-row[draggable]` rows with a drag handle. Drag state is closure-local — multiple lists on the same page are independent. Caller owns persist and re-render in `onReorder`. For multi-container drag (e.g., kanban cards moving between columns), implement directly in the view.


---

## ⚠️ This repository is PUBLIC

`github.com/allenmanning87/qa-command-center` is public by design — it supports free
collaboration and serves as a portfolio. That makes every commit a publication.

**`~/.claude/commands` is a symlink to `.claude/commands` in this repo.** Anything dropped into
the user-level commands directory lands in the public repo *by default*. Privacy here is opt-in,
not automatic.

### Placeholder convention — use it for every environment-specific value

Skills describe the process; `.env` supplies the specifics. Never hardcode a real value in a
skill file, even mid-sentence alongside a placeholder — that mixing is exactly how the four
findings below got published.

| Never hardcode | Use |
|---|---|
| Production/automation site names | `{PROD_SITE_MT}`, `{AUTOMATION_SITE_MT}`, `{QA_SITE}` … |
| VPN endpoints, internal IPs | `{WIREGUARD_SERVER}`, `{DEPLOY_TARGET_HOST}` |
| S3 buckets | `{ARTIFACT_BUCKET}` |
| Jira/GitHub org | `{JIRA_BASE_URL}`, `{GITHUB_ORG}` |
| Customer / tenant names | `{tenant-a}`, or "an ST tenant repo" |
| Coworker names | a role — "the RUX lead", "a senior engineer" |

Add each new placeholder to `.env.example` with a safe dummy value. `go-live-testing-rux.md` is
the reference implementation — it follows this convention throughout.

### What is fine to publish

Internal repo names (`MRNexus`, `RUX`), Jira project keys and ticket IDs, DB table names, CI
workflow detail, the release process itself, and lessons-learned narratives. These are the
substance of the portfolio and carry no security value to an outsider. **Redact proper nouns,
never ideas** — an incident story reads just as well with `{tenant-a}` as with a county name.

### Private skills

Skills containing tenant lists, schema names, or customer data belong in the local-only
`neumo-knowledge` repo (`KB_ROOT` in `.env`), not here. If one must live in this directory,
add it to `.gitignore` **before** writing it. `kb-index.md` is handled this way.
