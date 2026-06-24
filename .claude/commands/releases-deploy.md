## Pre-flight — Read configuration

Before doing anything else, read the `.env` file at the repo root using the `Read` tool and extract these variables for use throughout this skill:

- `GITHUB_ORG`
- `RELEASE_DEPLOY_REPO`
- `RELEASE_APP_REPO`
- `RELEASE_MT_PROD_SITE_DIR`
- `RELEASE_BLT1_AUTOMATION_STAGING`

---

You are executing **Phase 5** of the daily release process: deploying today's release tag to production via the dedicated production workflow.

## Overview

Phase 5 uses a single workflow — **`deploy-production.yml`** in `{GITHUB_ORG}/{RELEASE_DEPLOY_REPO}` — which has two modes:

1. **"Deploy to automation site only"** — deploys + migrates the automation sites (`blt1-automation-production` and `colorado-automation-production`, which share a database) and stops. A safe rehearsal.
2. **"Deploy to full production"** — deploys + migrates the automation sites, runs the **e2e regression suite as a blocking tollgate** against both automation sites (`blt1-automation-production` and `suts-automation-production`), and **only if both e2e gates pass**, deploys + migrates every production site (`nexus8`, `nexus8-api`, `govos-blt-colorado`) together in the same run.

This e2e gate is the **same suite that the retired Phase 4 (`/releases-regression`) used to run** — it now runs here, against the real release tag, on production-grade automation sites, as a hard gate. There is no separate regression phase.

**The standard path is a single "Deploy to full production" trigger, gated on explicit user go-ahead.** Full-production mode already deploys + migrates the automation sites, runs the e2e gate, and deploys all production sites in one run — so there is no need to run "automation site only" first (doing so would deploy the automation sites twice).

```
⛔ STOP — ask the user for explicit go-ahead
"Deploy to full production"  → automation deploy → e2e gate → all prod sites (one run)
```

"Deploy to automation site only" remains available as an **optional manual rehearsal** (e.g. to validate a tag on the automation sites before committing to production), but it is **not** part of the standard flow — skip it unless the user explicitly asks for it. See the appendix at the end of this skill.

> **Access note:** the workflow enforces an allowlist (`DEPLOY_TO_PRODUCTION_ALLOW`) against the GitHub user who triggers it. If the trigger fails on "Perform access control", the triggering account is not on the allowlist — report it and stop.

> **No known-expected failures in `deploy-production.yml`.** Unlike the old `legacy-deploy-blt-mt.yml` flow, the production workflow has no "set Jira release to released" step and no standalone SUTS-migration step. Treat **any** failed job or step in Steps 1–2 (the `deploy-production.yml` run) as a real failure — report it and stop. (The old expected-failure list no longer applies to the production workflow.) The one exception in this skill is the Step 3 staging deploy on `{RELEASE_BLT1_AUTOMATION_STAGING}`, where a "Run database migrations" failure is expected — see Step 3.

## Inputs

The release tag is the `{RELEASE_APP_REPO}` tag created in Phase 3. If invoked standalone, check the latest tag:

```bash
gh release list --repo {GITHUB_ORG}/{RELEASE_APP_REPO} --limit 1 --json tagName --jq '.[0].tagName'
```

Use the tag string **exactly as it exists** on the repo (e.g. `v1.222.1`). The workflow checks out `origin/{release-tag}`, so the value must match the real tag ref.

---

## Step 1 — Explicit go-ahead gate (REQUIRED)

Before triggering anything, **stop and present a summary of the release (tag + PRs), then explicitly ask the user: "Ready to deploy `{release_tag}` to full production?"**

Do not trigger the deploy until the user says yes in the current conversation (e.g. "yes", "go ahead", "proceed"). Full production deploys to live production and runs migrations on every production site — it is irreversible. Prerequisites being met is **not** authorization; the user must explicitly authorize it here. GitHub state / a green staging PR does NOT count as confirmation.

---

## Step 2 — Deploy to full production

Only after the user explicitly authorizes:

```bash
gh workflow run deploy-production.yml \
  --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} \
  --field deploy-target="Deploy to full production" \
  --field release-tag={release_tag}
```

Find the run ID (newest `createdAt`) and report the run URL:

```bash
gh run list --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --workflow deploy-production.yml --limit 3 --json databaseId,createdAt,status,conclusion
```

Report the run URL: `https://github.com/{GITHUB_ORG}/{RELEASE_DEPLOY_REPO}/actions/runs/{id}`

Poll to completion (use `run_in_background: true`):

```bash
until gh run view {run_id} --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --json status --jq '.status' | grep -qE "completed"; do sleep 30; done && gh run view {run_id} --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --json status,conclusion --jq '{status,conclusion}'
```

This run contains four jobs: `deploy-automation` → (`e2e-blt`, `e2e-suts`) → `deploy-production`. Fetch job-level results:

```bash
gh run view {run_id} --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --json jobs --jq '.jobs[] | {name: .name, conclusion: .conclusion, failedSteps: [.steps[]? | select(.conclusion == "failure") | .name]}'
```

- `success` → all gates passed and every production site is deployed + migrated. Report `✓ Full production deploy complete`.
- **`e2e-blt` or `e2e-suts` failed** → the e2e tollgate blocked production by design; `deploy-production` will be skipped (production was NOT deployed). Report which gate failed with the run URL so the user can review the e2e failures. **Do not** attempt to bypass the gate or re-trigger with a different mode without explicit user direction. Stop.
- **`deploy-automation` or `deploy-production` failed** → report the failing job and step names prominently and **stop**. Note that if `deploy-production` failed mid-run, production sites may be partially deployed — surface this clearly.
- `cancelled` → report and stop.

> **Note on sites deployed.** `deploy-production.yml` deploys to the automation sites (`blt1-automation-production`, `colorado-automation-production`) and the live production sites (`nexus8`, `nexus8-api`, `govos-blt-colorado`). It does **not** deploy to any staging site — that is handled by Step 3 below.

---

## Step 3 — Deploy to MT staging (two sites, sequentially)

`deploy-production.yml` does not touch any staging site, so after the full-production deploy reaches a success state, deploy the same release tag to **both** MT staging site directories using the legacy workflow (this keeps the staging mirrors in sync with production, as the old Phase 5 did):

1. `{RELEASE_MT_PROD_SITE_DIR}` (e.g. `nexus8`)
2. `{RELEASE_BLT1_AUTOMATION_STAGING}` (e.g. `blt1-automation`)

**Run them strictly sequentially — site 1 to completion, then site 2.** Both runs target `environment=staging`, so they share the workflow's `ltc-staging-wireguard` concurrency lock (`cancel-in-progress: false`). Triggering both at once would queue the second behind the first; rather than rely on the pending queue (which holds only one run and can be bumped by any other staging trigger), trigger site 2 only after site 1 completes. Do **not** run them concurrently.

For **each** site directory `{SITE}` in the order above:

```bash
gh workflow run legacy-deploy-blt-mt.yml \
  --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} \
  --field environment=staging \
  --field release-tag={release_tag} \
  --field site-directory={SITE} \
  --field has-migrations=true
```

Find the run ID (newest `createdAt`) and report the run URL:

```bash
gh run list --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --workflow legacy-deploy-blt-mt.yml --limit 3 --json databaseId,createdAt,status,conclusion
```

Poll to completion (`run_in_background: true`):

```bash
until gh run view {run_id} --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --json status --jq '.status' | grep -qE "completed"; do sleep 20; done && gh run view {run_id} --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --json status,conclusion --jq '{status,conclusion}'
```

Fetch job/step detail:

```bash
gh run view {run_id} --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --json jobs --jq '.jobs[] | {name: .name, conclusion: .conclusion, failedSteps: [.steps[]? | select(.conclusion == "failure") | .name]}'
```

- `success` → report `✓ MT staging deploy complete ({SITE})` and move to the next site.
- **`{RELEASE_BLT1_AUTOMATION_STAGING}` only — `failure` where the sole failing step is `"Run database migrations"`** → **known/expected** for this site. The release tag is deployed (checkout succeeds before migrations run); the migration-step failure is expected behavior on this environment and needs no action. Report as `⚠ MT staging deploy complete ({SITE} — migration step failed, expected)` and proceed. (Observed cause: `console.php` cannot bootstrap the migrations command on this site — a known limitation of the `blt1-automation` staging environment.)
- Any other `failure` / `cancelled` — including **any** failure on `{RELEASE_MT_PROD_SITE_DIR}`, or a `{RELEASE_BLT1_AUTOMATION_STAGING}` failure in a step **other than** "Run database migrations" — → fetch job/step detail and report the failure prominently. (Production is already live at this point; a staging failure does not roll back production, but flag it so the staging mirror gets fixed.) Still attempt the second site unless the failure indicates the runner/lock is stuck.

---

## Step — Notify Release Team channel

After the full-production deploy succeeds, display the following and ask the user to post it in the **Release Team 🚀** channel before you present the Final Report:

> `I'm done with today's MT release, if someone needs to do theirs`

Wait for the user to confirm ("posted", "done", etc.) before presenting the Final Report.

**Note:** Automated posting to Teams is not available — this step relies on the user posting manually.

---

## Final Report

```
Phase 5 Complete — {YYYY-MM-DD}

Release tag: {tag}
✓ Full production deploy — {conclusion} — {run_url}
    e2e gate (blt1-automation-production): {conclusion}
    e2e gate (suts-automation-production): {conclusion}
    production sites (nexus8, nexus8-api, govos-blt-colorado): deployed & migrated
✓ MT staging deploy ({RELEASE_MT_PROD_SITE_DIR} @ staging) — {conclusion} — {run_url}
✓ MT staging deploy ({RELEASE_BLT1_AUTOMATION_STAGING} @ staging) — {conclusion} — {run_url}
```

If any job failed, include the failing job and step names so the user can investigate.

---

## Important Rules

- The standard flow is a single "Deploy to full production" trigger, gated on explicit user go-ahead obtained **before** triggering. Never trigger full production without that go-ahead. Do not run "automation site only" as a pre-step unless the user explicitly asks (it would deploy the automation sites twice).
- After the full-production deploy succeeds, always run Step 3 (MT staging deploy via `legacy-deploy-blt-mt.yml`). `deploy-production.yml` does not deploy staging, so skipping Step 3 would leave the staging mirror behind production.
- The e2e tollgate inside the workflow is the release's regression check — never bypass it or override a failed gate without explicit user direction.
- Treat any failed job or step in the `deploy-production.yml` run (Steps 1–2) as a real failure — that workflow has no known-expected failures. The only expected failure in Phase 5 is the Step 3 `Run database migrations` step on `{RELEASE_BLT1_AUTOMATION_STAGING}`.
- Never re-trigger the workflow while a production run is already in progress (production deploys share a single WireGuard peer and must not overlap).

---

## Appendix — Optional: "Deploy to automation site only" rehearsal

Not part of the standard flow. Use only if the user explicitly wants to validate the tag on the automation sites before committing to production. It deploys + migrates `blt1-automation-production` and `colorado-automation-production`, then stops (no e2e gate, no production deploy).

```bash
gh workflow run deploy-production.yml \
  --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} \
  --field deploy-target="Deploy to automation site only" \
  --field release-tag={release_tag}
```

Find and poll the run the same way as Step 2. On success, report `✓ Automation deploy complete`; on failure, report the failing job/step and stop. Running this first does **not** replace the full-production run — the full-production run still re-deploys the automation sites — so only do it when the rehearsal value is worth the extra automation deploy.
