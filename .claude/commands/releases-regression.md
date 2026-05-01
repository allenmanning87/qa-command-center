## Pre-flight — Read configuration

Before doing anything else, read the `.env` file at the repo root using the `Read` tool and extract these variables for use throughout this skill:

- `GITHUB_ORG`
- `RELEASE_DEPLOY_REPO`
- `RELEASE_APP_REPO`
- `RELEASE_MT_SITE_DIR`
- `RELEASE_MT_TENANT`
- `RELEASE_MT_TENANT_URL`
- `RELEASE_SUTS_SITE_DIR`
- `RELEASE_SUTS_TENANT`
- `RELEASE_SUTS_TENANT_URL`

---

You are executing Phase 4 of the daily release process: deploying the staging build to test environments and running UI regression tests.

## Overview

This phase runs two parallel deploy pipelines, each followed immediately by a regression test suite once its deploy completes. Do not wait for both deploys to finish before starting regressions — trigger each tenant's regression as soon as its own deploy is confirmed complete.

```
Deploy 1a (qa)          → Complete → E2E 1 ({RELEASE_MT_TENANT})
Deploy 1b (production)  → Complete → E2E 2 ({RELEASE_SUTS_TENANT})
```

## Environment & Workflow Reference

### Deploy 1a — QA environment
- **Repo**: `{GITHUB_ORG}/{RELEASE_DEPLOY_REPO}`
- **Workflow file**: `deploy-blt-mt.yml`
- **Inputs**:
  - `environment`: `qa`
  - `release-tag`: `staging`
  - `site-directory`: `{RELEASE_MT_SITE_DIR}`
  - `run-composer-install`: `true`
  - `db-migrations`: `true`

### Deploy 1b — SUTS production environment
- **Repo**: `{GITHUB_ORG}/{RELEASE_DEPLOY_REPO}`
- **Workflow file**: `legacy-deploy-blt-mt.yml`
- **Inputs**:
  - `environment`: `production`
  - `release-tag`: `staging`
  - `site-directory`: `{RELEASE_SUTS_SITE_DIR}`
  - `has-migrations`: `true`

### E2E Regression 1 — MT tenant (runs after Deploy 1a)
- **Repo**: `{GITHUB_ORG}/{RELEASE_APP_REPO}`
- **Workflow file**: `e2e-tests-single-site.yml`
- **Inputs**:
  - `tenant`: `{RELEASE_MT_TENANT}`
  - `tenantSiteUrl`: `{RELEASE_MT_TENANT_URL}`

### E2E Regression 2 — suts (runs after Deploy 1b)
- **Repo**: `{GITHUB_ORG}/{RELEASE_APP_REPO}`
- **Workflow file**: `e2e-tests-single-site.yml`
- **Inputs**:
  - `tenant`: `{RELEASE_SUTS_TENANT}`
  - `tenantSiteUrl`: `{RELEASE_SUTS_TENANT_URL}`

---

## Step 1 — Trigger Both Deploys in Parallel

Note the current UTC timestamp before triggering (used to identify the new runs). Then trigger both workflows simultaneously:

```bash
gh workflow run deploy-blt-mt.yml \
  --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} \
  --field environment=qa \
  --field release-tag=staging \
  --field site-directory={RELEASE_MT_SITE_DIR} \
  --field run-composer-install=true \
  --field db-migrations=true
```

```bash
gh workflow run legacy-deploy-blt-mt.yml \
  --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} \
  --field environment=production \
  --field release-tag=staging \
  --field site-directory={RELEASE_SUTS_SITE_DIR} \
  --field has-migrations=true
```

After triggering, find each run ID by listing recent runs for the workflow and picking the one with the newest `createdAt`:

```bash
gh run list --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --workflow deploy-blt-mt.yml --limit 3 --json databaseId,createdAt,status,conclusion
gh run list --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --workflow legacy-deploy-blt-mt.yml --limit 3 --json databaseId,createdAt,status,conclusion
```

Report both run IDs and their URLs (`https://github.com/{GITHUB_ORG}/{RELEASE_DEPLOY_REPO}/actions/runs/{id}`).

---

## Step 2 — Poll Deploys, Trigger E2E as Each Completes

Poll both deploys concurrently using background tasks. Use the pattern:

```bash
until gh run view {run_id} --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --json status --jq '.status' | grep -qE "completed"; do sleep 20; done && gh run view {run_id} --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --json status,conclusion --jq '{status,conclusion}'
```

Run this as `run_in_background: true` for each deploy independently.

**As soon as a deploy completes:**
1. Check its `conclusion`:
   - `success` → immediately trigger its paired E2E regression (see Step 3)
   - `failure` (Deploy 1a / QA) → report the failure, skip the paired E2E, continue monitoring the other deploy
   - `failure` (Deploy 1b / SUTS) → **check whether the failure is limited to the "Run database migrations" step**. Fetch the jobs for the run:
     ```bash
     gh run view {run_id} --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --json jobs --jq '.jobs[] | select(.conclusion == "failure") | .name'
     ```
     If the only failing job is `"Run database migrations"` (or contains "migration"), treat the deploy as **green**. The "Deploy specified release tag" step succeeds before migrations run, meaning the release tag was deployed successfully — the migration failure is expected/known behavior for SUTS. Proceed to trigger the SUTS E2E. Note the migration failure in the final report but do not skip the regression.
     If any job other than "Run database migrations" failed (e.g. "Deploy specified release tag" itself failed), treat as a genuine failure and skip the E2E.
   - `cancelled` → report, skip the paired E2E
2. Report: `✓ Deploy 1a complete (success)` or `✗ Deploy 1a failed — skipping E2E` or `⚠ Deploy 1b completed (migration failure expected — proceeding to E2E)`

---

## Step 3 — Trigger E2E Regression (as each deploy finishes)

Trigger the E2E immediately after its paired deploy succeeds. Note the timestamp before triggering to identify the run.

```bash
gh workflow run e2e-tests-single-site.yml \
  --repo {GITHUB_ORG}/{RELEASE_APP_REPO} \
  --field tenant={RELEASE_MT_TENANT} \
  --field tenantSiteUrl={RELEASE_MT_TENANT_URL}
```

```bash
gh workflow run e2e-tests-single-site.yml \
  --repo {GITHUB_ORG}/{RELEASE_APP_REPO} \
  --field tenant={RELEASE_SUTS_TENANT} \
  --field tenantSiteUrl={RELEASE_SUTS_TENANT_URL}
```

Find the run ID the same way as in Step 1 (newest run for `e2e-tests-single-site.yml`).

Report: `⏳ E2E triggered for {tenant} — run {url}`

---

## Step 4 — Poll E2E Results

Poll each E2E run to completion using the same background task pattern as Step 2, but against `{GITHUB_ORG}/{RELEASE_APP_REPO}`:

```bash
until gh run view {run_id} --repo {GITHUB_ORG}/{RELEASE_APP_REPO} --json status --jq '.status' | grep -qE "completed"; do sleep 30; done && gh run view {run_id} --repo {GITHUB_ORG}/{RELEASE_APP_REPO} --json status,conclusion --jq '{status,conclusion}'
```

E2E runs typically take 20–40 minutes. Use `run_in_background: true`.

When each completes, fetch the job-level results to surface any failures:

```bash
gh run view {run_id} --repo {GITHUB_ORG}/{RELEASE_APP_REPO} --json jobs --jq '.jobs[] | {name: .name, conclusion: .conclusion}'
```

---

## Step 5 — Final Report

After both E2E runs complete (or time out after 60 minutes), output:

```
Phase 4 Complete — {YYYY-MM-DD}

Deploys:
✓/✗ Deploy 1a (qa / {RELEASE_MT_SITE_DIR}) — {conclusion} — {run_url}
✓/✗ Deploy 1b (production / {RELEASE_SUTS_SITE_DIR}) — {conclusion} — {run_url}

Regressions:
✓/✗ E2E — {RELEASE_MT_TENANT} — {conclusion} — {run_url}
    [list any failed jobs]
✓/✗ E2E — {RELEASE_SUTS_TENANT} — {conclusion} — {run_url}
    [list any failed jobs]
```

If any E2E runs fail, list the failing job names so the user can investigate or re-run specific tests.

---

## Important Rules

- Never wait for both deploys to finish before starting regressions — trigger each tenant's E2E the moment its own deploy succeeds.
- If a deploy fails, skip that tenant's E2E and report it as skipped.
- If a run ID cannot be determined within 30 seconds of triggering, list the 3 most recent runs and ask the user to confirm which one to track.
- Do not re-trigger a workflow that is already running for the same environment.
- E2E failures do not block the release — report them so the user can review, but they are informational.
