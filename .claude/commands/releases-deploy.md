## Pre-flight — Read configuration

Before doing anything else, read the `.env` file at the repo root using the `Read` tool and extract these variables for use throughout this skill:

- `GITHUB_ORG`
- `RELEASE_DEPLOY_REPO`
- `RELEASE_APP_REPO`
- `RELEASE_MT_PROD_SITE_DIR`
- `RELEASE_SUTS_PROD_SITE_DIR`

---

You are executing Phase 5 of the daily release process: deploying today's release tag to the production and staging environments.

## Overview

This phase deploys the {RELEASE_APP_REPO} release tag (created in Phase 3) to three environments using the `legacy-deploy-blt-mt.yml` workflow, in this order:

1. MT production
2. SUTS production
3. MT staging

**These must run strictly sequentially.** Do not start the next step until the previous step has reached a "proceed" state (clean success, or only known-expected step failures — see each step for details).

The MT production step has one known-expected step failure (`"set Jira release to released"`). The SUTS production step has two known-expected step failures (`"set Jira release to released"` and/or `"Run database migrations"`). Any other failing step is a real failure — stop and report it immediately.

## Inputs

The release tag is the {RELEASE_APP_REPO} tag created in Phase 3 (e.g. `v1.222.1`). If this skill is invoked standalone, check the latest tag:

```bash
gh release list --repo {GITHUB_ORG}/{RELEASE_APP_REPO} --limit 1 --json tagName --jq '.[0].tagName'
```

---

## Step 1 — Deploy to Production

```bash
gh workflow run legacy-deploy-blt-mt.yml \
  --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} \
  --field environment=production \
  --field release-tag={release_tag} \
  --field site-directory={RELEASE_MT_PROD_SITE_DIR} \
  --field has-migrations=true
```

Find the run ID by listing recent runs and picking the newest `createdAt`:

```bash
gh run list --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --workflow legacy-deploy-blt-mt.yml --limit 3 --json databaseId,createdAt,status,conclusion
```

Report the run URL: `https://github.com/{GITHUB_ORG}/{RELEASE_DEPLOY_REPO}/actions/runs/{id}`

Poll until complete:

```bash
until gh run view {run_id} --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --json status --jq '.status' | grep -qE "completed"; do sleep 20; done && gh run view {run_id} --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --json status,conclusion --jq '{status,conclusion}'
```

Use `run_in_background: true`.

Fetch job/step details regardless of conclusion:

```bash
gh run view {run_id} --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --json jobs --jq '.jobs[] | {name: .name, conclusion: .conclusion, failedSteps: [.steps[]? | select(.conclusion == "failure") | .name]}'
```

- `success` → report `✓ Production deploy complete` and proceed to Step 2.
- `failure` where the only failing step is `"set Jira release to released"` → this is a known/expected failure for the production environment. Both "Deploy specified release tag" and "Run database migrations" will have succeeded. Report it as `⚠ Production deploy complete (Jira step failed — expected)` and proceed to Step 2.
- `failure` for any other step, or `cancelled` → report the failure prominently and **stop**. Do not trigger SUTS or staging.

---

## Step 2 — Deploy to SUTS Production

Only after MT production reaches a "proceed" state:

```bash
gh workflow run legacy-deploy-blt-mt.yml \
  --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} \
  --field environment=production \
  --field release-tag={release_tag} \
  --field site-directory={RELEASE_SUTS_PROD_SITE_DIR} \
  --field has-migrations=true
```

Note: `release-tag` is the actual Phase 3 tag (e.g. `v1.222.1`), not `staging`.

Find the run ID by listing recent runs and picking the newest `createdAt` (newer than the MT production run from Step 1):

```bash
gh run list --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --workflow legacy-deploy-blt-mt.yml --limit 3 --json databaseId,createdAt,status,conclusion
```

Report the run URL: `https://github.com/{GITHUB_ORG}/{RELEASE_DEPLOY_REPO}/actions/runs/{id}`

Poll until complete using the same background pattern as Step 1:

```bash
until gh run view {run_id} --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --json status --jq '.status' | grep -qE "completed"; do sleep 20; done && gh run view {run_id} --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --json status,conclusion --jq '{status,conclusion}'
```

Use `run_in_background: true`.

Fetch job/step details regardless of conclusion:

```bash
gh run view {run_id} --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --json jobs --jq '.jobs[] | {name: .name, conclusion: .conclusion, failedSteps: [.steps[]? | select(.conclusion == "failure") | .name]}'
```

- `success` → report `✓ SUTS production deploy complete` and proceed to Step 3.
- `failure` where every failing step is in the set `{"set Jira release to released", "Run database migrations"}` (one or both) → these are known/expected failures for SUTS. The release tag was deployed successfully. Report it as `⚠ SUTS production deploy complete (known step(s) failed — expected: <list>)` and proceed to Step 3.
- `failure` for any other step, or `cancelled` → report the failure prominently and **stop**. Do not trigger MT staging.

---

## Step 3 — Deploy to MT Staging

Only after SUTS reaches a "proceed" state:

```bash
gh workflow run legacy-deploy-blt-mt.yml \
  --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} \
  --field environment=staging \
  --field release-tag={release_tag} \
  --field site-directory={RELEASE_MT_PROD_SITE_DIR} \
  --field has-migrations=true
```

Find the run ID the same way as Step 1. Poll until complete using the same pattern.

- `success` → report `✓ Staging deploy complete`
- `failure` or `cancelled` → fetch job/step details, report the failure prominently, and **stop**.

---

## Step 3.5 — Notify Release Team channel

After staging deploy succeeds, display the following and ask the user to post it in the **Release Team 🚀** channel before you present the Final Report:

> `I'm done with today's MT release, if someone needs to do theirs`

Channel link: `[your-release-team-channel-link]` *(update this with your organization's Teams channel deep link)*

Wait for the user to confirm ("posted", "done", etc.) before presenting the Final Report.

**Note:** Automated posting to Teams is not available — this step relies on the user posting manually.

---

## Step 4 — Final Report

```
Phase 5 Complete — {YYYY-MM-DD}

Release tag: {tag}
✓/✗/⚠ MT production deploy — {conclusion} — {run_url}
✓/✗/⚠ SUTS production deploy — {conclusion} — {run_url}
✓/✗ MT staging deploy — {conclusion} — {run_url}
```

If any deploy failed, include the failing job and step names so the user can investigate.

---

## Important Rules

- Always deploy in this order: MT production → SUTS production → MT staging — never reverse.
- Never trigger the next step if the previous step had any failing step outside the known-expected set. Known-expected step failures (MT production: `"set Jira release to released"`; SUTS production: `"set Jira release to released"` and/or `"Run database migrations"`) do not block progression.
- Any failing step outside the known-expected sets is a real failure — stop and surface it to the user.
- Never re-trigger a workflow that is already running for the same environment.
