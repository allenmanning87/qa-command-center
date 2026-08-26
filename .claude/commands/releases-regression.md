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

> **Prerequisite — satisfied.** This skill triggers `deploy-production.yml`'s **"Deploy to automation sites only"** mode and depends on that mode running the e2e suite. That behavior shipped in ltc-deployment PR #62 (BLTE-23564), **merged 2026-07-28**, which renamed the input to the plural `"Deploy to automation sites only"` and removed the `if` guard that previously skipped e2e in this mode. Nothing further is needed — the plural string is the current input value, and e2e runs.
>
> Still verify the e2e jobs actually **ran** (not `skipped`) when evaluating the gate in Step 3 — a green `deploy-automation` with skipped e2e is not a pass.

## Inputs

Phase 4 runs against the **`staging` branch** of `{RELEASE_APP_REPO}` — not a version tag. There is no tag yet (the tag is created by `/fast-forward` in Phase 3, which is gated on this phase passing).

If invoked from `/releases-merge`, the staging→main PR number and its green-CI status are already known. If invoked standalone, confirm with the user that Phase 3's staging PR CI is green before proceeding.

### Scope — both tracks get a pre-fast-forward gate

**RUX has the same pre-fast-forward gates as `{RELEASE_APP_REPO}`.** Each track validates its own `staging` branch on an automation site and runs the e2e suite before its `/fast-forward` is posted. The workflows differ; the gate does not.

| | MT (`{RELEASE_APP_REPO}`) | RUX |
|---|---|---|
| Build staging | (checked out by the deploy workflow) | `staging-build-and-archive.yml` in `{GITHUB_ORG}/RUX`, `branch=staging` → `s3://.../RUX/staging/staging.tar.gz` |
| Deploy staging to automation | `deploy-production.yml`, `deploy-target="Deploy to automation sites only"`, `release-tag=staging` | `deploy-rux.yml`, `environment=staging`, `release-tag=staging` |
| e2e suite | run inside `deploy-production.yml` | `release-e2e-automation.yml` (has `workflow_dispatch`) |

`deploy-production.yml` takes no RUX input, so it cannot validate a RUX build — **never pass it a RUX branch or tag.** RUX is gated by its own sequence above, not by the MT run.

**Both `/fast-forward` gates must be satisfied independently.** A green MT regression never authorizes the RUX fast-forward, and vice versa. Run the gate for each track that has a release in flight, and ask for each authorization separately.

> **Both tracks' Phase 4 gates may run concurrently.** There is no ordering requirement here — kick off the MT regression and the RUX build → staging deploy → e2e in parallel to save wall-clock. The strict **ST → RUX → MT** serialization applies only to the **production** deploys in Phase 5 (`/releases-deploy`), where the two workflows contend for the shared production WireGuard peer.

> **Confirm the RUX staging site directory before the first run.** `deploy-rux.yml`'s `site-directory` defaults to `rux_releases` (the production path). The staging/automation deploy targets a different directory — confirm the correct value with Arturo Rios / the RUX team rather than accepting the default, since the deploy repoints the shared `/mnt/efs/www/rux` symlink on whatever directory it is given.

---

## Step 1 — Trigger the regression run

Trigger `deploy-production.yml` in **"Deploy to automation sites only"** mode against the `staging` branch. This mode checks out `staging`, deploys + migrates both automation sites (`blt1-automation-production` + `colorado-automation-production`), and runs the e2e regression suite against them (`blt1-automation-production` + `suts-automation-production`), then stops — it does **not** deploy to production, staging, or qa (those jobs remain gated to full-production only).

```bash
gh workflow run deploy-production.yml \
  --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} \
  --field deploy-target="Deploy to automation sites only" \
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

**The entire workflow run must conclude `success` AND the e2e jobs must have actually run** — deploy, migrate, and the e2e regression jobs all green. There is no known-expected-failure allowance in Phase 4; treat any failed job or step as a real failure.

- **Run conclusion `success` and the e2e jobs ran (not skipped)** → regression passed. Report `✓ Phase 4 regression passed — {run_url}` and hand back to Phase 3 to proceed with the `/fast-forward` gate (see below).
- **e2e jobs `skipped`** → the workflow did not run regression (PR #62 not merged, or the mode's e2e guard is still live). This is **not** a pass — a green `deploy-automation` alone does not satisfy the gate. Report that e2e did not run, point to the #62 prerequisite / interim fallback in the pre-flight note, and **stop**. Do not proceed to `/fast-forward`.
- **Any failed job/step** (deploy, migrate, any `e2e / ...` job, or any other) → regression **failed**. Report the failing job and step names prominently with the run URL so the user can send them to the developer. **Do not** proceed to `/fast-forward`. Do **not** re-trigger or attempt to bypass the gate without explicit user direction. Stop.
- `cancelled` → report and stop.

---

## Step 4 — Hand back to Phase 3 (`/fast-forward` gate)

Phase 4 passing is a **prerequisite** for `/fast-forward`, not authorization for it. After reporting the pass:

**Do not post `/fast-forward` automatically.** Present a summary (staging PR CI green + Phase 4 regression green) and explicitly ask the user: **"Phase 4 regression passed on `staging`. Ready to post /fast-forward for `{RELEASE_APP_REPO}`?"** Do not proceed until the user says yes in the current conversation (e.g. "yes", "go ahead", "proceed"). GitHub PR approval status does NOT count as confirmation.

Name the repo in the prompt. This authorization covers the **MT** `/fast-forward` only — if a RUX release is also in flight, run the RUX gate (build → staging deploy → e2e, per the Scope table) and ask for its `/fast-forward` separately. One "yes" never covers both tracks.

Once the user authorizes, resume `/releases-merge` at step 4e (post `/fast-forward`, poll for merge + tag, then hand off to Phase 5 `/releases-deploy`).

---

## Final Report

```
Phase 4 Complete — {YYYY-MM-DD}

Regression run (deploy-production.yml "automation sites only" @ staging): {conclusion} — {run_url}
    deploy-automation: {conclusion}
    e2e (blt1-automation-production): {conclusion}
    e2e (suts-automation-production): {conclusion}

Gate (MT / {RELEASE_APP_REPO}): [✓ PASSED — ready for /fast-forward pending user go-ahead] OR [⚠ FAILED — /fast-forward blocked]
Gate (RUX): [✓ PASSED — ready for /fast-forward pending user go-ahead] OR [⚠ FAILED — /fast-forward blocked] OR [n/a — no RUX release today]
    staging build:  {conclusion} — {run_url}
    staging deploy: {conclusion} — {run_url}
    e2e:            {conclusion} — {run_url}
```

Include the RUX block only when a RUX release is in flight; omit it on MT-only days.

If any job failed, include the failing job and step names so the user can investigate.

---

## Important Rules

- Phase 4 runs against the **`staging` branch** (`release-tag=staging`), before any tag exists and before `/fast-forward`.
- The trigger uses the **plural** `"Deploy to automation sites only"` string — the current workflow input. (Renamed from the singular by ltc-deployment PR #62 / BLTE-23564, merged 2026-07-28; the singular no longer exists and will fail the `choice` input validation.)
- The entire workflow run must conclude `success` **and** the e2e jobs must have actually run (not skipped) — a green `deploy-automation` with skipped e2e is **not** a pass. No expected-failure allowance in this phase.
- Phase 4 passing does **not** authorize `/fast-forward` — the user must still explicitly authorize it (Step 4).
- **Both tracks get a pre-fast-forward gate, via different workflows.** MT uses `deploy-production.yml` ("automation sites only" @ `staging`). RUX uses `staging-build-and-archive.yml` (build branch `staging`) → `deploy-rux.yml` (`environment=staging`, `release-tag=staging`) → `release-e2e-automation.yml`. Never pass a RUX branch or tag to `deploy-production.yml` — it has no RUX input.
- A green gate on one track never authorizes the other track's `/fast-forward`. Satisfy and authorize each independently.
- **The two Phase 4 gates may run concurrently** — no ordering requirement in this phase. Serialization (ST → RUX → MT) applies only to the Phase 5 production deploys.
- Never bypass or re-trigger past a failed regression without explicit user direction.
- Never trigger this while a production `deploy-production.yml` run is already in progress (production deploys share a single WireGuard peer and must not overlap). If a run is in flight, wait for it to finish.
- **Poll on an exact status match**, e.g. `[ "$(gh run view {id} --json status --jq '.status')" = "completed" ]`. A `grep -q "completed"` on the run output can match a step-level conclusion and exit while the run is still in progress, producing a false result.
- This is the "automation sites only" mode — it does **not** deploy to live production, staging, or qa. Phase 5 (`/releases-deploy`) handles production, gated on its own e2e run against the real tag.
