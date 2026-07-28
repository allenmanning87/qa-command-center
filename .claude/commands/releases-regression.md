## Pre-flight — Read configuration

Before doing anything else, read the `.env` file at the repo root using the `Read` tool and extract these variables for use throughout this skill:

- `GITHUB_ORG`
- `RELEASE_DEPLOY_REPO`
- `RELEASE_APP_REPO`

---

# Regression (Phase 4)

You are executing **Phase 4** of the daily release process: running the e2e regression suite against the `staging` branch **before** the MT `/fast-forward`, so that no unreleased regressions reach `main`/production.

Phase 4 runs **after** Phase 3's staging→main PR CI is green and **before** the `/fast-forward` comment is posted. `/fast-forward` (Phase 3 step 4e) must **not** proceed until this regression run passes.

> **Why this exists again:** Phase 4 was previously retired on the assumption that the e2e suite inside `deploy-production.yml` (Phase 5) was sufficient. It is not — that gate runs against the built release *tag*, after `/fast-forward` has already merged staging into `main`. Running the same e2e suite against the `staging` **branch first** catches regressions before they land on `main`, so a bad staging build never gets fast-forwarded. Phase 5 still runs its own e2e gate against the real tag; the two are complementary, not redundant.

## Inputs

Phase 4 runs against the **`staging` branch** of `{RELEASE_APP_REPO}` — not a version tag. There is no tag yet (the tag is created by `/fast-forward` in Phase 3, which is gated on this phase passing).

If invoked from `/releases-merge`, the staging→main PR number and its green-CI status are already known. If invoked standalone, confirm with the user that Phase 3's staging PR CI is green before proceeding.

---

## Step 1 — Trigger the regression run

Trigger `deploy-production.yml` in **"Deploy to automation site only"** mode against the `staging` branch. This mode checks out `staging`, deploys + migrates the automation sites, and runs the e2e regression suite against them.

```bash
gh workflow run deploy-production.yml \
  --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} \
  --field deploy-target="Deploy to automation site only" \
  --field release-tag=staging
```

> `release-tag=staging` passes the branch name; the workflow checks out `origin/staging`. This is intentional for Phase 4 — we are validating the staging branch, not a release tag.

Find the run ID (newest `createdAt`) and report the run URL:

```bash
gh run list --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --workflow deploy-production.yml --limit 3 --json databaseId,createdAt,status,conclusion
```

Report the run URL: `https://github.com/{GITHUB_ORG}/{RELEASE_DEPLOY_REPO}/actions/runs/{id}`

> **Access note:** the workflow enforces an allowlist (`DEPLOY_TO_PRODUCTION_ALLOW`) against the GitHub user who triggers it. If the trigger fails on "Perform access control", the triggering account is not on the allowlist — report it and stop.

---

## Step 2 — Poll to completion

Poll the run to completion (use `run_in_background: true` — this run includes the e2e suite and takes a while):

```bash
until gh run view {run_id} --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --json status --jq '.status' | grep -qE "completed"; do sleep 30; done && gh run view {run_id} --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --json status,conclusion --jq '{status,conclusion}'
```

Fetch job-level results:

```bash
gh run view {run_id} --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --json jobs --jq '.jobs[] | {name: .name, conclusion: .conclusion, failedSteps: [.steps[]? | select(.conclusion == "failure") | .name]}'
```

---

## Step 3 — Evaluate the gate

**The entire workflow run must conclude `success`** — deploy, migrate, and the e2e regression jobs all green. There is no known-expected-failure allowance in Phase 4; treat any failed job or step as a real failure.

- **Run conclusion `success`** → regression passed. Report `✓ Phase 4 regression passed — {run_url}` and hand back to Phase 3 to proceed with the `/fast-forward` gate (see below).
- **Any failed job/step** (deploy, migrate, `e2e-blt`, `e2e-suts`, or any other) → regression **failed**. Report the failing job and step names prominently with the run URL so the user can send them to the developer. **Do not** proceed to `/fast-forward`. Do **not** re-trigger or attempt to bypass the gate without explicit user direction. Stop.
- `cancelled` → report and stop.

---

## Step 4 — Hand back to Phase 3 (`/fast-forward` gate)

Phase 4 passing is a **prerequisite** for `/fast-forward`, not authorization for it. After reporting the pass:

**Do not post `/fast-forward` automatically.** Present a summary (staging PR CI green + Phase 4 regression green) and explicitly ask the user: **"Phase 4 regression passed on `staging`. Ready to post /fast-forward?"** Do not proceed until the user says yes in the current conversation (e.g. "yes", "go ahead", "proceed"). GitHub PR approval status does NOT count as confirmation.

Once the user authorizes, resume `/releases-merge` at step 4e (post `/fast-forward`, poll for merge + tag, then hand off to Phase 5 `/releases-deploy`).

---

## Final Report

```
Phase 4 Complete — {YYYY-MM-DD}

Regression run ({RELEASE_APP_REPO} @ staging): {conclusion} — {run_url}
    deploy-automation: {conclusion}
    e2e (blt1-automation-production): {conclusion}
    e2e (suts-automation-production): {conclusion}

Gate: [✓ PASSED — ready for /fast-forward pending user go-ahead] OR [⚠ FAILED — /fast-forward blocked]
```

If any job failed, include the failing job and step names so the user can investigate.

---

## Important Rules

- Phase 4 runs against the **`staging` branch** (`release-tag=staging`), before any tag exists and before `/fast-forward`.
- The entire workflow run must conclude `success` — no expected-failure allowance in this phase.
- Phase 4 passing does **not** authorize `/fast-forward` — the user must still explicitly authorize it (Step 4).
- Never bypass or re-trigger past a failed regression without explicit user direction.
- Never trigger this while a production `deploy-production.yml` run is already in progress (production deploys share a single WireGuard peer and must not overlap). If a run is in flight, wait for it to finish.
- This is the "automation site only" mode — it does **not** deploy to live production. Phase 5 (`/releases-deploy`) handles production, gated on its own e2e run against the real tag.
