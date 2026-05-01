You are performing an industry-standard, project-aware code review. Follow every step below in order. Do not skip any step.

---

## STEP 1 — Locate repo and detect project mode

Run `git rev-parse --show-toplevel` to find the repo root.

Then determine **project mode**:
- **blt-e2e**: `package.json` at the root contains `"testcafe"` as a dependency — read `package.json` to confirm
- **qa-command-center (acc)**: file `public/js/app.js` exists at the root
- **Universal**: neither condition matches — only universal checks (Section 2) apply

---

## STEP 2 — Determine diff base

| Mode | Preferred base | Fallback |
|------|---------------|---------|
| blt-e2e | `master...HEAD` | `HEAD~1...HEAD` |
| acc / universal | `main...HEAD` | `HEAD~1...HEAD` |

Run `git branch --list master main` to confirm which base branches exist. If the preferred base branch does not exist, fall back to `HEAD~1...HEAD` and note the fallback in the review output.

---

## STEP 3 — Read every changed file in full (mandatory, unconditional)

1. Run `git diff <base> --name-only` to get the full list of changed files.
2. Run `git diff <base> --stat` to get the lines-added/removed summary.
3. Use the **Read tool** to read **every changed file in its entirety** — not just the diff hunks. This is unconditional: no file is skipped regardless of size or type.
4. For any finding involving a cross-file concern — verifying what a function does, confirming a class exists in CSS, checking what a shared utility provides — read the referenced file before asserting the finding. Specifically:
   - If a finding involves `esc()`, read `api.js` to confirm its definition.
   - If a finding involves `getData`/`saveData`/`uid`, read `api.js`.
   - If a finding involves a CSS class, read `main.css`.
   - If a finding involves `makeSortable`, read `drag-sort.js`.
   - If a finding involves chart functions, read `charts.js`.

Do not write any finding until all files are read.

---

## STEP 4 — Write the review

### Opening block (always present)

State:
- Detected project mode
- Diff base used (or fallback, if applicable)
- Complete list of files read (every file from Step 3)
- Lines added / removed (from `--stat`)

Then immediately output the summary table:

```
| File | 🔴 Critical | 🟡 Moderate | 🔵 Minor |
|------|------------|------------|---------|
```

Include only files that have at least one finding. Sort by highest severity first.

---

### Section A — Findings (grouped by severity: Critical → Moderate → Minor)

Each finding uses this template:

```
**[File:line]** — [Category]
**Problem:** [Specific description with a quoted line from the file as evidence]
**Impact:** [Why it matters]
**Fix:** [Concrete suggestion; include a code snippet where it clarifies]
```

**Line number rule**: line numbers must exactly match the content returned by the Read tool. If a line number cannot be confirmed, cite the function name and a quoted code fragment instead.

---

### Universal checks (apply in all modes)

Apply every check below to all changed files.

**2.1 Correctness**
Flag: logic errors, off-by-one conditions, missing null/undefined guards, conditions that silently pass the wrong value, behaviour that contradicts what the commit description says.

**2.2 Security — static-checkable OWASP items**
Flag:
- Hardcoded secrets, tokens, or passwords (A6)
- String concatenation into SQL, shell commands, or `eval`-equivalent calls (A3)
- Missing or overly permissive CORS/CSRF headers on new routes (A5)
- Weak/deprecated crypto: MD5, SHA1, RC4, hardcoded IVs or keys (A7)
- PII in logs or verbose errors returned to clients (A9)

Before asserting any injection or XSS finding, trace the value from its source (user input, external data, stored data) to the flagged sink in the code you read. Pattern-matching on names alone is not sufficient. If the full trace cannot be completed from the files read, label the finding "Possible" and downgrade one severity level.

**2.3 Error handling**
Flag: `.then()` without `.catch()`, `await` outside `try/catch` at I/O boundaries, errors caught and swallowed with no log or user feedback.

**2.4 Performance**
Flag: nested loops over the same collection (O(n²) where O(n) is straightforward), synchronous blocking inside async functions, DOM manipulation inside loops when a single batch would work.

**2.5 Maintainability**
Flag: magic numbers/strings with no named constant, identifiers whose names contradict their behaviour, more than ~3 levels of nesting or ~5 branches in a single function.

**2.6 DRY — reuse before writing**
Flag: logic in the diff that duplicates something already in the codebase — identical or near-identical blocks in multiple new locations, reimplementing a utility that already exists in a shared module, reinventing a pattern already established in the same file. The fix must point to the existing code that should be called instead.

**2.7 Conciseness / anti-bloat**
Flag: abstractions or helpers introduced for a single call site, error handling for failure modes that cannot occur given surrounding invariants, feature flags or backwards-compat shims when the code can simply be changed, intermediate variables that restate what the expression already says, conditional branches whose body has no observable effect. Standard: if deleting this would not change any observable behaviour, it should not exist.

**2.8 Scalability (counterbalance to 2.7)**
YAGNI applies to features and code paths that don't exist yet — it does not justify structural decisions that would force a rewrite when the natural next use case arrives. Flag:
- A scalar where the domain is inherently plural and an array would be no more complex
- N positional arguments where an `opts` object would be equally readable and naturally extensible
- A hardcoded value that assumes a permanently fixed world when the context is demonstrably variable
- Tight coupling between two concerns with no reason to be inseparable

Test: "To support the obvious next case, does the caller have to change, or just the implementation?"

**2.9 Consistency**
Flag new code that uses a different pattern from the established approach in the same file — a new event listener wired differently from all others, a new API call not using established wrappers, etc.

**2.10 Dead code**
Flag: unreachable branches, unused imports, variables assigned but never read, commented-out code blocks.

**2.11 Discipline rule**
Before recording any finding, answer: "Would this change be rejected if this finding were not raised?" If the honest answer is no, omit the finding or downgrade it to Minor with an explicit advisory label.

---

### qa-command-center-specific checks (acc mode only)

Apply these in addition to universal checks when in acc mode.

**3.1 DRY against shared modules**
Flag any new code in the diff that reimplements something already provided by:
- `charts.js`: `renderDoughnut`, `renderIssueTable`, `renderRollupTable`, `groupIssuesBy`
- `drag-sort.js`: `makeSortable`
- `api.js`: `getData`, `saveData`, `uid`

Also flag new CSS rules that reproduce the effect of an existing class from the design system in `CLAUDE.md`.

**3.2 XSS via innerHTML**
Every string interpolated into an `innerHTML` assignment or template literal rendered into the DOM must pass through `esc()`. Flag any dynamic value — including data from `getData()` — that does not. Trace the value from source to sink before asserting; label "Possible" if trace is incomplete.

**3.3 Global `window._xxx` handlers**
Flag any `window._xxx` assignment not inside an `init()` function. Flag any handler that could accumulate across view navigations (i.e., not overwritten on each `init()` call).

**3.4 `getData` / `saveData` patterns**
Flag:
- `getData()` results used without a `|| []` or `|| {}` fallback guard
- `saveData()` calls where the argument is the pre-mutation value rather than the updated value
- Direct `fetch()` calls that duplicate what `getData`/`saveData` already provides

**3.5 CSS design system compliance**
Flag new inline `style="..."` attributes that set values already provided by a design system class in `CLAUDE.md`. Flag new CSS rules that hardcode a value (`color`, `background`, `border-radius`, `font-family`) that should reference a CSS custom property.

**3.6 Dark mode coverage**
Flag any new CSS rule that sets a colour, background, or border-colour using a hardcoded hex/rgb value without a corresponding `[data-theme="dark"]` override.

**3.7 Module import paths**
Flag import paths whose relative depth does not match the file's location. Views are one level deep (`../api.js`). Anything resolving to `../../` from a view is wrong unless targeting a sibling directory.

**3.8 No `alert()`**
Flag any new `alert()` call. Flag `confirm()` used for non-destructive validation — the project pattern is inline validation messages. Do **not** flag `confirm()` before destructive actions (delete, overwrite) — that is intentional.

**3.9 `uid()` for new record IDs**
Flag any new record that uses `Date.now()`, `Math.random()`, or a hand-rolled ID scheme instead of `uid()` from `api.js`.

---

### blt-e2e–specific checks (blt-e2e mode only)

Apply these in addition to universal checks when in blt-e2e mode.

- **4.1** — `selector.exists` used as a conditional without a timeout → flakiness risk
- **4.2** — `t.expect(sel.exists).ok()` without explicit timeout — note if tighter/looser timeout appropriate
- **4.3** — Bare `test()` instead of `generateTest()` — project convention violation
- **4.4** — Selectors relying on visible text (`withText(...)`) — flag as fragile if attribute-based selector available
- **4.5** — New test files missing a filter flag in `config.js`
- **4.6** — ST tenant detection without `.toLowerCase()` — inconsistent case handling
- **4.7** — Substring matches that could be over-broad (e.g., `"hunt"` matching unintended tenants)
- **4.8** — Flags added to `config-automation.js` but not `config.js` (or vice versa) — asymmetry
- **4.9** — Stray `import` in `config.js` or `config-automation.js` (those files are CJS, not ESM)
- **4.10** — Typos in flag names
- **4.11** — Repeated logic in test bodies that belongs in `utilities/` or `helpers/`
- **4.12** — `? true : false` redundant ternaries
- **4.13** — `skipTest` inside body where config-level exclusion would be cleaner
- **4.14** — Missing `await` before TestCafe actions or assertions
- **4.15** — `t.wait()` with large hard-coded values — suggest assertion-based alternative
- **4.16** — PascalCase or snake_case new file names (must be camelCase, lowercase first char)
- **4.17** — Wrong import path relative depth
- **4.18** — Hardcoded credentials or sensitive values outside `process.env` / `userVariables`

---

### Section B — Praise (omit entirely if nothing is genuinely noteworthy)

Cap at 3 items. Note non-obvious good patterns worth reinforcing — not routine correctness, but choices that show good judgment.

---

### Section C — Tech Debt Logged (omit entirely if no pre-existing issues found)

When full-file reading reveals a real issue in code that is **not** part of the current diff:
1. Do **not** include it in the review findings.
2. Read `.claude/docs/tech-debt-readme.md` to get the TD-NNN format and the current `Last opened` count.
3. Append a properly-formatted entry to `.claude/docs/tech-debt-open.md`.
4. Increment `Last opened` in `tech-debt-readme.md`.
5. Assign the next available TD number.

List each TD filed here:
```
- TD-NNN — path/to/file.js:line — one-line summary
```

---

### Closing line (always present)

End with one of:
- `✅ Ready to merge`
- `🟡 Merge after moderate fixes`
- `🔴 Do not merge — critical issues present`

The verdict must match the highest severity level of any finding in the review.

---

## STEP 5 — Hand off to /qa

After the review output is complete (including the merge verdict), invoke `/qa` immediately without waiting to be asked.

`/qa` will verify that all acceptance criteria from `docs/designs/wip-acceptance-criteria.md` are implemented, then ask Allen for a "ready" confirmation before any deploy step proceeds.

---

## General discipline rules (apply throughout)

- **Style findings only if inconsistent**: flag quote style, spacing, or trailing whitespace only if the rest of the file is inconsistent with the new code's style. Never flag a file that is already internally consistent.
- **Skip non-source files**: do not flag auto-generated code, third-party vendor files, or lock files. If a changed file is auto-generated or a vendor file, note it and skip.

---

## LLM discipline rules (apply throughout)

These rules govern how you must behave differently from a human reviewer.

- **Evidence**: every finding must quote the specific line(s) from the file content you actually read. Never assert from memory, pattern recognition alone, or inference about what the code "probably" does.
- **Data-flow tracing**: before asserting injection or XSS, trace the value from its source to the flagged sink in the code you read. If the full trace cannot be completed, label "Possible" and downgrade one severity level.
- **Static vs. runtime**: any finding that depends on runtime state, browser behaviour, or external service responses must be labelled "Runtime — cannot confirm statically" and may not be raised higher than Moderate.
- **No hallucinated locations**: line numbers must exactly match what the Read tool returned. If unsure, cite the function name and a quoted fragment instead.
- **Confidence labelling**: uncertain findings (incomplete trace, ambiguous context, conditional on configuration) are prefixed "Possible:" and placed one severity level lower than impact would otherwise warrant. A Possible Critical becomes Moderate.
- **No "consider" at Critical or Moderate**: those words belong only in Minor findings or Praise. Critical and Moderate findings assert a concrete problem with evidence.
- **Scope discipline**: review the diff and the files you read as required context. Do not invent findings about code you have not read. Do not speculate about files not in the diff.
