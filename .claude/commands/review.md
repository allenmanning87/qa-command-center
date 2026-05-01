Review the changes on the current branch (or a given PR) and produce a structured report.

## Finding what to review

- **No argument given** — read `git diff main...HEAD` to identify all files changed since the branch diverged from `main`.
- **PR number or URL given** — use `gh pr diff <number>` to get the diff.

Read each changed file in full for context before evaluating.

## Review checklist

Evaluate each area and report findings with file:line for every issue.

### 1. DRY
- Any logic, query, or value repeated that could reference an existing helper or variable?
- Existing utility functions in `api.js`, `charts.js`, or other shared modules used where applicable?

### 2. Security
- No XSS: user-supplied or API-sourced strings rendered into `innerHTML` must be escaped
- No hardcoded secrets or tokens in source files
- Data written to JSON files via the API is validated at the boundary

### 3. Code quality
- No dead code, commented-out blocks, or debug `console.log` left in
- No speculative abstractions or future-proofing for hypothetical requirements
- No new files created when an existing file could be edited instead
- No docstrings, comments, or type annotations added to unchanged code
- Logic is easy to follow — flag anything genuinely confusing that warrants a comment

### 4. Conventions (from CLAUDE.md)
- Reuse existing CSS classes; no new inline `style=""` attributes introduced
- No new framework dependencies added
- ES modules throughout — no `require()`
- `getData` / `saveData` via `/api/data/:collection` for all persistence

### 5. Performance
- No unnecessary re-renders or redundant `getData` calls
- No large payload fetches when only a subset is needed

## Classifying findings before acting

**Trivial** (fix directly, no analysis needed):
- Wrong CSS class name, missing semicolon, obvious typo
- Inline style that should be a class

**Non-trivial** (analyze root cause first, then fix):
- Incorrect logic or wrong output
- Architectural issue (wrong data model, wrong abstraction layer)
- Any issue where the correct fix is not immediately obvious

## Logging pre-existing issues

When a finding is **not introduced by the current branch** (pre-existing), do not fix it — log it:

1. Read `.claude/docs/tech-debt-readme.md` to find `**Last opened:**` — increment that number for the new entry, then update the line.
2. Append to `.claude/docs/tech-debt-open.md`:
   ```
   ## TD-NNN — Short title
   **File:** `path/to/file.js:line`
   **Found by:** /review | **Date:** YYYY-MM-DD | **PR context:** <branch-name> (purpose)
   **Category:** security | conventions | error-handling | performance | dead-code
   **Status:** open

   **What:** Description of the issue.
   **Why skipped:** Why it wasn't fixed at the time it was found.
   ```
3. List new TD IDs in the review output under **"Tech debt logged"**.

**Closing a TD:** when a fix is merged, or Allen says "close TD-NNN", move the entry from `tech-debt-open.md` to `tech-debt-closed.md` (update `**Status:** closed`) and update `**Last closed:**` in `tech-debt-readme.md`.

## Output format

For each area: **✅ Clean** or **⚠️ Issues found** with file:line details.

After the sections, emit:

```
### Tech debt logged
- TD-NNN — file.js:line — short description
```
(Omit section if none logged.)

Then:

```
### /qa check
- required — wip-acceptance-criteria.md exists and source files changed
  *or*
- skipped — [reason]
```

## Acting on findings

- **All clean** (or all issues fixed) — announce "Review complete — proceeding to /qa." then immediately invoke `/qa`.
- **Issues found in current changeset** — fix them (trivial directly; non-trivial after analysis), then re-invoke `/review`.
- Do not present the report to Allen until the verdict is clean.
