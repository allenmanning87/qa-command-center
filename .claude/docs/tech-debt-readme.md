# Tech Debt — Reference

Format guide, status legend, and ID tracker for the tech-debt log.
See [tech-debt-open.md](tech-debt-open.md) for active items and [tech-debt-closed.md](tech-debt-closed.md) for resolved items.

---

## ID tracker

**Last opened:** TD-005
**Last closed:** TD-004

When logging a new entry, increment `Last opened` and append to `tech-debt-open.md`.
When closing an entry, move it from `tech-debt-open.md` to `tech-debt-closed.md` and update `Last closed`.

---

## Entry format

```
## TD-NNN — Short title
**File:** `path/to/file.js:line`
**Found by:** /review | **Date:** YYYY-MM-DD | **PR context:** <branch-name> (purpose)
**Category:** security | conventions | error-handling | performance | dead-code
**Status:** open

**What:** Description of the issue.
**Why skipped:** Why it wasn't fixed at the time it was found.
```

---

## Categories

- `security` — XSS risks, unsanitized input, hardcoded secrets
- `conventions` — inline styles, naming violations, file structure issues
- `error-handling` — silent failures, missing error paths
- `performance` — unnecessary re-renders, redundant fetches, large payloads
- `dead-code` — unused functions, unreachable branches, orphaned files

## Status lifecycle

`open` → `closed` (fix merged, or Allen says "close TD-NNN")

Closed entries are moved to [tech-debt-closed.md](tech-debt-closed.md) — they are not deleted.
A re-introduced issue at a previously-closed file:line is logged as a new TD number.
