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

1. **"Deploy to automation sites only"** — deploys + migrates the automation sites (`blt1-automation-production` and `colorado-automation-production`, which share a database), runs the e2e suite against them, and stops. A safe rehearsal; this is also the mode Phase 4 (`/releases-regression`) uses against the `staging` branch.
2. **"Deploy to full production"** — deploys + migrates the automation sites, runs the **e2e regression suite as a blocking tollgate** against both automation sites (`blt1-automation-production` and `suts-automation-production`), and **only if both e2e gates pass**, deploys + migrates every production site (`nexus8`, `nexus8-api`, `govos-blt-colorado`) together in the same run.

This e2e gate runs the **same suite as Phase 4 (`/releases-regression`)**, but here it runs against the real release **tag** (on production-grade automation sites) as a hard gate before production sites deploy. Phase 4 runs the same suite earlier, against the `staging` **branch**, before `/fast-forward` — so a regression is caught before staging reaches `main`. The two runs are complementary: Phase 4 guards `main`, this Phase 5 gate guards production. Both must pass in their respective phases.

**The standard path is a single "Deploy to full production" trigger, gated on explicit user go-ahead.** Full-production mode already deploys + migrates the automation sites, runs the e2e gate, and deploys all production sites in one run — so there is no need to run "automation sites only" first (doing so would deploy the automation sites twice).

```
⛔ STOP — ask the user for explicit go-ahead
"Deploy to full production"  → automation deploy → e2e gate → all prod sites (one run)
```

"Deploy to automation sites only" remains available as an **optional manual rehearsal** (e.g. to validate a tag on the automation sites before committing to production), but it is **not** part of the standard flow — skip it unless the user explicitly asks for it. See the appendix at the end of this skill.

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

> **Note on sites deployed.** `deploy-production.yml` deploys to the automation sites (`blt1-automation-production`, `colorado-automation-production`) and the live production sites (`nexus8`, `nexus8-api`, `govos-blt-colorado`). It **also** deploys + migrates the staging `nexus8` site (plus checkout-only `suts-staging` / `sjc-staging`) and the `munirevs-mrnexus` QA site via its built-in `deploy-staging` and `deploy-qa-munirevs` jobs, which run after `deploy-production` succeeds. It does **not** deploy to the `blt1-automation` staging site — that is the sole remaining site handled by Step 3 below.

---

## Step 3 — Deploy to MT staging (`{RELEASE_BLT1_AUTOMATION_STAGING}` only)

`deploy-production.yml` now deploys + migrates staging `nexus8` itself (via its built-in `deploy-staging` job, which runs after `deploy-production` succeeds), so **do not** legacy-deploy `{RELEASE_MT_PROD_SITE_DIR}` here — doing so would deploy and migrate `nexus8` a second time in the same release. The only staging site the production workflow does **not** cover is `{RELEASE_BLT1_AUTOMATION_STAGING}`, so after the full-production deploy reaches a success state, deploy the same release tag to just that one site using the legacy workflow (this keeps its staging mirror in sync with production):

1. `{RELEASE_BLT1_AUTOMATION_STAGING}` (e.g. `blt1-automation`)

> **Skipped:** `{RELEASE_MT_PROD_SITE_DIR}` (e.g. `nexus8`) — now handled by `deploy-production.yml`'s `deploy-staging` job. (Historical note: prior to the BLTE-22905 `deploy-production.yml` change, Step 3 legacy-deployed both `nexus8` and `blt1-automation`.)

For the site directory `{SITE}` (`{RELEASE_BLT1_AUTOMATION_STAGING}`):

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

- `success` → report `✓ MT staging deploy complete ({SITE})`.
- **`failure` where the sole failing step is `"Run database migrations"`** → **known/expected** for `{RELEASE_BLT1_AUTOMATION_STAGING}`. The release tag is deployed (checkout succeeds before migrations run); the migration-step failure is expected behavior on this environment and needs no action. Report as `⚠ MT staging deploy complete ({SITE} — migration step failed, expected)` and proceed. (Observed cause: `console.php` cannot bootstrap the migrations command on this site — a known limitation of the `blt1-automation` staging environment.)
- Any other `failure` / `cancelled` — a `{RELEASE_BLT1_AUTOMATION_STAGING}` failure in a step **other than** "Run database migrations" — → fetch job/step detail and report the failure prominently. (Production is already live at this point; a staging failure does not roll back production, but flag it so the staging mirror gets fixed.)

---

## Step — Notify BLT-Eng General channel

After the full-production deploy succeeds, display the following and ask the user to post it in the **BLT-Eng General** channel before you present the Final Report:

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
    staging nexus8 + qa munirevs-mrnexus: deployed & migrated (via deploy-production.yml built-in jobs)
✓ MT staging deploy ({RELEASE_BLT1_AUTOMATION_STAGING} @ staging) — {conclusion} — {run_url}
```

If any job failed, include the failing job and step names so the user can investigate.

---

## Important Rules

- The standard flow is a single "Deploy to full production" trigger, gated on explicit user go-ahead obtained **before** triggering. Never trigger full production without that go-ahead. Do not run "automation sites only" as a pre-step unless the user explicitly asks (it would deploy the automation sites twice).
- After the full-production deploy succeeds, always run Step 3 (MT staging deploy via `legacy-deploy-blt-mt.yml`) for `{RELEASE_BLT1_AUTOMATION_STAGING}` only. `deploy-production.yml` now covers staging `nexus8` (and qa `munirevs-mrnexus`) via its built-in jobs, so **do not** legacy-deploy `nexus8` — but `{RELEASE_BLT1_AUTOMATION_STAGING}` is still not covered, so skipping Step 3 would leave that staging mirror behind production.
- The e2e tollgate inside the workflow is the release's regression check — never bypass it or override a failed gate without explicit user direction.
- Treat any failed job or step in the `deploy-production.yml` run (Steps 1–2) as a real failure — that workflow has no known-expected failures. The only expected failure in Phase 5 is the Step 3 `Run database migrations` step on `{RELEASE_BLT1_AUTOMATION_STAGING}`.
- Never re-trigger the workflow while a production run is already in progress (production deploys share a single WireGuard peer and must not overlap).

---

## Appendix — Optional: "Deploy to automation sites only" rehearsal

Not part of the standard flow. Use only if the user explicitly wants to validate the tag on the automation sites before committing to production. It deploys + migrates `blt1-automation-production` and `colorado-automation-production`, runs the e2e suite against them, then stops (no production deploy).

> This is the same mode Phase 4 (`/releases-regression`) uses — Phase 4 points it at the `staging` branch, whereas this rehearsal points it at a release tag. Since ltc-deployment PR #62 (BLTE-23564), this mode **does** run e2e (earlier docs said it did not).

```bash
gh workflow run deploy-production.yml \
  --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} \
  --field deploy-target="Deploy to automation sites only" \
  --field release-tag={release_tag}
```

Find and poll the run the same way as Step 2. On success, report `✓ Automation deploy complete`; on failure, report the failing job/step and stop. Running this first does **not** replace the full-production run — the full-production run still re-deploys the automation sites — so only do it when the rehearsal value is worth the extra automation deploy.
