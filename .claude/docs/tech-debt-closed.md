# Tech Debt — Closed Items

Resolved issues, kept for historical reference. See [tech-debt-readme.md](tech-debt-readme.md) for format guide and ID tracker.

---

## TD-004 — `formTitleErr` is dead state — set but never read
**File:** `public/js/views/kanban.js:12`
**Found by:** /review | **Date:** 2026-04-21 | **PR context:** main (kanban card edit + URL link text)
**Category:** dead-code
**Status:** closed

**What:** `formTitleErr` was declared and reset in `openForm`, but never read anywhere. The title-error display was driven directly via the DOM.
**Fixed in:** main (kanban column width + hover tooltips) — removed declaration and write in `openForm`.

---

## TD-002 — Unescaped textContent interpolated into outerHTML in rename functions
**File:** `public/js/views/time-tracker.js:704,706,714,716`
**Found by:** /review | **Date:** 2026-04-15 | **PR context:** feat/terminal-command-multi-repo
**Category:** security
**Status:** closed

**What:** `startRenameProject` and `startRenameTask` read `span.textContent` and interpolated it raw into `value="..."` HTML attributes and `onkeydown` inline JS strings. A name containing `"` broke the attribute; a name containing `'` broke the JS event handler.
**Fixed in:** feat/terminal-command-multi-repo — added `attrVal` (escapes `"` → `&quot;`) and `jsVal` (escapes `\` → `\\`, `'` → `\'`) before interpolation.

---

## TD-001 — Unescaped user data rendered into innerHTML in time-tracker
**File:** `public/js/views/time-tracker.js:231,229,230,321,322,592,602`
**Found by:** /review | **Date:** 2026-04-15 | **PR context:** feat/time-tracker-improvements-workflow (time tracker initial build)
**Category:** security
**Status:** closed

**What:** Project names, task names, and entry notes are rendered directly into `innerHTML` without `htmlspecialchars`-equivalent escaping. A project name containing `<script>` or `"><img onerror=...` would execute as HTML. Affected locations: `entry.notes` (line 231), `tName`/`pName` (lines 229–230), `t.name`/`p.name` in week view (lines 321–322), Manage Projects spans (lines 592, 602).
**Why skipped:** Single-user personal tool — Allen is the only one who can create projects/tasks/notes, making exploitation a self-XSS only. Fix requires wrapping all user-sourced strings with a `esc()` helper before interpolation.
**Fixed in:** chore/gitignore-data-files-fix-xss — added `esc()` helper, applied to all 7 innerHTML locations.
