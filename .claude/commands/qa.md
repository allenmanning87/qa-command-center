Validate that the current branch's implementation fulfils the acceptance criteria from its design session.

## Process

1. **Find the acceptance criteria** — look in order:
   - `docs/designs/wip-acceptance-criteria.md` — check if this file exists on disk first (Read it directly). This is the canonical source.
   - The PR description for this branch (`gh pr view` if a PR exists)
   - If no criteria found, report that and stop — ask Allen to run `/design` first.

2. **Read the branch changes** — identify all files modified since the branch diverged from `main`:
   ```
   git diff main...HEAD --name-only
   ```

3. **Map each criterion to the implementation** — for each criterion in the checklist, use **Read, Grep, and Glob tools only** (not Bash — Bash requires user approval) to verify the relevant code, UI element, or behaviour. Mark each:
   - **✅ Met** — implemented correctly
   - **⚠️ Partial** — implemented but incomplete; cite file:line and what's missing
   - **❌ Not met** — missing or broken; cite file:line or describe exactly what's absent

4. **Regression check** — scan for any existing feature that could be broken by the changed files. Flag any concern.

5. **Act on the verdict automatically — do not surface to Allen until all pass:**
   - **All ✅ Met** — proceed to step 6
   - **Any ⚠️ or ❌** — fix each failing criterion:
     - **Trivial** (wrong class, typo, one-liner) — fix directly
     - **Non-trivial** (logic error, wrong data model) — analyze root cause first, then fix
     After fixes, re-invoke `/qa` automatically from step 1. Only exit this loop when all criteria are ✅ Met.

6. **Present the combined report** once all criteria pass:

```
## QA Report — <branch name>

### /review summary
<brief summary of what /review found and fixed>

### Acceptance criteria
| # | Criterion | Status | Notes |
|---|-----------|--------|-------|
| 1.1 | ... | ✅ Met | |
| 1.2 | ... | ✅ Met | |

### Regression check
✅ No regressions detected  *or*  ⚠️ Potential regression: <description>

### Verdict
Pass — all criteria met
```

7. **Signal completion** — once the report is presented, say exactly:

   > "QA passed — say **ready** to deploy to production."

   Do not invoke `/deploy` until Allen explicitly says "ready."
