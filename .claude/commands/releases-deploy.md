## Pre-flight — Read configuration

Before doing anything else, read the `.env` file at the repo root using the `Read` tool and extract these variables for use throughout this skill:

- `GITHUB_ORG`
- `RELEASE_DEPLOY_REPO`
- `RELEASE_APP_REPO`
- `RELEASE_MT_PROD_SITE_DIR`
- `RELEASE_BLT1_AUTOMATION_STAGING`

---

You are executing **Phase 5** of the daily release process: deploying today's release tag(s) to production via the dedicated production workflow(s).

## Deploy order — ST → RUX → MT

| Order | Track | Who / how | Workflow | Tag series | Typical duration |
|---|---|---|---|---|---|
| 1 | **ST** (single-tenant repos) | **Manual — the user handles this outside the skill** | — | per-repo semver | — |
| 2 | **RUX** | This skill, Step 4 | `deploy-rux.yml` | `v22.x.y` | **< 40 seconds** |
| 3 | **MT** (`{RELEASE_APP_REPO}`) | This skill, Steps 1–3 | `deploy-production.yml` | `v1.x.y` | 20+ minutes |

Run only the track(s) that produced a tag in Phase 3.

**ST deploys are the user's to run manually, and are NOT a blocker for RUX or MT.** This skill does not trigger them and must not wait on them. ST repos deploy independently of the app repos — do not ask the user to confirm ST is finished before starting RUX or MT, and never hold an app-repo deploy on ST state. The "1" in the table is the customary order, not a dependency.

**RUX before MT.** The two workflows share a WireGuard peer and cannot overlap (see below), so one must fully finish before the other starts. RUX goes first because it is a symlink swap over a prebuilt bundle and completes in **under 40 seconds**, whereas the MT deploy runs migrations plus a blocking e2e tollgate across every production site and takes 20+ minutes. Running the short one first frees the peer almost immediately; the reverse would hold a 40-second deploy behind a 20-minute one for no benefit.

> **Note on paired fixes.** When a ticket has both a RUX and a `{RELEASE_APP_REPO}` PR, this order briefly puts the front end in production ahead of its backend. The window is under a minute and the MT deploy follows straight after, so it is acceptable — but if a specific paired change would visibly break in that gap, say so and let the user decide the order for that release. Do not silently reorder.

---

## ⛔ CRITICAL — the two deploys must NEVER run at the same time

**Run one deploy to completion before triggering the other.** This is a hard serialization requirement, not a preference.

`deploy-production.yml` and `deploy-rux.yml` declare **different** GitHub concurrency groups — `ltc-production-wireguard` and `deploy-rux-{environment}-{site-directory}` respectively — so **GitHub will not serialize them for you**. Nothing in the platform prevents both from running simultaneously.

But both build the **same WireGuard tunnel with the same peer identity** to reach the same host:

- Same secret: `GOVOSGITBOT_WIREGUARD_PEER_PRIVATE_KEY` (from the shared `production` environment)
- Same single peer address: `WIREGUARD_PEER_ADDRESS = {WIREGUARD_PEER_ADDRESS}`
- Same interface name (`wg0`), same server (`{WIREGUARD_SERVER}`), same target host (`{DEPLOY_TARGET_HOST}`)

A WireGuard server binds one peer public key to one allowed IP. When two runners present that same identity from different source addresses, the server's endpoint for that peer flaps between them and one or both tunnels drop mid-run. Because the drop lands in the middle of SSH work, a deploy can fail **partway through** — artifact copied but symlink not repointed, or migrations half-applied. That is a far worse state than either failure alone.

**Rule:** trigger one deploy, poll it to a terminal conclusion, verify, and only then trigger the other. Before triggering either, confirm no run of *either* workflow is in flight:

```bash
gh run list --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --workflow deploy-production.yml --limit 5 --json databaseId,status,conclusion
gh run list --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --workflow deploy-rux.yml        --limit 5 --json databaseId,status,conclusion
```

If any run is `queued` or `in_progress`, **wait** — do not trigger.

This serialization is what makes the **ST → RUX → MT** order above a strict sequence rather than a preference: the RUX deploy must reach a terminal conclusion before the MT deploy is triggered. (It usually takes under 40 seconds, so the wait is negligible.)

> **Scope of this rule: production deploys only.** Phases 3 and 4 have no ordering requirement — both tracks' pre-fast-forward gates may run concurrently, and both `/fast-forward` comments may be posted at the same time when both are clean. Serialization starts here, at the production deploy.
>
> The one Phase 4 caveat: a Phase 4 regression run also drives `deploy-production.yml` against the production automation sites, so don't start a **production** RUX deploy while an MT regression run is still active — that's the same peer contention, not a phase-ordering rule.

---

## ⚠ Execution order vs step numbering

The step numbers below are historical and **do not** match the execution order. Run them in this sequence:

| Run | Section | Track |
|---|---|---|
| 1st | **Step 4** (4a–4f) | **RUX** production deploy — *if a RUX tag exists* |
| 2nd | **Step 1** → **Step 2** | **MT** go-ahead gate, then full production deploy |
| 3rd | **Step 3** | MT staging mirror (`{RELEASE_BLT1_AUTOMATION_STAGING}`) |
| 4th | **Notify** → **Final Report** | — |

RUX (Step 4) runs **first** because it finishes in under 40 seconds and frees the shared WireGuard peer; MT (Steps 1–3) is the 20-minute leg and goes second. If there is no RUX tag today, skip straight to Step 1 and the numbering reads normally.

Each track still has its **own** explicit go-ahead gate (Step 4a for RUX, Step 1 for MT) — one authorization never covers both.

---

## Overview

Phase 5 uses a single workflow — **`deploy-production.yml`** in `{GITHUB_ORG}/{RELEASE_DEPLOY_REPO}` — which has two modes:

1. **"Deploy to automation sites only"** — deploys + migrates the automation sites (`{RELEASE_MT_TENANT}` and `{RELEASE_SUTS_SITE_DIR}`, which share a database), runs the e2e suite against them, and stops. A safe rehearsal; this is also the mode Phase 4 (`/releases-regression`) uses against the `staging` branch.
2. **"Deploy to full production"** — deploys + migrates the automation sites, runs the **e2e regression suite as a blocking tollgate** against both automation sites (`{RELEASE_MT_TENANT}` and `{RELEASE_SUTS_TENANT}`), and **only if both e2e gates pass**, deploys + migrates every production site (`{RELEASE_MT_PROD_SITE_DIR}`, `{PROD_SITE_API}`, `{RELEASE_SUTS_PROD_SITE_DIR}`) together in the same run.

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

> **If a RUX tag exists, Step 4 runs before this** — deploy RUX first, confirm it reached a terminal conclusion, then start here.

Before triggering anything, **stop and present a summary of the release (tag + PRs), then explicitly ask the user: "Ready to deploy `{release_tag}` to full production?"**

Do not trigger the deploy until the user says yes in the current conversation (e.g. "yes", "go ahead", "proceed"). Full production deploys to live production and runs migrations on every production site — it is irreversible. Prerequisites being met is **not** authorization; the user must explicitly authorize it here. GitHub state / a green staging PR does NOT count as confirmation.

A go-ahead given for the RUX deploy (Step 4a) does **not** authorize this one. Ask again, naming the MT tag.

**Before triggering: confirm the RUX deploy has fully finished** — no `queued` or `in_progress` run of `deploy-rux.yml` or `deploy-production.yml`. Shared WireGuard peer; they must never overlap.

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

> **Note on sites deployed.** `deploy-production.yml` deploys to the automation sites (`{RELEASE_MT_TENANT}`, `{RELEASE_SUTS_SITE_DIR}`) and the live production sites (`{RELEASE_MT_PROD_SITE_DIR}`, `{PROD_SITE_API}`, `{RELEASE_SUTS_PROD_SITE_DIR}`). It **also** deploys + migrates the staging `{RELEASE_MT_PROD_SITE_DIR}` site (plus checkout-only staging mirrors) and the `{QA_SITE}` QA site via its built-in `deploy-staging` and `deploy-qa-munirevs` jobs, which run after `deploy-production` succeeds. It does **not** deploy to the `blt1-automation` staging site — that is the sole remaining site handled by Step 3 below.

---

## Step 3 — Deploy to MT staging (`{RELEASE_BLT1_AUTOMATION_STAGING}` only)

`deploy-production.yml` now deploys + migrates staging `{RELEASE_MT_PROD_SITE_DIR}` itself (via its built-in `deploy-staging` job, which runs after `deploy-production` succeeds), so **do not** legacy-deploy `{RELEASE_MT_PROD_SITE_DIR}` here — doing so would deploy and migrate `{RELEASE_MT_PROD_SITE_DIR}` a second time in the same release. The only staging site the production workflow does **not** cover is `{RELEASE_BLT1_AUTOMATION_STAGING}`, so after the full-production deploy reaches a success state, deploy the same release tag to just that one site using the legacy workflow (this keeps its staging mirror in sync with production):

1. `{RELEASE_BLT1_AUTOMATION_STAGING}` (e.g. `blt1-automation`)

> **Skipped:** `{RELEASE_MT_PROD_SITE_DIR}` (e.g. `{RELEASE_MT_PROD_SITE_DIR}`) — now handled by `deploy-production.yml`'s `deploy-staging` job. (Historical note: prior to the BLTE-22905 `deploy-production.yml` change, Step 3 legacy-deployed both `{RELEASE_MT_PROD_SITE_DIR}` and `blt1-automation`.)

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

## Step 4 — Deploy RUX to production (only if Phase 3 cut a RUX tag)

> **Run this step FIRST**, before Steps 1–3. RUX completes in under 40 seconds and frees the shared WireGuard peer; MT is the 20-minute leg. See "Execution order vs step numbering" above. Skip this step entirely when there is no RUX tag today.

**Before triggering: confirm nothing is in flight** — no `queued` or `in_progress` run of `deploy-rux.yml` **or** `deploy-production.yml` (the latter includes any Phase 4 regression run). See the WireGuard serialization warning at the top of this skill; these two workflows share one peer identity and must never overlap.

### 4a — Explicit go-ahead gate (REQUIRED)

Ask: **"Ready to deploy RUX `{rux_tag}` to production?"** Wait for an explicit yes in the current conversation. This authorizes the **RUX** deploy only — the MT deploy needs its own go-ahead at Step 1, asked separately. One authorization never covers both tracks, in either direction.

### 4b — REQUIRED: confirm "Release and archive" has completed

**RUX must be built before it can be deployed** — unlike MRNexus (PHP, checked out directly on the server), RUX is React/TypeScript and ships as a prebuilt bundle. The `/fast-forward` triggers `on-push-default-branch.yml` in `{GITHUB_ORG}/RUX` (*"Release and archive"*), whose `Build application` → `Archive build artifact` jobs produce and upload `s3://{ARTIFACT_BUCKET}/RUX/releases/{tag}.tar.gz`. **That is the artifact this deploy downloads.**

Verify the run for this tag concluded `success` before triggering the deploy:

```bash
RUN=$(gh run list --repo {GITHUB_ORG}/RUX --workflow on-push-default-branch.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view $RUN --repo {GITHUB_ORG}/RUX --json status,conclusion,jobs \
  --jq '.status + " / " + (.conclusion // "-"), (.jobs[] | "  " + .name + " -> " + (.conclusion // .status))'
```

- Still `in_progress` → **wait.** Typical duration ~3 minutes.
- `success` → the artifact is published; proceed.
- Failed at `Build application` or `Archive build artifact` → **there is no artifact and the deploy cannot work.** Report and stop; the tag exists but is not deployable.
- Failed only at `add-jira-fix-version` → the artifact still published, so the deploy can proceed; note that Fix Versions need setting manually.

If the deploy is triggered too early it fails with "no artifact for branch/tag". That is a **timing** problem, not a bad tag — wait for the archive job and retry. **Never re-cut the tag.**

### 4c — Trigger the deploy

```bash
gh workflow run deploy-rux.yml \
  --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} \
  --field environment=production \
  --field release-tag={rux_tag} \
  --field site-directory=rux_releases
```

- `release-tag` must be the exact RUX tag from Phase 3 (e.g. `v22.11.4`). In production mode this selects `s3://{ARTIFACT_BUCKET}/RUX/releases/{tag}.tar.gz`.
- `site-directory` is `rux_releases` (the workflow default). The deploy extracts there and repoints the shared `/mnt/efs/www/rux` symlink.

Find the run ID and report the URL:

```bash
gh run list --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --workflow deploy-rux.yml --limit 3 --json databaseId,createdAt,status,conclusion
```

Poll to completion (`run_in_background: true`), comparing the status to the exact string `completed`:

```bash
until [ "$(gh run view {run_id} --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --json status --jq '.status')" = "completed" ]; do sleep 20; done; gh run view {run_id} --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --json status,conclusion --jq '.status + " / " + .conclusion'
```

### 4d — Evaluate the result

Fetch job/step detail:

```bash
gh run view {run_id} --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} --json jobs --jq '.jobs[] | {name: .name, conclusion: .conclusion, failedSteps: [.steps[]? | select(.conclusion == "failure") | .name]}'
```

- `success` → report `✓ RUX production deploy complete ({rux_tag})`.
- **`failure` where the sole failing step is `set Jira release to released`** → **known/expected, and the deploy SUCCEEDED.** The workflow's own failure message says so explicitly: *"The deployment … SUCCEEDED and the site is live. Only marking the Jira release BLT-RUX-{tag} as released failed. Do not redeploy; set the version to released in Jira manually."* This happens when the workflow can't find a matching Jira fix version (often a typo in a ticket key in the release PR title). Report as `⚠ RUX deploy complete ({rux_tag}) — Jira version step failed, expected; set the fix version manually`, and **do not redeploy**.
- Any other `failure` (`Download release file from S3`, `SCP build artifact`, `Extract tar.gz`, `Update symlink`, WireGuard/SSH setup) → a real failure. Report the failing job and step names with the run URL and stop. If it failed **after** the extract but before/during the symlink update, the site may still be serving the previous release — say so plainly rather than assuming either state.
- `cancelled` → report and stop.

> A senior engineer (training call, 2026-08-25) called out the Jira-version failure specifically: a red X on a RUX deploy frequently does **not** mean the deploy failed. Always read which step failed before reporting a RUX deploy as broken.

### 4e — Confirm Fix Versions in Jira

On success, each ticket in the RUX release should show the new version in its **Fix Version** field — set by the `add-jira-fix-version` job in "Release and archive" (Step 4b), not by the deploy. That job parses ticket keys from the `staging` → `main` PR title, so a ticket missing from that title gets no Fix Version. Spot-check one ticket; set any missing ones manually.

### 4f — Smoke check the new UI

**There is no e2e gate on the RUX deploy** — unlike the MT deploy, `deploy-rux.yml` runs no test suite. A senior engineer (training call part 2, 2026-08-25) explained why: RUX enforces unit tests and lint through a **pre-push git hook**, so problems are caught before a PR is ever opened rather than at deploy time.

That makes the post-deploy check manual and worth doing every time. Open a new-UI business center URL, confirm it loads and you can log in, and watch for console errors. Report what you checked.

The deploy itself is fast (a symlink swap over a prebuilt bundle) — seconds, not minutes.

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

RUX — release tag: {rux_tag}          (deployed first)
✓ Release and archive (RUX on-push-default-branch.yml) — {conclusion} — {run_url}
    semantic-release / add-jira-fix-version / Build application / Archive build artifact
✓ RUX production deploy — {conclusion} — {run_url}
    artifact: s3://{ARTIFACT_BUCKET}/RUX/releases/{rux_tag}.tar.gz
    Jira fix versions: [✓ set] OR [⚠ step failed — set manually (deploy still succeeded)]
    smoke check: [✓ new UI loads + login OK] OR [⚠ {what you saw}]

MT ({RELEASE_APP_REPO}) — release tag: {tag}
✓ Full production deploy — {conclusion} — {run_url}
    e2e gate ({RELEASE_MT_TENANT}): {conclusion}
    e2e gate ({RELEASE_SUTS_TENANT}): {conclusion}
    production sites ({RELEASE_MT_PROD_SITE_DIR}, {PROD_SITE_API}, {RELEASE_SUTS_PROD_SITE_DIR}): deployed & migrated
    staging {RELEASE_MT_PROD_SITE_DIR} + qa {QA_SITE}: deployed & migrated (via deploy-production.yml built-in jobs)
✓ MT staging deploy ({RELEASE_BLT1_AUTOMATION_STAGING} @ staging) — {conclusion} — {run_url}
```

Omit a track's section entirely if it had no tag today. If any job failed, include the failing job and step names so the user can investigate.

---

## Post-release — ticket status convention

Per team convention (training call, 2026-08-25), released tickets are **not** closed by the release process:

- Leave the status at **Ready for Release** — it isn't truly closed until verified in production.
- Set the **resolution** to reflect production testing (e.g. "tested in production").
- QA moves the ticket to **Closed / Done** after completing production verification.

Do not transition released tickets to Closed as part of Phase 5. Flag it if the user wants this changed — Allen noted a previous lead used a different convention, so confirm before deviating.

---

## Important Rules

- **Deploy order is ST → RUX → MT.** Only the RUX → MT leg is a hard constraint (shared WireGuard peer) — never start the MT deploy until the RUX deploy has reached a terminal conclusion. RUX goes first because it finishes in under 40 seconds while MT takes 20+ minutes. **ST is not a blocker for either app repo**: it is run manually by the user, deploys independently, and must never be waited on or confirmed before triggering RUX or MT.
- **Step numbers do not match execution order.** Step 4 (RUX) runs before Steps 1–3 (MT). See "Execution order vs step numbering" near the top.
- The standard flow is a single "Deploy to full production" trigger, gated on explicit user go-ahead obtained **before** triggering. Never trigger full production without that go-ahead. Do not run "automation sites only" as a pre-step unless the user explicitly asks (it would deploy the automation sites twice).
- After the full-production deploy succeeds, always run Step 3 (MT staging deploy via `legacy-deploy-blt-mt.yml`) for `{RELEASE_BLT1_AUTOMATION_STAGING}` only. `deploy-production.yml` now covers staging `{RELEASE_MT_PROD_SITE_DIR}` (and qa `{QA_SITE}`) via its built-in jobs, so **do not** legacy-deploy `{RELEASE_MT_PROD_SITE_DIR}` — but `{RELEASE_BLT1_AUTOMATION_STAGING}` is still not covered, so skipping Step 3 would leave that staging mirror behind production.
- The e2e tollgate inside the workflow is the release's regression check — never bypass it or override a failed gate without explicit user direction.
- Treat any failed job or step in the `deploy-production.yml` run (Steps 1–2) as a real failure — that workflow has no known-expected failures. Phase 5 has exactly **two** expected failures: the Step 3 `Run database migrations` step on `{RELEASE_BLT1_AUTOMATION_STAGING}`, and the Step 4 `set Jira release to released` step on a RUX deploy (deploy still succeeded — never redeploy on that one).
- **Never run `deploy-production.yml` and `deploy-rux.yml` against production concurrently.** Their GitHub concurrency groups differ, so the platform will not stop you — but they share one WireGuard peer identity (`{WIREGUARD_PEER_ADDRESS}`, same key, same server, same host) and overlapping runs can drop either tunnel mid-deploy, leaving a partial deploy. Always check both workflows for `queued`/`in_progress` runs first, and finish one before starting the other.
- **This is a Phase 5 constraint only.** Phase 3 and Phase 4 have no ordering requirement — both tracks' merges, CI, pre-fast-forward gates, and `/fast-forward` comments may all happen in parallel. Do not impose sequencing on the earlier phases.
- Never re-trigger a workflow while a production run is already in progress (production deploys share a single WireGuard peer and must not overlap).
- **Authorize each track separately.** Explicit go-ahead for the MT deploy does not authorize the RUX deploy, and vice versa. Ask per track, naming the repo and tag.
- A red X on a RUX deploy is not automatically a failed deploy — check *which* step failed before reporting. The Jira-version step failing means the site is live and must not be redeployed.
- **RUX must finish "Release and archive" before it can be deployed.** RUX is React/TypeScript and ships a prebuilt bundle; the `/fast-forward` build produces the S3 artifact the deploy downloads. MRNexus (PHP) has no such step. Triggering the RUX deploy early fails with "no artifact" — wait (~3 min), never re-cut the tag.
- **The RUX deploy runs no e2e suite.** RUX enforces unit tests and lint via a pre-push git hook instead, so verification is a manual smoke check of the new UI after deploy. Do not report a RUX deploy as regression-verified.

---

## Appendix — Optional: "Deploy to automation sites only" rehearsal

Not part of the standard flow. Use only if the user explicitly wants to validate the tag on the automation sites before committing to production. It deploys + migrates `{RELEASE_MT_TENANT}` and `{RELEASE_SUTS_SITE_DIR}`, runs the e2e suite against them, then stops (no production deploy).

> This is the same mode Phase 4 (`/releases-regression`) uses — Phase 4 points it at the `staging` branch, whereas this rehearsal points it at a release tag. Since ltc-deployment PR #62 (BLTE-23564), this mode **does** run e2e (earlier docs said it did not).

```bash
gh workflow run deploy-production.yml \
  --repo {GITHUB_ORG}/{RELEASE_DEPLOY_REPO} \
  --field deploy-target="Deploy to automation sites only" \
  --field release-tag={release_tag}
```

Find and poll the run the same way as Step 2. On success, report `✓ Automation deploy complete`; on failure, report the failing job/step and stop. Running this first does **not** replace the full-production run — the full-production run still re-deploys the automation sites — so only do it when the rehearsal value is worth the extra automation deploy.
