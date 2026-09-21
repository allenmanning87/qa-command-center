## Pre-flight — Read configuration

Before doing anything else, read the `.env` file at the repo root using the `Read` tool and extract these variables for use throughout this skill:

- `JIRA_BASE_URL` → strip `https://` to get `{JIRA_DOMAIN}`
- `GITHUB_ORG`
- `JIRA_PROJECT`
- `JIRA_RELEASES_EPIC`
- `RELEASE_APP_REPO`
- `SUTS_API_RELEASE_OWNER` — the person who releases `SUTS-API` PRs (see the repo classes below)

> **`SUTS_API_RELEASE_OWNER` is a private value.** Resolve it from `.env` and use the real name **only when reporting to the user in chat**. Never write it into a Jira description or comment, a PR comment, a commit message, or any file under `.claude/` — those are published or tracked in a public repo. In written artifacts use "its designated owner". If the variable is unset, fall back to "its designated owner" everywhere and say once that it is unset.

---

# Merge Releases (Phase 3)

You are executing Phase 3 of the daily release process: merging confirmed PRs and creating release versions.

## Inputs

Before doing anything else, fetch today's Daily Releases Jira story to get the authoritative PR list. Search for it using JQL:
```
summary ~ "Releases {TODAY}" AND "Epic Link" = {JIRA_RELEASES_EPIC} AND statusCategory != Done
```
Parse the story's description — the PRs are listed under the `### Dependencies` / `* Release PRs:` section. Extract every `github.com/{GITHUB_ORG}/*/pull/NNN` URL.

If no story is found, ask the user for the story key before proceeding.

Each PR is classified into one of **four** repo classes:
- **MT (Multi-Tenant)**: `{GITHUB_ORG}/{RELEASE_APP_REPO}` repo
- **RUX**: `{GITHUB_ORG}/RUX` repo
- **SUTS-API**: `{GITHUB_ORG}/SUTS-API` repo — **staging-based** (PRs base on `staging`, like MT and RUX), even though its GitHub default branch is `master`. It is **not** an ST repo.
- **ST (Single-Tenant)**: any other repo

> **SUTS-API is released by `{SUTS_API_RELEASE_OWNER}` only** (confirmed 2026-09-21). **Do not merge a SUTS-API PR in this phase.** Report it in the final output as handed off to `{SUTS_API_RELEASE_OWNER}`, with its PR URL and gate status, and carry on with the other repos. Never retarget a SUTS-API PR to `master` — its expected base is `staging`.

> **RUX is in scope as of 2026-08-25.** RUX follows the **same staging-based process as `{RELEASE_APP_REPO}`** — feature PRs base on `staging`, a `staging` → `main` release PR is opened with the same title convention, CI runs (PR-title conventions, Snyk), and `/fast-forward` merges it and cuts the tag. Any older instruction to omit RUX PRs or treat them as another team's responsibility is obsolete. Process the two app repos as **parallel, independent tracks**: a RUX blocker never holds up the MT release, and vice versa.

> **The RUX ↔ `{RELEASE_APP_REPO}` pair.** One ticket often has a PR in each repo (RUX serves the business center, `{RELEASE_APP_REPO}` serves `/backend/admin/`). Each PR merges into its own repo's `staging` and ships on its own tag — they are **not** merged together and do not block each other mechanically. But if one half was gate-excluded in triage while the other is clean, say so in the final report: only half the fix will ship.

---

## Step 1 — Migration Pre-Flight Scan

Before merging anything, scan **every** PR's diff for flagged migration patterns:

```
gh pr diff {number} --repo {GITHUB_ORG}/{repo}
```

**For ST PRs** — flag a PR if its diff contains any migration file (path includes `migrat`). ST migrations must be run manually. Flag the PR, note it in the final report as "has migrations — run manually before/after deploy", but **do not skip merging it** — it still gets merged and released. Just make sure the manual migration note is prominent in the report.

**For MT PRs ({RELEASE_APP_REPO})** — migrations are handled by automation, so no special action needed *unless* the diff contains either of the following inside a migration file path:
- References to the `businesstaskdata` table (e.g. `ALTER TABLE businesstaskdata`, `businesstaskdata` in a CREATE/INSERT/UPDATE/SELECT statement in a migration)
- An index add (`ADD INDEX`, `ADD KEY`, or `CREATE INDEX`) **on the `businesstask`, `businesstaskdata`, or `transactions` table**

MT PRs with those specific patterns are **skipped for merging** — do not merge them. Collect them for the final report and continue processing all other PRs normally.

> **The index rule covers three tables: `businesstask`, `businesstaskdata`, and `transactions`.** These are the high-row-count tables where an index build is slow enough to matter during a deploy. An index add on any *other* table — `business`, `extension_definition`, etc. — is **not** a blocker and merges normally.
>
> History, so the scope isn't re-litigated each release: the rule was originally a blanket `ADD INDEX`/`ADD KEY` match (too broad — it falsely held tenant-scoped index adds). On **2026-09-01** dev narrowed it to `businesstaskdata` + `transactions`, and MRNexus#6959 was merged over a `CREATE INDEX` on `businesstask` on that basis. Dev then **added `businesstask` to the list for future releases** — that is the current rule above.
>
> Tenant-scoped path (`app/migrations/tenants/{tenant}/...`) remains a separate mitigating signal: those run against one tenant only. But path no longer decides on its own — the **table** is what determines whether the index rule fires.
>
> Note for the report: an index add is not the only slow DDL. `ALTER TABLE ... ADD COLUMN` on a large shared table can lock comparably, and is deliberately **not** screened by this rule. When a default-scope migration adds columns to a widely-populated table, mention it in the final report as a deploy-window consideration rather than blocking on it.

**For RUX PRs** — RUX is a React/Vite front end with no database layer, so the migration scan does not apply. Skip it. If a RUX PR's diff somehow does contain a migration path, that is unexpected — flag it for manual review rather than guessing.

---

## Step 2 — App-Repo Pre-Flight: Staging Health Check

**Run Steps 2–4 in this order: ST PRs first, then the app repos (MT and RUX) last.** ST merges are fast (seconds); app-repo CI takes 20+ minutes. Starting them last keeps the CI wait at the end rather than in the middle.

Run this check **once per app repo that has PRs in today's release** — `{RELEASE_APP_REPO}` and/or `RUX`. Skip the check for a repo with no PRs today.

For each app repo `{APP_REPO}` in (`{RELEASE_APP_REPO}`, `RUX`):

```
gh api repos/{GITHUB_ORG}/{APP_REPO}/compare/main...staging
```

- If `ahead_by > 0`: there are commits on `staging` not yet in `main` that aren't from today's PRs. **Stop and ask the user to review before proceeding with that repo's merges.** (ST PRs, and the *other* app repo, may still proceed.)
- If `ahead_by == 0`: staging is clean — proceed for that repo.

> A failed health check on one app repo blocks **only that repo**. If `{RELEASE_APP_REPO}` staging is dirty but `RUX` is clean, the RUX track still runs — and vice versa. Report the blocked repo and carry on with the other.

---

## Step 3 — Process ST PRs (one at a time, in report order)

For each ST PR (any repo except `{RELEASE_APP_REPO}`, `RUX` and `SUTS-API`):

### 3a — Validate base branch
```
gh pr view {number} --repo {GITHUB_ORG}/{repo} --json baseRefName,state
```
- If `state` is already `MERGED`: skip with a note.
- If `baseRefName` is not `master`, `production-master`, or `main`:
  - If `baseRefName` is **exactly `staging`**: the two integration branches have been swapped, which is the one unambiguous ST base error. Automatically correct it by looking up the repo's default branch (`gh repo view --repo {GITHUB_ORG}/{repo} --json defaultBranchRef --jq '.defaultBranchRef.name'`), then run `gh pr edit {number} --repo {GITHUB_ORG}/{repo} --base {default_branch}`. Report the correction and continue with the merge.
  - **Any other base — i.e. a feature or ticket branch — is a deliberate stack, not an error.** Do **not** retarget it. Flag as "stacked PR — base is a feature branch, target unconfirmed" and **stop and ask the user**, reporting the parent branch, whether it has its own PR and that PR's state (`gh api "repos/{GITHUB_ORG}/{repo}/pulls?head={GITHUB_ORG}:{base}&state=all"`). Retargeting a stack guesses at a dependency you cannot see. Never auto-skip a PR that is listed in the confirmed story.

### 3b — Determine version bump from PR title
```
gh pr view {number} --repo {GITHUB_ORG}/{repo} --json title
```
- Title starts with `feat:` → **minor** bump (1.2.3 → 1.3.0, reset patch to 0)
- Title starts with `fix:` or `chore:` → **patch** bump (1.2.3 → 1.2.4)
- Unrecognized prefix → **patch** bump, note it in the report

### 3c — Get latest release tag
```
gh release list --repo {GITHUB_ORG}/{repo} --limit 1 --json tagName
```
Parse the semver from the tag (strip leading `v`). If no releases exist, start from `v1.0.0` and note it.

### 3d — Merge the PR
```
gh pr merge {number} --repo {GITHUB_ORG}/{repo} --merge
```

### 3e — Create the release tag
```
gh release create v{new_version} --repo {GITHUB_ORG}/{repo} --title "v{new_version}" --generate-notes
```

### 3f — Report progress immediately
Output: `✓ {repo} PR #{N} ({JIRA}) merged → v{new_version} released`

---

## Step 4 — Process app-repo PRs ({RELEASE_APP_REPO} and RUX)

**Run this step once per app repo that has PRs in today's release.** Substitute `{APP_REPO}` = `{RELEASE_APP_REPO}` for the MT track and `RUX` for the RUX track. The steps are identical — a senior engineer confirmed (training call, 2026-08-25) that the RUX release process is deliberately homologated with the MRNexus one, so there is no separate procedure to learn.

Only proceed for a given repo if that repo's Step 2 staging health check passed.

**Track independence.** The MT and RUX tracks are independent end to end: separate staging branches, separate release PRs, separate CI runs, separate `/fast-forward` comments, separate tags, separate deploys. Never block one track on the other. Run whichever tracks have PRs; if only RUX has PRs today, run only the RUX track.

**No ordering requirement in Phase 3.** Run the tracks in parallel wherever it saves time: merge both repos' feature PRs, open both release PRs, and let both CI runs (20+ min each) overlap rather than run back to back. Both Phase 4 gates may also run concurrently, and both `/fast-forward` comments may be posted at once when both are clean.

Strict **ST → RUX → MT** sequencing applies **only** to the Phase 5 production deploys, where `deploy-production.yml` and `deploy-rux.yml` contend for a shared WireGuard peer. (RUX deploys first — it finishes in under 40 seconds.)

### 4a — Validate each {APP_REPO} PR's base branch
```
gh pr view {number} --repo {GITHUB_ORG}/{APP_REPO} --json baseRefName,state
```
- If `state` is already `MERGED`: skip with a note. (Common on RUX — the owning team often merges its own PRs to `staging` ahead of the release; an already-merged PR is expected, not an error.)
- If `baseRefName` is `main` / `master` / `production-master`: the integration branches have been swapped — the one unambiguous app-repo base error. Correct it (`gh pr edit {number} --repo {GITHUB_ORG}/{APP_REPO} --base staging`), report the correction, and continue.
- If `baseRefName` is **any other branch** (a feature or ticket branch): this is a **deliberate stack**, not an error. Do **not** retarget it. Flag as "stacked PR — base is a feature branch, target unconfirmed", report whether the parent branch has its own PR and that PR's state, and **stop and ask the user** — the author may need the parent merged first, and retargeting would either drop a real dependency or manufacture a conflict that does not exist in their intended merge order.

### 4b — Merge each feature PR into staging

**The merge flag differs per repo — using the wrong one fails outright:**

| Repo | Command | Why |
|---|---|---|
| `{RELEASE_APP_REPO}` | `gh pr merge {number} --repo {GITHUB_ORG}/{RELEASE_APP_REPO} --merge` | Merge commits allowed |
| `RUX` | `gh pr merge {number} --repo {GITHUB_ORG}/RUX --squash` | **`allow_merge_commit: false`** — `--merge` is rejected by the repo |

RUX lands every feature PR as a single-parent squash (confirm with `gh api repos/{GITHUB_ORG}/RUX --jq '.allow_merge_commit'` → `false`). Passing `--merge` there fails; use `--squash`.

Report each merge as it completes.

#### RUX merges are serial — expect one rebase pause per remaining PR

**In RUX, merging one PR puts every other open RUX PR into `BEHIND` immediately.** Merge commits are disabled (`allow_merge_commit: false`), so there is no merge commit to absorb the new `staging` head — each remaining branch must be updated before it can merge, even one that read `CLEAN` seconds earlier. This is normal RUX behavior, **not** a defect in the PR and **not** something triage failed to catch. `{RELEASE_APP_REPO}` and ST repos do not behave this way.

Practically: **with N RUX PRs, expect about N−1 rebase pauses.** Five RUX PRs means roughly four.

Merge RUX PRs **one at a time**, and after each merge:

1. Re-query the next PR's state before attempting it:
   ```
   gh pr view {number} --repo {GITHUB_ORG}/RUX --json mergeStateStatus,mergeable,author
   ```
2. **If it reads `CLEAN`** → merge it and continue.
3. **If it reads `BEHIND`** → **pause the RUX track and tell the user**, naming the PR and its author:

   > `RUX #{number} ({JIRA}) is BEHIND — expected, #{previous} just merged. Author: {login}. Needs a rebase before it can merge.`

   Then **wait for the user** to confirm the rebase has been pushed. Do not attempt the rebase yourself: GitHub's web "Update branch" button is blocked by repository rules (Copilot review must re-run on changes), and pushing to another developer's branch is not yours to do.
4. When the user says it's updated, **re-verify** with the same query and merge only once it actually reads `CLEAN` — never on someone's say-so alone.
5. Repeat until every RUX PR is merged.

**Never block the other tracks on a RUX pause.** While waiting on a RUX rebase, the `{RELEASE_APP_REPO}` and ST work continues — the tracks are independent (see Track independence above). Only the RUX track waits.

> A `BEHIND` RUX PR arriving at this step is expected and needs no commentary about triage having missed it. What *would* be a real finding is `CONFLICTING`/`DIRTY` — that is a genuine conflict, and triage should have caught it (see `/releases-triage` Gate 4).

### 4c — Create the staging → main PR
After all feature PRs are merged into that repo's staging, create the release PR:
```
gh pr create \
  --repo {GITHUB_ORG}/{APP_REPO} \
  --base main \
  --head staging \
  --title "release: {JIRA-1} {JIRA-2} ... {YYYY-MM-DD}"
```
Title format: list every Jira ticket key from **that repo's** PRs, space-separated, then today's date. Example: `release: PROJ-3761 PROJ-20208 2026-04-13`

Each track gets its **own** release PR with its **own** ticket list — never combine MT and RUX tickets into one title.

> **Why the title format matters:** the release-notes automation parses the ticket keys out of this title to determine which tickets belong to the release, and the deploy workflow later stamps the resulting version onto each ticket's **Fix Version** field. A malformed title means tickets don't get versioned. Both repos enforce the same PR-title convention check in CI.

Report the new PR URL.

### 4c-i — Open the staging → main PR in Chrome

Immediately after each release PR is created, open it in the user's current Chrome window so they can watch CI live — mirroring the review-tab behavior in `/releases-triage`. Reuse the current window (append a tab — do **not** pass `--new-window`):

```bash
powershell.exe -NoProfile -Command "Start-Process chrome -ArgumentList @('{staging_pr_url}')"
```

- Substitute `{staging_pr_url}` with the URL returned in step 4c for **this** track's repo.
- If Chrome isn't found / `Start-Process` errors, report the failure and print the PR URL in chat so the user can open it manually — do not block the rest of the skill.
- Report a one-line confirmation naming the repo, e.g. `Opened {APP_REPO} staging → main PR in Chrome.`

> **Open a tab for every track that produced a release PR — RUX included.** When both `{RELEASE_APP_REPO}` and `RUX` have release PRs, open **both**; the RUX PR is not optional and not "the other team's tab". Either open each one as its step 4c completes, or pass both URLs in a single `Start-Process` call:
>
> ```bash
> powershell.exe -NoProfile -Command "Start-Process chrome -ArgumentList @('{mt_pr_url}','{rux_pr_url}')"
> ```
>
> Both PRs need watching: they run independent CI, and each needs its own `/fast-forward` authorization.

### 4d — Poll CI checks on the staging PR, then gate on explicit go-ahead

Poll the staging → main PR's CI checks to completion in a background task:

```bash
until ! gh pr checks {staging_pr_number} --repo {GITHUB_ORG}/{APP_REPO} 2>&1 | grep -q "pending"; do sleep 30; done && gh pr checks {staging_pr_number} --repo {GITHUB_ORG}/{APP_REPO} 2>&1
```

> **Poll on the run status, not a substring of the output.** Comparing `gh run view ... --jq '.status'` to the exact string `completed` is reliable; `grep -q "completed"` is not — the word also appears in step-level conclusions, so the loop can exit while the run is still in progress. Also note that `gh pr checks` exits non-zero when checks have **failed**, which is a result, not a polling error — always read the output rather than trusting the exit code.

- Stop polling as soon as all checks have completed (pass or fail).
- Report all CI results: list any failing checks with their URLs.
- If the 15-minute timeout is reached with checks still pending: report current status and stop.

**The fast-forward gate differs per track — Phase 4 is MT-only.**

| Track | Gate before `/fast-forward` |
|---|---|
| **MT** (`{RELEASE_APP_REPO}`) | staging PR CI green → **Phase 4 (`/releases-regression`) passes** → user's explicit go-ahead |
| **RUX** | staging PR CI green → **one approving review** (`reviewDecision == APPROVED`) → user's explicit go-ahead |

**Do not run Phase 4 for RUX, and do not offer to.** RUX runs no e2e regression suite at any point: it enforces unit tests + lint through a **pre-push git hook**, so problems are caught before a PR exists, and its post-deploy verification is a manual smoke check (open a new-UI URL, confirm it loads and login works). Never describe a RUX release as regression-verified.

Phase 4 for MT validates the `staging` **branch** via `deploy-production.yml`, `deploy-target="Deploy to automation sites only"`, `release-tag=staging`. Regressions are caught before staging merges into `main`. This is distinct from the Phase 5 e2e gate, which runs against the built release tag *after* fast-forward.

**Consequence for sequencing:** once RUX's CI is green, RUX is immediately at its authorization point — the approving review is typically the only thing left. Ask for the RUX go-ahead as soon as that review lands; never queue RUX behind an MT regression run. RUX will often be ready to ship well before MT.

Each track's gate is independent and authorized separately — a green MT regression does **not** clear the RUX `/fast-forward`, and vice versa.

**Both tracks' gates may be satisfied at the same time**, and both `/fast-forward` comments may be posted at the same time when both are clean and both authorized. There is no ordering requirement anywhere in Phase 3 or Phase 4 — run them in parallel to save wall-clock. (Only MT has a Phase 4 gate at all; RUX's runs no regression.) The strict **ST → RUX → MT** sequencing applies **only** to the Phase 5 production deploys.

- **If CI is not green:** report the failing checks with URLs so the user can send them to the developer. Do **not** run Phase 4 and do **not** post `/fast-forward`. Stop.
- **If CI is green — MT track:** **do not post the `/fast-forward` comment automatically, and do not ask for `/fast-forward` go-ahead yet.** Hand off to Phase 4: invoke the `/releases-regression` skill. Phase 4 triggers the regression run, polls it to completion, and gates `/fast-forward` on the entire run concluding `success`.
- **If CI is green — RUX track:** **skip Phase 4 entirely.** Check `reviewDecision`: if it is not `APPROVED`, report that the release PR needs one approving review (requested from the RUX team) and name that as the only remaining blocker. Once it reads `APPROVED`, ask the user for the RUX `/fast-forward` go-ahead directly.
  - **Phase 4 fails** → `/fast-forward` is blocked. Report the failing jobs/steps with the run URL. Stop.
  - **Phase 4 passes** → Phase 4 presents the `/fast-forward` go-ahead prompt (staging CI green + regression green) and waits for the user's explicit authorization before control returns here at step 4e. GitHub PR approval status does NOT count as confirmation — the user must explicitly authorize in the current conversation.

### 4e — Trigger fast-forward merge
Only after Phase 4 has passed **and** the user has explicitly authorized `/fast-forward` (via the Phase 4 Step 4 prompt):
```
MSYS_NO_PATHCONV=1 gh pr comment {staging_pr_number} --repo {GITHUB_ORG}/{APP_REPO} --body "/fast-forward"
```
`MSYS_NO_PATHCONV=1` is required — without it, Git bash on Windows converts `/fast-forward` to a file path (e.g. `C:/Program Files/Git/fast-forward`). This comment triggers the automation that performs the merge and creates the release tag. Report the comment URL.

**Authorize each track separately.** A go-ahead for the MT fast-forward is **not** a go-ahead for RUX. Ask for each one explicitly, naming the repo, and post only the comment the user authorized.

> **RUX needs one approving review on the release PR** before `/fast-forward`. It is requested from the RUX team. One approval is the norm — check `reviewDecision` is `APPROVED` before posting.
>
> **`{RELEASE_APP_REPO}` does not.** The MT release PR proceeds on **CI-green alone** — do not treat `reviewDecision: REVIEW_REQUIRED` or `mergeStateStatus: BLOCKED` on the MT staging → main PR as a blocker, and do not wait for a reviewer. Once its CI is green, go straight to Phase 4 (`/releases-regression`) exactly as before RUX existed. The GitHub approval requirement is RUX-only.
>
> **Neither repo's `/fast-forward` is ever automatic.** This distinction is only about whether a *GitHub reviewer approval* is required to move forward — it does not relax the authorization rule. **Both RUX and `{RELEASE_APP_REPO}` require the user's explicit go-ahead in the conversation before their respective `/fast-forward` comment is posted**, asked for separately per track. A green CI, a passing Phase 4, and a GitHub approval are prerequisites, never authorization.

Separate authorization does not mean separate timing: once both are authorized, **both `/fast-forward` comments may be posted at the same time.** Nothing about fast-forward contends between the repos — they merge and tag independently.

### 4f — Poll for PR merge confirmation
Poll every 15 seconds (up to 5 minutes / 20 polls) until the PR state is `MERGED`:
```
gh pr view {staging_pr_number} --repo {GITHUB_ORG}/{APP_REPO} --json state
```
- Stop as soon as `state == "MERGED"` and report: `✓ {APP_REPO} staging → main merged`
- If 5 minutes elapse without merging, report the current state and stop — do not block.

### 4g — Poll for new release tag
Immediately after merge is confirmed, note the latest tag before the merge (captured in step 4e or check now). Then poll every 15 seconds (up to 5 minutes / 20 polls) for a new tag to appear:
```
gh release list --repo {GITHUB_ORG}/{APP_REPO} --limit 1 --json tagName,createdAt
```
- Stop as soon as a tag newer than the one that existed before the `/fast-forward` comment appears.
- Report: `✓ {APP_REPO} release tag created: v{version}`
- If no new tag appears, **do not report a bare timeout** — run the diagnosis in 4g-ii below and report the actual cause.

> Tag series differ per repo and must not be conflated: `{RELEASE_APP_REPO}` runs `v1.x.y` (e.g. `v1.256.0`), `RUX` runs `v22.x.y` (e.g. `v22.11.3`). Always read each repo's own latest tag — never infer one from the other.

### 4g-ii — No tag appeared: diagnose before reporting

**"The automation may still be running" is usually the wrong answer, and it sends the user to wait on something that will never happen.** A missing tag has three distinct causes with three different remedies, and they are told apart by looking at the release workflow run — never by waiting longer.

Find the post-fast-forward run and read its jobs:

```bash
# {RELEASE_APP_REPO} → "Default branch workflow";  RUX → on-push-default-branch.yml
RUN=$(gh run list --repo {GITHUB_ORG}/{APP_REPO} --limit 10 \
        --json databaseId,name,event,createdAt \
        --jq '[.[] | select(.event == "push")][0].databaseId')
gh run view $RUN --repo {GITHUB_ORG}/{APP_REPO} --json status,conclusion,jobs \
  --jq '.status + " / " + (.conclusion // "-"), (.jobs[] | "  " + .name + " -> " + (.conclusion // .status))'
```

Match the result against these three cases:

| Run state | Cause | What to report / do |
|---|---|---|
| `in_progress` | Genuinely still running | Keep polling. This is the only case where waiting helps. |
| `completed / failure` | The release job broke | Report the failing job + step with the run URL. The fix is re-running that job — **not** a manual tag. |
| **`completed / success` but `semantic-release` published nothing** — the giveaway is that the downstream jobs (`notify-teams-release-notes`, `add-jira-fix-version`) are **`skipped`**, since they are conditioned on a release existing | **semantic-release deliberately declined to release**, because no commit in the release carries a releasing prefix | Report this as a **decision, not a failure** (see below). Waiting will never produce a tag. |

#### semantic-release declined — the "no releasable commits" case

semantic-release derives the bump from conventional-commit prefixes. `feat:` → minor and `fix:` → patch produce a release; **`ci:`, `chore:`, `docs:`, `test:`, `style:` and `refactor:` do not.** When *every* commit in a release is a non-releasing type, semantic-release exits `success` having created no tag, and the release-notes and Fix Version jobs skip. The run is green. Nothing is broken.

Report it plainly, for example:

> `⚠ {APP_REPO}: no release tag — semantic-release declined (no releasable commits). The only commit is `ci: BLTE-24248 …`; `ci:` is a non-releasing type. Run {url} concluded success with notify/fix-version skipped. Waiting will not produce a tag. Code IS merged to main.`

Then state the consequences explicitly, because they are easy to miss:

- **Phase 5 cannot run for this track** — `deploy-production.yml` needs a real tag ref to check out. Skip that track's deploy (and, for MT, skip the Step 3 `{RELEASE_BLT1_AUTOMATION_STAGING}` staging deploy, which also takes the tag).
- **The tickets get no Fix Version and appear in no release notes.** They will not show up in any `v*` release, so suggest a comment on each affected ticket recording that it merged to `main` on this date without a tag — otherwise it looks lost later.
- **Workflow-only changes are already live.** Files under `.github/workflows/` resolve from the ref a run is triggered on, not from a release tag, so once they are on the default branch they take effect on the next trigger with no tag and no deploy. A reusable (`workflow_call`) workflow called from the default branch likewise resolves at that ref. **This applies only to the `.github/` portion of the diff** — any application code in the same commit is on `main` but unshipped, which is the genuinely risky shape: half the change live, half not. Say which case it is.

Do **not** hand-create the tag to "fix" this, and do not offer it as the default remedy. A manual tag yields the ref but skips release notes and Fix Version stamping, and can collide with or leave a gap in the version series that semantic-release computes next. If the user wants the change tagged, the options are (a) let it ride out with the next release containing a `fix:`/`feat:` — usually correct, especially for CI-only changes — or (b) explicitly ask for a manual tag, accepting the above. Present (a) first and let the user choose.

> **This is a recurring scenario, not an edge case** (observed several times a quarter — e.g. 2026-09-17, BLTE-24248, a `ci:`-only MRNexus release). The releases whose entire content is `ci:`/`chore:`/`docs:` commits are exactly the ones that hit it. A release containing even one `fix:` or `feat:` always tags.

### 4g-i — RUX only: wait for "Release and archive" to finish

**This step has no MT equivalent and is a hard gate on Phase 5.** MRNexus is PHP — the server just checks out the code, so no build is needed. RUX is React/TypeScript/Vite and **must be built** before anything is deployable.

The RUX `/fast-forward` triggers `on-push-default-branch.yml` (*"Release and archive - Triggered by fast-forward merge to default branch"*) in `{GITHUB_ORG}/RUX`. It runs four jobs:

| Job | What it does |
|---|---|
| `semantic-release` | Cuts the `v22.x.y` tag |
| `add-jira-fix-version` | Creates the Jira release and stamps **Fix Version** on every ticket in the PR title |
| `Build application` | `npm install` → **Node Build** → compress `.tar.gz` |
| `Archive build artifact` | `aws s3 cp v{tag}.tar.gz s3://{ARTIFACT_BUCKET}/RUX/releases/` |

**That final S3 upload is the artifact `deploy-rux.yml` downloads.** Until it completes, the deploy will fail with "no artifact" — the tag will already exist, which makes it look like a tagging problem when it is really a timing one.

Poll it to completion before handing off to Phase 5:

```bash
RUN=$(gh run list --repo {GITHUB_ORG}/RUX --workflow on-push-default-branch.yml --limit 1 --json databaseId --jq '.[0].databaseId')
until [ "$(gh run view $RUN --repo {GITHUB_ORG}/RUX --json status --jq '.status')" = "completed" ]; do sleep 20; done
gh run view $RUN --repo {GITHUB_ORG}/RUX --json status,conclusion --jq '.status + " / " + .conclusion'
```

Typical duration is ~3 minutes (observed 2m46s for `v22.12.0`). Report `✓ RUX build + archive complete — artifact published for {tag}`.

- If the run **fails**, there is no artifact and Phase 5 cannot proceed. Report the failing job and stop.
- If `add-jira-fix-version` failed but the build and archive succeeded, the deploy can still run — the Fix Versions just need setting manually.

> **Consequence for the release PR title:** `add-jira-fix-version` parses the ticket keys out of the `staging` → `main` PR title. Any ticket shipping in the release but missing from that title gets **no Fix Version**, and a duplicated or wrong key stamps the wrong thing. Get the title right before `/fast-forward` — it cannot be fixed afterward by editing the PR.

### 4h — Proceed to Phase 5
After each track's tag is resolved — created, or diagnosed as absent per 4g-ii — output the Step 5 final report and then invoke the `/releases-deploy` skill, passing each tag that was actually created. `/releases-deploy` handles the MT tag via `deploy-production.yml` and the RUX tag via `deploy-rux.yml`; each has its own explicit go-ahead gate.

**Pass only tags that exist.** A track whose tag semantic-release declined to cut (4g-ii) has nothing to deploy — `deploy-production.yml` requires a real tag ref. Omit that track from the Phase 5 handoff, say so explicitly in the report, and never substitute a branch name or a hand-made tag for the missing one. If *no* track produced a tag, skip Phase 5 entirely rather than invoking it with nothing.

> **Phase 5 deploy order is ST → RUX → MT**, strictly sequential. ST deploys are run manually by the user and never block the app repos. RUX deploys before MT because it finishes in under 40 seconds while MT takes 20+ minutes; the two workflows share one WireGuard peer identity and **must never run concurrently** — see the serialization warning in `/releases-deploy`.

---

## Step 5 — Final Report

Output a summary after all processing:

```
Phase 3 Complete — {YYYY-MM-DD}

ST Releases:
✓ {repo} PR #{N} ({JIRA}) → v{version}
(one line per merged ST PR)

MT Release ({RELEASE_APP_REPO}):
✓ PRs merged into staging: #{N} ({JIRA}), #{N} ({JIRA}), ...
✓ Staging → Main PR: {URL}
CI: [✓ all checks green] OR [⚠ failing: {check name} — {url}] OR [⏳ still running — check manually]
Phase 4 regression: [→ handing off to /releases-regression] OR [✓ passed — {run_url}] OR [⚠ failed — {run_url}] OR [pending CI green]
Tag: [v{version}] OR [pending /fast-forward] OR [⚠ none — semantic-release declined (no releasable commits); code merged to main, Phase 5 skipped for this track — {run_url}]

RUX Release:
✓ PRs merged into staging: #{N} ({JIRA}), #{N} ({JIRA}), ...
✓ Staging → Main PR: {URL}
CI: [✓ all checks green] OR [⚠ failing: {check name} — {url}] OR [⏳ still running — check manually]
Approval: [✓ approved by {login}] OR [⚠ needs 1 approving review — ask the RUX team]
Tag: [v{version}] OR [pending /fast-forward] OR [⚠ none — semantic-release declined (no releasable commits); code merged to main, Phase 5 skipped for this track — {run_url}]
(No Phase 4 line — RUX runs no regression suite.)

Flagged / Skipped:
⚠ {repo} PR #{N} ({JIRA}) — {reason}
(one line per skipped PR, grouped by reason)
```

Omit any track section that had no PRs today. If there are no flagged/skipped PRs, omit that section too.

---

## Important Rules

- Always report progress as each merge completes — do not batch output until the end.
- Never force-merge a PR (`--force` or bypassing required checks) — if a merge fails, report the error and skip.
- Never push directly to `main`, `master`, `production-master`, or `staging` — only merge via PR.
- If `gh pr merge` fails for any reason (conflicts, required checks not met, etc.), report the error and move on to the next PR.
- For each app repo's staging→main PR: create it even if some of that repo's PRs were skipped, as long as at least one was merged. If zero PRs were merged for a repo, skip that repo's PR creation and note it.
- **RUX and `{RELEASE_APP_REPO}` are parallel, independent tracks.** Same process, separate everything: staging branches, release PRs, CI runs, `/fast-forward` authorizations, tag series (`v22.x.y` vs `v1.x.y`), and deploys. A failure or hold on one track never blocks the other — run whichever tracks have PRs and report them separately.
- **Never assume RUX is out of scope.** As of 2026-08-25 RUX releases are part of this process; releasing MT while silently dropping RUX ships half the work.
- **A `BEHIND` RUX PR is expected, not a blocker.** Merging any RUX PR puts every other open RUX PR into `BEHIND` at once, so a release with N RUX PRs needs about N−1 rebases. Merge them serially: on each `BEHIND`, pause the RUX track, tell the user which PR and author, wait for confirmation, re-verify `CLEAN`, then merge (Step 4b). Never rebase the branch yourself — repository rules require Copilot review to re-run on changes, so the author does it locally. Other tracks keep running while RUX waits.
- Roll blocked tickets forward rather than holding the release: if a developer can't resolve a Copilot finding or rebase in time and the ticket is P2/P3, move it to the next release story and continue. P0/P1 tickets warrant chasing an answer instead.
- **A missing release tag is diagnosed, never waited out.** If no tag appears after `/fast-forward`, read the release workflow run (step 4g-ii) and report the real cause. A green run with `semantic-release` succeeding but the notify / fix-version jobs **skipped** means semantic-release deliberately declined because no commit carries a releasing prefix (`ci:`, `chore:`, `docs:`, `test:`, `style:`, `refactor:` do not release) — waiting will never produce a tag. Never report a bare "automation may still be running" timeout, never pass a non-existent tag to Phase 5, and never hand-create the tag as the default fix (it skips release notes and Fix Version stamping and can break the version series).
