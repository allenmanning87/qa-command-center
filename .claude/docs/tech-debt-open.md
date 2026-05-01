# Tech Debt — Open Items

Active pre-existing issues awaiting a fix. See [tech-debt-readme.md](tech-debt-readme.md) for format guide and ID tracker.

---

## TD-005 — reactTermsOfUse.js lives in qa-command-center instead of blt-e2e
**File:** `tests/e2e/reactTermsOfUse.js:1`
**Found by:** /design | **Date:** 2026-04-21 | **PR context:** go-live-testing-rux Phase 2.A (pre-login terms test)
**Category:** conventions
**Status:** open

**What:** The react Terms of Use pre-login test was written in `qa-command-center/tests/e2e/` as a temporary home because blt-e2e requires a ticket, time tracking, and team-lead code review before merging. The test belongs in `blt-e2e/tests/reactSites/account/` with a matching filter flag in `config.js` (`reactTermsOfUse: true`) and the go-live-testing-rux 2.A step updated to use the blt-e2e path.
**Why skipped:** Bypassing blt-e2e process requirements — needs a proper Jira ticket and code review before landing there.

---

## TD-003 — data/time-projects.json is git-tracked while peer runtime files are gitignored
**File:** `.gitignore`
**Found by:** /review | **Date:** 2026-04-16 | **PR context:** feat/terminal-command-multi-repo (terminal command + multi-repo)
**Category:** conventions
**Status:** resolved — 2026-04-16 (SQLite migration replaced all data/*.json files; .gitignore updated to `data/*.json`)
