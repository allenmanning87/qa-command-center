## Pre-flight — Read configuration

Before doing anything else, read the `.env` file at the repo root using the `Read` tool and extract these variables for use throughout this skill:

- `JIRA_BASE_URL` → strip `https://` to get `{JIRA_DOMAIN}`
- `GITHUB_ORG`
- `JIRA_PROJECT`
- `JIRA_RELEASES_EPIC`
- `RELEASE_APP_REPO`

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

Each PR is classified into one of **three** repo classes:
- **MT (Multi-Tenant)**: `{GITHUB_ORG}/{RELEASE_APP_REPO}` repo
- **RUX**: `{GITHUB_ORG}/RUX` repo
- **ST (Single-Tenant)**: any other repo

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
- `ADD INDEX` or `ADD KEY`

MT PRs with those specific patterns are **skipped for merging** — do not merge them. Collect them for the final report and continue processing all other PRs normally.

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

For each ST PR (any repo except `{RELEASE_APP_REPO}` and `RUX`):

### 3a — Validate base branch
```
gh pr view {number} --repo {GITHUB_ORG}/{repo} --json baseRefName,state
```
- If `state` is already `MERGED`: skip with a note.
- If `baseRefName` is not `master`, `production-master`, or `main`:
  - If `baseRefName` is `staging`: this is the wrong target for an ST repo. Automatically correct it by looking up the repo's default branch (`gh repo view --repo {GITHUB_ORG}/{repo} --json defaultBranchRef --jq '.defaultBranchRef.name'`), then run `gh pr edit {number} --repo {GITHUB_ORG}/{repo} --base {default_branch}`. Report the correction and continue with the merge.
  - Any other unexpected base branch: flag as "unexpected base branch — needs manual review" and **stop and ask the user** before proceeding. Never auto-skip a PR that is listed in the confirmed story.

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

**Run this step once per app repo that has PRs in today's release.** Substitute `{APP_REPO}` = `{RELEASE_APP_REPO}` for the MT track and `RUX` for the RUX track. The steps are identical — Arturo Rios confirmed (training call, 2026-08-25) that the RUX release process is deliberately homologated with the MRNexus one, so there is no separate procedure to learn.

Only proceed for a given repo if that repo's Step 2 staging health check passed.

**Track independence.** The MT and RUX tracks are independent end to end: separate staging branches, separate release PRs, separate CI runs, separate `/fast-forward` comments, separate tags, separate deploys. Never block one track on the other. Run whichever tracks have PRs; if only RUX has PRs today, run only the RUX track.

**No ordering requirement in Phase 3.** Run the tracks in parallel wherever it saves time: merge both repos' feature PRs, open both release PRs, and let both CI runs (20+ min each) overlap rather than run back to back. Both Phase 4 gates may also run concurrently, and both `/fast-forward` comments may be posted at once when both are clean.

Strict ST → MT → RUX sequencing applies **only** to the Phase 5 production deploys, where `deploy-production.yml` and `deploy-rux.yml` contend for a shared WireGuard peer.

### 4a — Validate each {APP_REPO} PR's base branch
```
gh pr view {number} --repo {GITHUB_ORG}/{APP_REPO} --json baseRefName,state
```
- If `state` is already `MERGED`: skip with a note. (Common on RUX — Arturo often merges his own team's PRs to `staging` ahead of the release; an already-merged PR is expected, not an error.)
- If `baseRefName` is not `staging`: flag as "expected base=staging, got {branch} — needs manual review", skip it.

### 4b — Merge each feature PR into staging
For each valid {APP_REPO} PR (in report order):
```
gh pr merge {number} --repo {GITHUB_ORG}/{APP_REPO} --merge
```
Report each merge as it completes.

> **Out-of-date RUX branches.** If a merge fails because the branch is behind `staging`, the fix is a **rebase**, not a merge commit — the RUX team rebases so `/fast-forward` keeps the same commit references. Note that GitHub's web "Update branch" button may be blocked by repository rules (Copilot code review must run on changes), so the rebase generally has to be done locally by the developer. Report the PR as blocked, ask the developer to rebase and push, and move on — do not attempt the rebase yourself.

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

**The fast-forward gate is CI-green + Phase 4 regression — and it applies to both tracks.** After a staging PR's CI is green, Phase 4 (`/releases-regression`) must run and pass for **that repo** before its `/fast-forward`. Each track validates its own `staging` branch on an automation site, then runs e2e:

- **MT** — `deploy-production.yml`, `deploy-target="Deploy to automation sites only"`, `release-tag=staging`.
- **RUX** — `staging-build-and-archive.yml` (RUX repo, `branch=staging`) → `deploy-rux.yml` (`environment=staging`, `release-tag=staging`) → `release-e2e-automation.yml`.

Regressions are caught before staging merges into `main`. This is distinct from the Phase 5 e2e gate, which runs against the built release tag *after* fast-forward.

Each track's gate is independent: a green MT regression does **not** clear the RUX `/fast-forward`, and vice versa — each needs its own pass and its own authorization.

**Both tracks' gates may run at the same time**, and both `/fast-forward` comments may be posted at the same time when both are clean. There is no ordering requirement anywhere in Phase 3 or Phase 4 — run them in parallel to save wall-clock. The strict ST → MT → RUX sequencing applies **only** to the Phase 5 production deploys.

- **If CI is not green:** report the failing checks with URLs so the user can send them to the developer. Do **not** run Phase 4 and do **not** post `/fast-forward`. Stop.
- **If CI is green:** **do not post the `/fast-forward` comment automatically, and do not ask for `/fast-forward` go-ahead yet.** Hand off to Phase 4: invoke the `/releases-regression` skill. Phase 4 triggers the regression run, polls it to completion, and gates `/fast-forward` on the entire run concluding `success`.
  - **Phase 4 fails** → `/fast-forward` is blocked. Report the failing jobs/steps with the run URL. Stop.
  - **Phase 4 passes** → Phase 4 presents the `/fast-forward` go-ahead prompt (staging CI green + regression green) and waits for the user's explicit authorization before control returns here at step 4e. GitHub PR approval status does NOT count as confirmation — the user must explicitly authorize in the current conversation.

### 4e — Trigger fast-forward merge
Only after Phase 4 has passed **and** the user has explicitly authorized `/fast-forward` (via the Phase 4 Step 4 prompt):
```
MSYS_NO_PATHCONV=1 gh pr comment {staging_pr_number} --repo {GITHUB_ORG}/{APP_REPO} --body "/fast-forward"
```
`MSYS_NO_PATHCONV=1` is required — without it, Git bash on Windows converts `/fast-forward` to a file path (e.g. `C:/Program Files/Git/fast-forward`). This comment triggers the automation that performs the merge and creates the release tag. Report the comment URL.

**Authorize each track separately.** A go-ahead for the MT fast-forward is **not** a go-ahead for RUX. Ask for each one explicitly, naming the repo, and post only the comment the user authorized.

> **RUX needs one approving review on the release PR** before `/fast-forward`. Arturo Rios requests it from Osvaldo, Sebastian, or Israel. One approval is the norm — check `reviewDecision` is `APPROVED` before posting.
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
- If 5 minutes elapse without a new tag, report and stop — the automation may still be running.

> Tag series differ per repo and must not be conflated: `{RELEASE_APP_REPO}` runs `v1.x.y` (e.g. `v1.256.0`), `RUX` runs `v22.x.y` (e.g. `v22.11.3`). Always read each repo's own latest tag — never infer one from the other.

### 4g-i — RUX only: wait for "Release and archive" to finish

**This step has no MT equivalent and is a hard gate on Phase 5.** MRNexus is PHP — the server just checks out the code, so no build is needed. RUX is React/TypeScript/Vite and **must be built** before anything is deployable.

The RUX `/fast-forward` triggers `on-push-default-branch.yml` (*"Release and archive - Triggered by fast-forward merge to default branch"*) in `{GITHUB_ORG}/RUX`. It runs four jobs:

| Job | What it does |
|---|---|
| `semantic-release` | Cuts the `v22.x.y` tag |
| `add-jira-fix-version` | Creates the Jira release and stamps **Fix Version** on every ticket in the PR title |
| `Build application` | `npm install` → **Node Build** → compress `.tar.gz` |
| `Archive build artifact` | `aws s3 cp v{tag}.tar.gz s3://govos-infrastructure-artifacts-l/RUX/releases/` |

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
After the release tag is confirmed (or the 5-minute timeout is reached) **for every track that ran**, output the Step 5 final report and then invoke the `/releases-deploy` skill, passing each tag that was created. `/releases-deploy` handles the MT tag via `deploy-production.yml` and the RUX tag via `deploy-rux.yml`; each has its own explicit go-ahead gate.

> **Phase 5 deploy order is ST → MT → RUX**, strictly sequential. ST deploys are run manually by the user. The MT and RUX deploy workflows share one WireGuard peer identity and **must never run concurrently** — see the serialization warning in `/releases-deploy`.

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
Tag: [v{version}] OR [pending /fast-forward]

RUX Release:
✓ PRs merged into staging: #{N} ({JIRA}), #{N} ({JIRA}), ...
✓ Staging → Main PR: {URL}
CI: [✓ all checks green] OR [⚠ failing: {check name} — {url}] OR [⏳ still running — check manually]
Tag: [v{version}] OR [pending /fast-forward]

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
- Never fix an out-of-date RUX branch yourself — repository rules require Copilot review on changes, so the developer rebases locally. Report it as blocked and move on.
- Roll blocked tickets forward rather than holding the release: if a developer can't resolve a Copilot finding or rebase in time and the ticket is P2/P3, move it to the next release story and continue. P0/P1 tickets warrant chasing an answer instead.
