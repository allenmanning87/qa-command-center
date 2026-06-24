# RETIRED — Phase 4 (`/releases-regression`) has been folded into Phase 5

**Do not run any deploy or test workflows from this skill.** As of the move to the `deploy-production.yml` production workflow, the standalone staging-regression phase no longer exists.

## Why

The e2e regression suite this phase used to trigger (`e2e-tests-single-site.yml` against the MT and SUTS automation tenants) is now run **inside** the Phase 5 production deploy as a **blocking tollgate** (`deploy-production.yml` invokes `release-e2e-automation.yml`, which is the same suite). It runs against the real release tag on production-grade automation sites, and production will not deploy unless both e2e gates pass.

Running this phase separately would re-run the identical suite — wasted time with no added safety.

## What to do instead

- **Phase 3 merge** (`/releases-merge`) now gates only on the staging PR's CI being green, then waits for explicit go-ahead to post `/fast-forward`.
- **Phase 5 deploy** (`/releases-deploy`) runs the e2e regression as a built-in gate. See that skill.

If you reached this skill, hand off to `/releases-deploy` (or return to `/releases-merge` if the staging PR has not been fast-forwarded yet). Do not trigger `e2e-tests-single-site.yml` or any deploy workflow from here.
