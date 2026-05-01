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

Each PR is classified as:
- **MT (Multi-Tenant)**: `{GITHUB_ORG}/{RELEASE_APP_REPO}` repo
- **ST (Single-Tenant)**: any other repo

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

---

## Step 2 — MT Pre-Flight: Staging Health Check

**Run Steps 2–4 in this order: ST PRs first, MT last.** ST merges are fast (seconds); MT CI takes 20+ minutes. Starting MT last keeps the CI wait at the end rather than in the middle.

Before touching any {RELEASE_APP_REPO} PR, verify the `staging` branch has no abandoned work:

```
gh api repos/{GITHUB_ORG}/{RELEASE_APP_REPO}/compare/main...staging
```

- If `ahead_by > 0`: there are commits on `staging` not yet in `main` that aren't from today's PRs. **Stop and ask the user to review before proceeding with MT merges.** (ST PRs may still proceed in parallel.)
- If `ahead_by == 0`: staging is clean — proceed.

---

## Step 3 — Process ST PRs (one at a time, in report order)

For each ST PR (any repo except {RELEASE_APP_REPO}):

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

## Step 4 — Process MT PRs ({RELEASE_APP_REPO})

Only proceed if the Step 2 staging health check passed.

### 4a — Validate each {RELEASE_APP_REPO} PR's base branch
```
gh pr view {number} --repo {GITHUB_ORG}/{RELEASE_APP_REPO} --json baseRefName,state
```
- If `state` is already `MERGED`: skip with a note.
- If `baseRefName` is not `staging`: flag as "expected base=staging, got {branch} — needs manual review", skip it.

### 4b — Merge each feature PR into staging
For each valid {RELEASE_APP_REPO} PR (in report order):
```
gh pr merge {number} --repo {GITHUB_ORG}/{RELEASE_APP_REPO} --merge
```
Report each merge as it completes.

### 4c — Create the staging → main PR
After all feature PRs are merged into staging, create the release PR:
```
gh pr create \
  --repo {GITHUB_ORG}/{RELEASE_APP_REPO} \
  --base main \
  --head staging \
  --title "release: {JIRA-1} {JIRA-2} ... {YYYY-MM-DD}"
```
Title format: list every Jira ticket key from today's MT PRs, space-separated, then today's date. Example: `release: PROJ-3761 PROJ-20208 2026-04-13`

Report the new PR URL.

### 4d — Poll CI checks + kick off Phase 4 in parallel

Start a background poll that waits until at least one CI check appears on the PR (i.e., the first `gh pr checks` call returns any output rather than an empty result):

```bash
until gh pr checks {staging_pr_number} --repo {GITHUB_ORG}/{RELEASE_APP_REPO} 2>&1 | grep -q "."; do sleep 15; done
```

**As soon as checks are visible** (even if still pending), immediately invoke the `/releases-regression` skill in parallel — do not wait for CI to finish first. CI and the deploy/regression pipelines will run concurrently.

Then continue polling CI to completion in a second background task:
```bash
until ! gh pr checks {staging_pr_number} --repo {GITHUB_ORG}/{RELEASE_APP_REPO} 2>&1 | grep -q "pending"; do sleep 30; done && gh pr checks {staging_pr_number} --repo {GITHUB_ORG}/{RELEASE_APP_REPO} 2>&1
```

- Stop CI polling as soon as all checks have completed (pass or fail).
- Report all CI results: list any failing checks with their URLs so the user can send them to the dev for review.
- If the 15-minute timeout is reached with checks still pending: report current status and stop.

After reporting CI results, **do not post the `/fast-forward` comment yet** — both CI passing AND the Phase 4 regressions completing are required before fast-forward is allowed. Wait for `/releases-regression` (Phase 4) to finish and report its results. Only after both CI and regressions are complete, **stop and present a summary, then explicitly ask the user: "Ready to post /fast-forward?"** Do not proceed until the user says yes (e.g. "yes", "go ahead", "proceed"). GitHub PR approval status does NOT count as the user's confirmation — the user must explicitly authorize this step in the current conversation.

### 4e — Trigger fast-forward merge
Only after the user explicitly says to proceed:
```
MSYS_NO_PATHCONV=1 gh pr comment {staging_pr_number} --repo {GITHUB_ORG}/{RELEASE_APP_REPO} --body "/fast-forward"
```
`MSYS_NO_PATHCONV=1` is required — without it, Git bash on Windows converts `/fast-forward` to a file path (e.g. `C:/Program Files/Git/fast-forward`). This comment triggers the automation that performs the merge and creates the release tag. Report the comment URL.

### 4f — Poll for PR merge confirmation
Poll every 15 seconds (up to 5 minutes / 20 polls) until the PR state is `MERGED`:
```
gh pr view {staging_pr_number} --repo {GITHUB_ORG}/{RELEASE_APP_REPO} --json state
```
- Stop as soon as `state == "MERGED"` and report: `✓ {RELEASE_APP_REPO} staging → main merged`
- If 5 minutes elapse without merging, report the current state and stop — do not block.

### 4g — Poll for new release tag
Immediately after merge is confirmed, note the latest tag before the merge (captured in step 4e or check now). Then poll every 15 seconds (up to 5 minutes / 20 polls) for a new tag to appear:
```
gh release list --repo {GITHUB_ORG}/{RELEASE_APP_REPO} --limit 1 --json tagName,createdAt
```
- Stop as soon as a tag newer than the one that existed before the `/fast-forward` comment appears.
- Report: `✓ {RELEASE_APP_REPO} release tag created: v{version}`
- If 5 minutes elapse without a new tag, report and stop — the automation may still be running.

### 4h — Proceed to Phase 5
After the release tag is confirmed (or the 5-minute timeout is reached), output the Step 5 final report and then immediately invoke the `/releases-deploy` skill — do not wait for the user to prompt.

---

## Step 5 — Final Report

Output a summary after all processing:

```
Phase 3 Complete — {YYYY-MM-DD}

ST Releases:
✓ {repo} PR #{N} ({JIRA}) → v{version}
(one line per merged ST PR)

MT Release:
✓ {RELEASE_APP_REPO} PRs merged into staging: #{N} ({JIRA}), #{N} ({JIRA}), ...
✓ Staging → Main PR: {URL}
CI: [✓ all checks green] OR [⚠ failing: {check name} — {url}] OR [⏳ still running — check manually]

Flagged / Skipped:
⚠ {repo} PR #{N} ({JIRA}) — {reason}
(one line per skipped PR, grouped by reason)
```

If there are no flagged/skipped PRs, omit that section.

---

## Important Rules

- Always report progress as each merge completes — do not batch output until the end.
- Never force-merge a PR (`--force` or bypassing required checks) — if a merge fails, report the error and skip.
- Never push directly to `main`, `master`, `production-master`, or `staging` — only merge via PR.
- If `gh pr merge` fails for any reason (conflicts, required checks not met, etc.), report the error and move on to the next PR.
- For the MT staging→main PR: create it even if some {RELEASE_APP_REPO} PRs were skipped, as long as at least one was merged. If zero {RELEASE_APP_REPO} PRs were merged, skip PR creation and note it.
