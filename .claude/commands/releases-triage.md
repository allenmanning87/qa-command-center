## Pre-flight — Read configuration

Before doing anything else, read the `.env` file at the repo root using the `Read` tool and extract these variables for use throughout this skill:

- `JIRA_BASE_URL` → strip `https://` to get `{JIRA_DOMAIN}` (e.g. `your-company.atlassian.net`)
- `GITHUB_ORG`
- `JIRA_PROJECT`
- `JIRA_RELEASES_EPIC`
- `RELEASE_APP_REPO`
- `SUTS_API_RELEASE_OWNER` — the person who releases `SUTS-API` PRs (see Step 3.4)

> **`SUTS_API_RELEASE_OWNER` is a private value.** Resolve it from `.env` and use the real name **only when reporting to the user in chat** — "hand SUTS-API#63 to {name}" reads naturally and is what the user wants. Never write it into a Jira description, a Jira comment, a PR comment, a commit message, or any file under `.claude/` — those are published or tracked in a public repo. In written artifacts use "its designated owner". If the variable is unset or missing, fall back to "its designated owner" everywhere, including chat, and say once that `SUTS_API_RELEASE_OWNER` is unset.

---

You are executing **Phase 1** (Jira-story triage) and **Phase 2** (Jira story verification + PR list) of the daily release process.

- **Phase 1** = Steps 1–5: Resolve today's release story, read its linked tickets, discover the PR(s) for each ticket from its Jira comments, run the PR gates, output the triage report, and wait for you to confirm.
- **Phase 2** = Steps 6–7: Verify today's Daily Releases Jira story's fields and subtasks, and write the discovered PR list into the story's Dependencies section.
- **Phase 3** = `/releases-merge` skill (merge PRs, create release tags; gate on staging-PR CI, then Phase 4, then explicit go-ahead for `/fast-forward`)
- **Phase 4** = `/releases-regression` skill (e2e regression suite against the `staging` **branch**, via `deploy-production.yml` "Deploy to automation sites only" with `release-tag=staging`) — must pass **before** `/fast-forward`, so regressions are caught before staging reaches `main`
- **Phase 5** = `/releases-deploy` skill (production deploy via `deploy-production.yml`, which runs the same e2e suite against the built release **tag** as a built-in blocking tollgate)

> **Phase 4 is live.** It was briefly retired on the assumption that the Phase 5 e2e gate was sufficient, but that gate runs against the release *tag* only *after* `/fast-forward` has already merged staging into `main`. Phase 4 runs the same suite against the `staging` branch first, so a bad build never gets fast-forwarded. The two gates are complementary: **Phase 4 guards `main`, Phase 5 guards production.** Both must pass in their respective phases.

> **Source of truth changed:** release requests are no longer read from the `Release-Requests-Production` Teams channel. They are now the tickets **linked** to that day's release story under `{JIRA_RELEASES_EPIC}`. Because requesters no longer post PRs, triage **discovers each ticket's PR(s) by scanning that ticket's Jira comments**.

## Pre-flight — Determine the release blackout window

**Policy:** No releases are permitted during a blackout window of **4 business days** around the 20th of the month — **2 business days before the anchor, the anchor day itself, and 1 business day after the anchor** — *unless* the request is a **P0 or P1** priority ticket. During the blackout window, any linked ticket whose Jira priority is **not** P0/P1 must be **held** (excluded from today's release) and flagged in the report.

Compute the window up front, using today's date (the `currentDate` provided in context; confirm with `date +%F` if unsure):

1. **Determine the anchor.** Start from the **20th of the current month**. If the 20th is a Saturday or Sunday, **roll the anchor forward to the next business day** (Mon–Fri). Otherwise the anchor is the 20th. The anchor is always a business day.
2. Walk **backward 2 business days** (Mon–Fri, skipping Sat/Sun) from the anchor → blackout **start** date.
3. Walk **forward 1 business day** from the anchor → blackout **end** date.
4. The blackout window is `[start, end]` inclusive. It always contains exactly **4 business days**: the two before the anchor, the anchor, and the one after. *(Worked example A: July 2026 — the 20th is a Monday (business day), so anchor = Mon Jul 20; 2 business days before = Thu Jul 16 and Fri Jul 17, 1 business day after = Tue Jul 21 → blackout business days = **Thu Jul 16, Fri Jul 17, Mon Jul 20, Tue Jul 21**; window `[Jul 16, Jul 21]`.)* *(Worked example B: June 2026 — the 20th is a Saturday, so roll the anchor forward to Mon Jun 22; 2 business days before = Thu Jun 18 and Fri Jun 19, 1 business day after = Tue Jun 23 → blackout business days = **Thu Jun 18, Fri Jun 19, Mon Jun 22, Tue Jun 23**; window `[Jun 18, Jun 23]`.)*
5. Record whether **today** falls inside `[start, end]`. Store as `{IN_BLACKOUT}` (true/false). Always report the computed window in the Step 5 header, regardless of the value.

> Business-day counting excludes weekends only. If company holidays might shift the count, note the uncertainty in the report rather than guessing.

If `{IN_BLACKOUT}` is false, the priority gate in Step 3.8 is a no-op — every priority is eligible. Priority is still fetched and shown in the report for visibility.

### Priority → eligibility mapping

This Jira instance uses two overlapping priority naming schemes. A request is **blackout-eligible (P0/P1)** if its priority name matches any of:
- contains `(p0)` or `(p1)` — e.g. `Emergency (p0)`, `Critical (p1)`
- starts with `P1` — e.g. `P1 Highest-Critical`

**Everything else is held during blackout**, including: `Major (p2)`, `Minor (p3)`, `Trivial (p4)`, `P2 High`, `P3 Medium (Default)`, `P4 Low`.

## Pre-flight — Load deferred tools

All MCP tools used in this workflow are deferred and **must be loaded via ToolSearch before any other step**. Do this first, in parallel:

```
ToolSearch("select:mcp__claude_ai_Atlassian__searchJiraIssuesUsingJql")
ToolSearch("select:mcp__claude_ai_Atlassian__getJiraIssue")
ToolSearch("select:mcp__claude_ai_Atlassian__createIssueLink")
ToolSearch("select:mcp__claude_ai_Atlassian__addWorklogToJiraIssue")
```

Do not proceed until these tools are confirmed available. (`atlassianUserInfo`, `editJiraIssue`, `getTransitionsForJiraIssue`, and `transitionJiraIssue` are loaded on demand in Phase 2.)

## Step 1 — Resolve today's release story

The release story is the anchor for everything below: its linked tickets are the release requests.

1. **If the user provided a story key** in the invocation (e.g. `BLTE-23558`) → use it directly and skip to Step 2. Report the key so it's on the record.
2. **Otherwise, discover it by date.** Search under the epic using JQL (substitute `{TODAY}` = the ISO date from `currentDate`, and `{JIRA_RELEASES_EPIC}` from `.env`):

   ```
   summary ~ "Releases {TODAY}" AND parent = {JIRA_RELEASES_EPIC} AND statusCategory != Done
   ```

   - **Exactly one match** → use it.
   - **Zero matches** → fall back to the single newest non-Done release story under the epic:
     ```
     parent = {JIRA_RELEASES_EPIC} AND statusCategory != Done ORDER BY created DESC
     ```
     Take the newest result and **stop to confirm with the user** ("No story matched `Releases {TODAY}`. Newest open release story is `{KEY} — {summary}`. Use this one?") before proceeding. If the fallback also returns nothing, report that no open release story exists under the epic and stop.
   - **More than one match** → list all matches (`{KEY} — {summary}`) and ask the user which to use before proceeding.

3. Once resolved, report the story up front so the user can confirm the skill picked the right one:
   `Release story: https://{JIRA_BASE_URL}/browse/{STORY-KEY} — {summary}`

   Store the resolved key as `{STORY-KEY}` for the rest of the skill.

## Step 2 — Extract the linked tickets (the release requests)

Fetch the story with `getJiraIssue`:
- `issueIdOrKey`: `{STORY-KEY}`
- `fields`: `["summary","status","issuelinks","subtasks","assignee","description","customfield_11462","customfield_11477","customfield_11478","customfield_10028","timetracking"]`
- `responseContentFormat`: `"markdown"`

The release requests are every entry in `fields.issuelinks` where:
- `type.name == "Polaris work item link"` (id 10301), **and**
- the entry has an `outwardIssue` (these render as "implements" on the story).

Collect each such `outwardIssue.key` (the child ticket) along with its `fields.summary`, `fields.status.name`, and `fields.priority.name` (already present in the issuelinks payload).

- **All linked tickets are in scope regardless of status.** Capture and show each ticket's status in the report, but do **not** exclude a ticket because of its status.
- **All linked tickets are in scope regardless of issue type.** The link type is the only filter — `issuetype` is not. Bugs, Stories, Tasks and **Epics** all count as release requests when they are linked this way. An Epic linked to the release story is a request like any other: fetch its comments, discover its PR(s), run the gates on it, count it in `[N] linked tickets`, and give it a Dependencies bullet and review tabs. Do **not** treat an Epic as a container to expand, skip as "not a real request", or drop because its children are linked elsewhere — that silently shrinks the release. The same applies to any issue type not named here.
- **Normalize ticket keys to uppercase.** Tickets may span multiple projects (e.g. `BLI-*` and `BLTE-*`) — handle both.
- **Empty state:** if there are zero qualifying linked tickets, report `No tickets linked to {STORY-KEY} — nothing to triage.` and stop (do not proceed to PR discovery or Phase 2).

Keep the story's field/subtask/description data from this call for Phase 2 — no need to re-fetch it there.

## Step 3 — Discover the PR(s) for each linked ticket

**Speed rule:** As soon as the linked-ticket list is finalized (end of Step 2), fire the per-ticket comment fetches for **all** tickets in one parallel batch. Once PRs are extracted (Step 3.2), fire the PR gates (Steps 3.5 and 3.6) for all discovered PRs in a second parallel batch. SUTS detection (3.7) and the blackout gate (3.8) reuse data already in hand — no extra calls.

### Step 3.1 — Fetch ticket comments

Fetch each linked ticket with `getJiraIssue`, `fields: ["summary","status","comment","priority"]`, `responseContentFormat: "markdown"`. Fetch all tickets in parallel.

**Large response fallback:** If the tool output says `Output too large... saved to: C:/path/to/file.json`, use this Bash command to extract the comments (use forward slashes in the path):

```bash
node -e "
const fs = require('fs');
const raw = fs.readFileSync('C:/path/to/file.json', 'utf8');
const data = JSON.parse(raw);
const issue = Array.isArray(data) ? JSON.parse(data[0].text) : data;
console.log('Key:', issue.key, '| Status:', issue.fields.status.name);
function extractText(items) {
  let out = [];
  for (const i of (items||[])) {
    if (i.type==='text') out.push(i.text);
    else if (i.type==='mention') out.push(i.attrs.text);
    else if (i.type==='inlineCard') out.push(i.attrs.url);
    else if (i.type==='hardBreak') out.push('\n');
    else if (i.content) out.push(...extractText(i.content));
  }
  return out;
}
const comments = issue.fields.comment.comments.slice(-10);
for (const c of comments) {
  const txt = extractText(c.body && c.body.content || []).join('');
  console.log('['+c.created.substring(0,16)+'] '+c.author.displayName+':');
  console.log(txt.substring(0,800));
  console.log();
}
"
```

Note: Python is not available on this machine — always use Node.js (`node -e`) for Bash scripting.

**Markdown response path:** If the tool returns a markdown string directly (no file save), scan only the last ~10 comment blocks (search from the bottom of the response) rather than reading the full output.

### Step 3.2 — Extract PR URLs from comments

Scan each ticket's comment bodies for PR URLs matching `github.com/{GITHUB_ORG}/<repo>/pull/<N>`. **PRs appear in two forms in real comments — you must catch both:**

- **Markdown links:** `[#6899](https://github.com/{GITHUB_ORG}/MRNexus/pull/6899)` — the URL is in the parens (the link text may be `#N`, a repo path, or prose).
- **Atlassian smartlinks:** `<custom data-type="smartlink" data-id="...">https://github.com/{GITHUB_ORG}/alaska/pull/456</custom>` — the URL is the element's text content.

A robust approach: extract every substring matching the regex `https://github\.com/{GITHUB_ORG}/[A-Za-z0-9._-]+/pull/\d+` from the raw comment text, regardless of surrounding markdown or `<custom>` wrapping, then dedupe.

Also capture a `Branch:` / `BR:` value from the same comment when present (for developer follow-up / cross-checking) — but the **PR URL**, not the branch, is the release artifact.

### Step 3.3 — Pick the authoritative PR per ticket

- If multiple **comments** mention PRs → use the PR(s) from the **newest** such comment.
- If a single comment references **multiple distinct PRs** → list all of them and flag the ticket `MULTI-PR`.
- If the newest PR-comment and an older one reference **conflicting** PRs for the same repo → trust the newest, flag `LOW` confidence, note the discrepancy.

### Step 3.4 — Derive repo and MT/ST classification

For each discovered PR, parse `<repo>` from `github.com/{GITHUB_ORG}/<repo>/pull/N`, checking in this order:

- `<repo> == {RELEASE_APP_REPO}` (`MRNexus`) → **MT**.
- `<repo> == RUX` → **RUX**. A second staging-based app repo, released on the same cadence as `{RELEASE_APP_REPO}` — PRs base on `staging`, it runs full CI (PR-title conventions, Snyk), it carries its own release tags (e.g. `v22.11.3`) cut by a fast-forward of `staging` → `main`, and its default branch is `main`.
- `<repo> == SUTS-API` → **SUTS-API**. A **staging-based** repo: PRs base on `staging`, exactly like `{RELEASE_APP_REPO}` and `RUX`. Its GitHub *default* branch is `master`, which makes it look like an ST repo — **it is not.** Never retarget a SUTS-API PR to `master`.
- Any other repo → **ST** (merges to the repo's default branch, own semver tag per `/releases-merge`).

So there are **four** repo classes: **ST**, **MT** (`{RELEASE_APP_REPO}`), **RUX**, and **SUTS-API**. They are ordered ST → MT → RUX everywhere PRs are **listed** (see the `[PR LIST]` structure in Step 6); list SUTS-API PRs with the app repos, after MT.

> **SUTS-API is released by `{SUTS_API_RELEASE_OWNER}` only** (confirmed 2026-09-21). Triage gates SUTS-API PRs, reports them, and lists them in Dependencies like any other — but **do not merge or release a SUTS-API PR in Phase 3.** Hand it to `{SUTS_API_RELEASE_OWNER}` and note in the report that the release of that PR is theirs. Treat the base expectation as `staging` (same as RUX/MRNexus); only the *who releases it* differs.

> This is the **listing** order only. The Phase 5 **deploy** order is different — **ST → RUX → MT** — because RUX deploys in under 40 seconds and must clear the shared WireGuard peer before the 20-minute MT deploy starts. Don't infer deploy sequence from the Dependencies list.

> **RUX was previously excluded** as another team's responsibility. That changed as of **2026-08-25** — RUX releases are now part of this release process. Any older instruction to omit RUX PRs, tag them "handled by another team", or skip their review tabs is obsolete.
>
> **RUX tickets frequently carry a `{RELEASE_APP_REPO}` PR too — expect the pair.** On RUX sites, `RUX` serves the **business center** URLs while `{RELEASE_APP_REPO}` serves the **`/backend/admin/`** URLs; on MT sites `{RELEASE_APP_REPO}` serves both. So a change touching both halves of a RUX site lands as two PRs on one ticket — frontend in `RUX`, backend in `{RELEASE_APP_REPO}`.
>
> Treat that as a normal `MULTI-PR` ticket: **both** PRs belong in the release, each in its own section of the Dependencies list. It is not always a pair — plenty of RUX tickets are frontend-only, and plenty of `{RELEASE_APP_REPO}` tickets never touch RUX — so never invent a missing counterpart. But when a ticket's comments reference PRs in both repos, releasing only one half ships a partial fix. If one half is gate-excluded (unresolved comments, failing CI, conflicts) while the other is clean, **flag the ticket** and say plainly that only half the fix would ship, so the user can decide whether to hold both.

### Step 3.5 — No PR found

If no PR URL is discoverable in **any** comment on a ticket:
- Flag the ticket **NEEDS MANUAL REVIEW** with note `no PR found in ticket comments`.
- **Exclude** it from the Dependencies/merge PR list.
- Surface it prominently in the Step 5 report so the user can chase the developer.
- **Never guess a PR URL** — only report one that was actually found in a comment.

## Step 3.5b — Check each PR's review state and CI results

For every discovered PR (regardless of confidence level), run the following GraphQL query. It returns review threads, approval state, and CI check results in one call — **do not** issue separate queries for these. Run one query per PR, all in parallel.

```bash
gh api graphql -f query='{
  repository(owner: "{GITHUB_ORG}", name: "REPO") {
    pullRequest(number: N) {
      state
      isDraft
      mergeable
      mergeStateStatus
      baseRefName
      reviewDecision
      reviewThreads(first: 100) {
        nodes { isResolved isOutdated path line
                comments(first: 1) { nodes { author { login } createdAt } } }
      }
      commits(last: 1) { nodes { commit {
        statusCheckRollup {
          state
          contexts(first: 30) { nodes {
            __typename
            ... on CheckRun { name conclusion status detailsUrl }
            ... on StatusContext { context state targetUrl }
          } }
        }
      } } }
    }
  }
}'
```

Replace `REPO` with the repo name (e.g. `{RELEASE_APP_REPO}`, an ST repo) and `N` with the PR number.

Evaluate five gates from the single response. A PR can fail more than one; report every gate it fails.

**Check Gate 5 (base targeting) first.** Gates 1–4 are computed by GitHub against the PR's declared base, so their results are only meaningful once the base is known to be right. If Gate 5 forces a retarget, re-query and re-evaluate Gates 1–4 before reporting anything.

### Gate 1 — Unresolved review comments (`reviewThreads`)

- If **any** `isResolved` value is `false` → the PR has unresolved review comments. Flag it **SEND BACK TO DEVELOPER**. Do not release it.
- If all are `true` (or the array is empty) → passes.

Flag text: `⚠ UNRESOLVED COMMENTS — send back to developer (N threads)`. When reporting one, state **who** left the threads and **whether they are human or bot, stale or current** — a stale bot comment and a live human review request call for very different decisions, and the user needs that distinction to act.

> **Outdated bot threads are unreliable.** A thread with `isOutdated: true` (typically `copilot-pull-request-reviewer`) is collapsed in the GitHub UI, and resolving it there does not always write `isResolved: true` back to the API. So the API can report unresolved threads that the PR page shows as resolved. Still flag them — but say plainly in the Notes that they are outdated bot threads which may already be resolved, and that the PR page is authoritative. If the user confirms from the page that they are resolved, treat the PR as clean on this gate.

### Gate 2 — Approval state (`reviewDecision`)

- `APPROVED` → passes.
- `CHANGES_REQUESTED` → flag `⚠ CHANGES REQUESTED — send back to developer`. A reviewer has actively asked for changes; do not release it.
- `REVIEW_REQUIRED` / `null` → **no approving review recorded.** Whether this blocks depends on Gate 4: check `mergeStateStatus`.
  - `mergeStateStatus == BLOCKED` → branch protection is enforcing the approval and the merge genuinely cannot proceed. Flag `⚠ NOT APPROVED — merge blocked, no approver`.
  - Any other `mergeStateStatus` (e.g. `CLEAN`) → the repo does not require an approval to merge, so this is **not** a blocker. Do **not** flag it and do **not** treat it as an exception — the PR counts as clean. Some repos (notably `admin`) have no protection rule requiring review.

A Jira comment saying "code passed review" is **not** a substitute for a GitHub approval where branch protection requires one — in that case the merge is gated on the GitHub state, not the Jira note. When a ticket's comments claim approval but `reviewDecision` disagrees *and* the merge is `BLOCKED`, report both and say the GitHub record is what blocks the merge.

### Gate 3 — CI / unit tests (`statusCheckRollup`)

Read `statusCheckRollup.state` for the overall verdict, then `contexts.nodes[]` for which specific checks failed.

- `SUCCESS` → passes.
- `FAILURE` or `ERROR` → flag `⚠ CI FAILED — {check names}`. **Name the specific failing checks** (e.g. `🧪 Run PHPUnit Tests`) and include the `detailsUrl` for the failing run so the user can open it directly. A failing unit-test check means the PR is not releasable.
- `PENDING` → checks still running. Flag `⚠ CI PENDING — {check names}` and note that the result isn't known yet; the user may want to re-check before merging.
- **`statusCheckRollup` is `null`** → the repo has **no CI configured**. This is the normal state for ST repos, which have no GitHub Actions workflows. It is **not** a failure — do **not** flag it, and do **not** report it as a missing or skipped test run. Treat the gate as not applicable.

Individual checks with conclusion `SKIPPED` or `NEUTRAL` are also **not** failures (matrix jobs commonly skip). Only `FAILURE`/`ERROR`/`TIMED_OUT`/`CANCELLED` conclusions count against the PR.

### Gate 4 — Mergeability (`mergeable` / `mergeStateStatus` / `isDraft`)

**A PR that cannot merge is not releasable, no matter how clean everything else looks.** Merge conflicts are invisible in review threads, CI, and approval state — this gate is the only thing that catches them.

- `mergeable == CONFLICTING` (usually `mergeStateStatus == DIRTY`) → the branch conflicts with its base. Flag `⚠ MERGE CONFLICTS — needs rebase`. The developer must resolve against the base branch before this can be released.
- `isDraft == true` → flag `⚠ DRAFT PR — not ready to merge`.
- `mergeStateStatus == BLOCKED` → merge blocked by branch protection (missing required approval or a required check). Pair this with the Gate 2 / Gate 3 finding that explains *why*.
- `mergeStateStatus == BEHIND` → the branch is behind its base. **This is never a triage-time blocker, in any repo.**
  - **`RUX` → expected, not a defect. Do not flag it and do not exclude the PR.** RUX has `allow_merge_commit: false`, so every merge to `staging` puts **all** remaining open RUX PRs into `BEHIND` — they each need an update before they can merge, even ones that read `CLEAN` a moment earlier. A `BEHIND` RUX PR at triage time therefore tells you only that *someone merged something*, not that this PR is unhealthy. It is handled serially during the merge run (`/releases-merge` Step 4b), which pauses and asks for a rebase each time it hits one.
  - **`{RELEASE_APP_REPO}` / ST → not a blocker either.** These repos allow merge commits, so `/releases-merge` absorbs an out-of-date branch as an ordinary merge. Note it only if something else about the PR is already flagged.

  A `BEHIND` RUX PR still counts toward the clean total, appears in the Dependencies list, and gets review tabs like any other. **The one thing worth saying** — and only when the release contains **more than one** RUX PR — is a single Notes/closing line telling the user to expect roughly one rebase request per additional RUX PR during Phase 3. With N RUX PRs, expect about N−1 pauses. That is a heads-up about pacing, not an exception.

  > **Why this rule changed (2026-09-14).** It previously read "`RUX` → hard blocker", which excluded any `BEHIND` RUX PR from the release. That was wrong: it treated the normal consequence of merging a sibling PR as a defect in the PR that happened to be queued behind it, and in a multi-PR RUX release it would have excluded every PR but the first. The serialization is inherent to the repo's squash-only setting, not a developer mistake.
- `mergeable == MERGEABLE` with `mergeStateStatus` `CLEAN`, `UNSTABLE`, or `HAS_HOOKS` → passes.

> **`mergeable` can return `UNKNOWN`.** GitHub computes mergeability lazily — the first query after a push often returns `UNKNOWN` with `mergeStateStatus: UNKNOWN`. This is **not** a result. Wait a few seconds and re-query any PR that returns `UNKNOWN`, and only report a conflict once GitHub actually reports `CONFLICTING`. Never report `UNKNOWN` as either passing or failing.

### Gate 5 — Base branch targeting (`baseRefName`)

**A wrong base invalidates every other gate on this PR.** GitHub computes `mergeable`, `mergeStateStatus` and `reviewDecision` against whatever base the PR currently declares. If that base is wrong, a `CLEAN`/`MERGEABLE` result only proves the branch merges into a branch it was never going to merge into — it says nothing about the branch it will actually be merged into. So this gate runs **before** you trust Gates 1–4, and a base correction requires **re-running Gates 1–4** afterward.

Determine the expected base per repo class:

| Repo class | Expected `baseRefName` |
|---|---|
| `{RELEASE_APP_REPO}` (MT) | `staging` |
| `RUX` | `staging` |
| `SUTS-API` | `staging` — **not** its `master` default branch (see Step 3.4) |
| ST (any other repo) | that repo's **default branch** — look it up, never assume: `gh repo view {GITHUB_ORG}/{repo} --json defaultBranchRef --jq '.defaultBranchRef.name'` |

> ST default branches are **not** uniform — observed values include `master`, `production-master` and `main` across `admin` and several ST tenant repos. Query each repo; do not carry an answer over from another ST repo or from a previous release.

**If `baseRefName` matches the expected base** → passes, no mention needed.

#### Only two mismatch shapes are safe to correct on your own

A base mismatch is **not** automatically an error. Before touching anything, classify the mismatch:

**Shape A — safe to retarget without asking.** The base is the *other* long-lived integration branch for that repo class, i.e. the two repo classes have been swapped:
- A staging-based repo (`{RELEASE_APP_REPO}`, `RUX`, `SUTS-API`) whose base is `main` / `master` / `production-master` → should be `staging`.
- An **ST** repo whose base is `staging` → should be that repo's default branch.

These are the only mismatches where the intent is unambiguous, because neither branch is anyone's feature work. Correct them per the steps below.

**Shape B — STOP and ask the developer. Do not retarget.** The base is **any other branch** — a feature branch, a ticket branch, another PR's head. This is a **deliberate stack**: the author based their work on someone else's unmerged change because it depends on it. You cannot tell from the outside whether the dependency is real, so retargeting it to `staging` is a guess that either (a) silently drops a needed parent, or (b) manufactures a conflict that does not exist in the author's intended merge order.

For Shape B, do **not** run `gh pr edit`. Instead:

1. Identify whether the parent branch has **its own PR**, and what state it is in:
   ```bash
   gh api "repos/{GITHUB_ORG}/{repo}/pulls?head={GITHUB_ORG}:{base_branch}&state=all" \
     --jq '.[]|{number,state,merged_at,base:.base.ref,title,author:.user.login}'
   ```
2. Report the stack as an exception with flag `⚠ STACKED PR — base is a feature branch, confirm target with developer`, and give the user everything needed to ask:
   - the parent branch name and its PR number/state (open / merged / closed-unmerged), or that it has no PR;
   - whether the parent is in **today's release** (is its ticket linked to the release story?);
   - the PR author's GitHub login, so the user knows who to ask;
   - **read-only** divergence of the child against the expected base, for context only — this does **not** decide anything:
     ```bash
     gh api repos/{GITHUB_ORG}/{repo}/compare/{expected_base}...{headRefName} --jq '{ahead_by,behind_by,status}'
     ```
3. **Exclude the PR from the Dependencies list** pending the developer's answer, and say plainly that the exclusion is awaiting confirmation rather than a defect.
4. If the parent PR is **already merged**, say so — the stack is simply stale bookkeeping and `staging` is almost certainly the right base, but it is still the developer's call to confirm, so report it rather than fixing it.

> **Why this rule exists (2026-09-21, BLTE-24373).** Triage found two stacked MT PRs — `MRNexus#7354` based on `BLTE-3922-accept-negative-renewal-due-date`, and `MRNexus#7437` based on `fix-BLTE24029-homeruleremitview-excel-export` — and retargeted both to `staging` on the assumption that any non-`staging` base was wrong. Both were deliberate stacks. `#7437`'s parent (`#7334`) had merged on Sep 15, so that retarget was harmless but should still have been the author's call. `#7354`'s parent (`#7312`, BLTE-3922) was **still open and itself conflicting**, 430 commits behind `staging` — so the "revealed conflict" was really the whole two-deep stack being stale, not a defect in `#7354`. Both retargets had to be reverted, and each needed a developer conversation the skill had skipped. Assume a swapped integration branch is an error; assume a feature-branch base is intentional.

**For a Shape A mismatch**, correct it during triage and re-gate:

1. Retarget the PR to the expected base:
   ```bash
   gh pr edit {number} --repo {GITHUB_ORG}/{repo} --base {expected_base}
   ```
2. **Re-query Gates 1–4** on the retargeted PR. Mergeability is recomputed lazily, so allow a few seconds and treat `UNKNOWN` per the note above.
3. Report what the retarget revealed:
   - **Still `CLEAN`/`MERGEABLE`** → flag `⚠ WRONG BASE — retargeted {old} → {new}, re-gated clean`. The PR stays in the releasable set; the line is there so the user knows the base was changed on their behalf.
   - **Now `CONFLICTING`/`DIRTY`** → the wrong base was **hiding a conflict**. Flag `⚠ MERGE CONFLICTS — needs rebase (revealed by base correction: {old} → {new})` and exclude the PR. Report `behind_by` and the conflicting files so the user can brief the author:
     ```bash
     gh api repos/{GITHUB_ORG}/{repo}/compare/{expected_base}...{headRefName} --jq '{ahead_by,behind_by,status}'
     gh api repos/{GITHUB_ORG}/{repo}/pulls/{number}/files --jq '[.[].filename]'
     ```
     Name the PR author so the user knows who to chase. Do **not** attempt the rebase yourself — a diverged branch on a core file needs the author's judgment about how to resolve.
   - **Now `BEHIND`** → apply the `BEHIND` rule in Gate 4 — not a blocker in any repo; the PR stays in the releasable set.
4. Leave the corrected base in place even when the PR ends up excluded. Reverting to the wrong base would re-hide the problem and make the next run's gates untrustworthy again. *(This applies to Shape A only. A Shape B base is never changed in the first place, so there is nothing to leave or revert.)*

**Never leave a Shape A wrong base for `/releases-merge` to auto-correct.** That skill does correct it, but by then the release list is closed and a revealed conflict becomes a mid-merge stop rather than a grooming-time decision. Catching it here is the entire point of the gate.

> **If the user asks you to revert a base you changed**, do it, and then say plainly what the revert re-hides: a Shape A PR that was `CONFLICTING` against the correct base will read `CLEAN` again against the wrong one, and `/releases-merge` will retarget it mid-run and halt there. Recommend excluding that PR from the Dependencies list for the current release even though its base now looks fine. Also check before reverting whether the original base still exists as an open branch — pointing a PR back at a merged-and-deleted branch leaves it in a broken state, and the user should hear that before you run the edit, not after.

> Real failure this gate exists to prevent (2026-09-08, BLTE-21222 / `{tenant-a}#811`): the PR targeted `staging` while the repo default was `production-master`. Triage reported it `CLEAN` — true against `staging` — and noted the base only as a cosmetic "auto-corrected later" aside. At merge time the retarget exposed a conflict in `app/framework.php` with the branch **146 commits behind** `production-master`, halting Phase 3 and forcing the ticket out of the release after the list had been closed and the story written.

> Note that a PR can be `APPROVED` with failing CI, have green CI with merge conflicts, or be perfectly clean but sitting in draft — the gates are independent. Check all five every time, and re-check 1–4 after any base correction.

### Result

A PR that passes all five gates needs no mention at all; it counts toward the clean total and appears in the Dependencies list. (A PR whose base had to be corrected but then re-gated clean is the one exception: it stays in the releasable set but still gets a `⚠ WRONG BASE` line, so the user knows a change was made on their behalf.)

**Important:** PRs failing **any** gate should be omitted from the Jira story's PR list in Step 6, and should NOT be merged in Phase 3, unless the user explicitly overrides. Note them prominently in the Step 5 report so the user can notify the developer.

## Step 3.6 — Check ST repo PRs for migrations

For every discovered PR in a **non-`{RELEASE_APP_REPO}` (ST) repo**, check whether the PR contains migration files. Run all checks in parallel.

```bash
gh api repos/{GITHUB_ORG}/REPO/pulls/N/files --jq '[.[] | select(.filename | test("migrations/"; "i")) | .filename]'
```

Replace `REPO` and `N` with the repo name and PR number.

- If the output is a non-empty array → the PR has migrations that must be run manually on the ST tenant. Mark it with `(has migrations — run manually)` in the Step 5 report.
- If the output is `[]` → no annotation needed.

### Step 3.6b — Check MT PRs for merge-blocking migrations

MT migrations run automatically at merge, so they need no manual step — but two patterns cause `/releases-merge` Step 1 to **skip the PR entirely**. Those must be caught here, during grooming, not discovered at the merge step after the release list is closed.

For every discovered PR in `{RELEASE_APP_REPO}`, list its migration files and scan their **added lines**:

```bash
gh pr diff N --repo {GITHUB_ORG}/{RELEASE_APP_REPO} --name-only | grep -i 'migrat'
```

For each migration file found, read the added lines and flag the PR if either applies:
- A reference to the **`businesstaskdata`** table in a CREATE/INSERT/UPDATE/SELECT/ALTER statement (a doc comment mentioning the name does **not** count — check for actual SQL).
- An index add (`ADD INDEX`, `ADD KEY`, `CREATE INDEX`) **on `businesstask`, `businesstaskdata`, or `transactions`**. An index add on any other table is fine and needs no flag.

> Keep this table list identical to `/releases-merge` Step 1 — the whole point of this check is to predict what the merge step will skip. Current list (dev, 2026-09-01): **`businesstask`, `businesstaskdata`, `transactions`**.

If a PR trips either pattern, flag it in the Step 5 report as `⚠ MT MIGRATION — will be skipped by /releases-merge ({pattern}, {table})` with confidence unchanged, and say plainly that the ticket either needs a merge-time override or should roll to the next release. This is a **decision the user makes during triage**, while there is still time to chase the developer.

Also worth a Notes line, though not a flag: a **default-scope** (`app/migrations/default/...`) `ALTER TABLE ... ADD COLUMN` against a large shared table (`businesstask`, `business`, `transactions`). It runs on every MT tenant and can lock comparably to an index build. Mention it as a deploy-window consideration.

### Step 3.6c — Check app-repo staging health

`/releases-merge` Step 2 halts a repo's merges when its `staging` is ahead of `main`. Check it here too, so a dirty staging branch is a grooming-time decision rather than a mid-merge surprise.

For each app repo that has PRs in today's release (`{RELEASE_APP_REPO}` and/or `RUX`):

```bash
gh api repos/{GITHUB_ORG}/{APP_REPO}/compare/main...staging --jq '{ahead_by, behind_by}'
```

- `ahead_by == 0` → clean, no mention needed.
- `ahead_by > 0` → list the offending commits (`.commits[] | {sha, author, msg}`) and flag in the Step 5 report as `⚠ {APP_REPO} STAGING AHEAD OF MAIN BY {N}` with the commit list. Note whether they belong to today's tickets. A commit paired with its own revert nets to nothing but **still rides into `main`** on the fast-forward and appears in the release notes — say so, and let the user decide whether to proceed.

Report per repo; a dirty staging on one app repo never implies anything about the other.

> Note: the migration/SUTS annotations are shown in the **Step 5 report only**. The Step 6 Dependencies bullets are just the PR link (see Step 6).

## Step 3.7 — Detect SUTS-targeted requests

Flag each linked ticket as **SUTS-targeted** if any of the following (case-insensitive) contain the substring `suts`:
- The Jira ticket key/URL
- Any tenant URL found in the ticket's comments (e.g. `https://*.munirevs.com`, `https://*.blt.govos.com`, `https://suts.blt.govos.com`)
- The Jira ticket summary returned by the Step 3.1 call

This detection is **informational only** — it never causes a ticket to be excluded. It is used to append a `_(SUTS)_` tag to the PR line in the Step 5 report. No additional API call is required.

## Step 3.8 — Apply the release blackout priority gate

Using `{IN_BLACKOUT}` (from the Pre-flight blackout computation) and each ticket's `fields.priority.name` (from the Step 2 issuelinks payload / Step 3.1 response — no extra call):

- **If `{IN_BLACKOUT}` is false** → gate is a no-op. Every ticket is eligible. Still record each ticket's priority name for the report.
- **If `{IN_BLACKOUT}` is true** → for each linked ticket, classify its priority via the eligibility mapping in the Pre-flight section:
  - **Eligible (P0/P1)** — priority name contains `(p0)` / `(p1)`, or starts with `P1` → ticket stays in today's release.
  - **Held (not P0/P1)** — any other priority → mark the ticket **HELD — release blackout (not P0/P1)**. It is **excluded from today's release**: omit it from the Dependencies PR list in Step 6, and do **not** merge it in Phase 3. Surface it prominently in the Step 5 report.

This gate is independent of confidence and review-comment status — a HIGH-confidence, clean-review P2 ticket is still HELD during the blackout. The user may explicitly override it (e.g. a P2 that leadership has cleared); apply an override only on explicit user direction in the conversation, and note it in the report.

A HELD ticket is an **exception** — it gets a full block in the Step 5 report with the flag `⛔ {priority name} — HELD (release blackout, not P0/P1)`, plus a line in the closing Blackout summary.

An eligible ticket needs no priority line — outside the blackout window every ticket is eligible, so stating it adds nothing. Record each ticket's priority internally regardless, so a HELD ticket can name its own priority and the blackout summary line can list them.

## Step 4 — Assign confidence level

| Level | Criteria |
|---|---|
| **HIGH** | A single, unambiguous PR found in a developer comment; cross-checks (branch/PR) consistent |
| **MEDIUM** | PR found, but the branch/PR cross-check is imperfect, or the PR had to be taken from prose rather than a clearly-labeled "PR:" line |
| **LOW** | Conflicting PRs across comments (Step 3.3), or `MULTI-PR` (multiple PRs for one ticket that need manual confirmation) |
| **NEEDS MANUAL REVIEW** | No PR discoverable in any comment (Step 3.5) |

## Step 5 — Output the report

**The report is exceptions-only.** Its job is to surface exactly the requests that need the user's review or a decision — nothing else. Clean requests are represented by a count, not a block. The user should never have to read through twenty passing requests to find the three that need attention.

### Which requests get a block

A request gets a full block **only if it needs action**. Flag it if **any** of the following is true:

- Confidence is **MEDIUM**, **LOW**, or **NEEDS MANUAL REVIEW** (anything below HIGH)
- `⚠ UNRESOLVED COMMENTS` — Gate 1 (Step 3.5b)
- `⚠ NOT APPROVED` (only when the merge is `BLOCKED`) / `⚠ CHANGES REQUESTED` — Gate 2 (Step 3.5b)
- `⚠ CI FAILED` / `⚠ CI PENDING` — Gate 3 (Step 3.5b)
- `⚠ MERGE CONFLICTS` / `⚠ DRAFT PR` — Gate 4 (Step 3.5b). **`BEHIND` is not on this list** — it is expected in RUX after any sibling merge and never flags.
- `⚠ WRONG BASE` — Gate 5 (Step 3.5b), Shape A: whether the retarget re-gated clean or revealed a conflict
- `⚠ STACKED PR — base is a feature branch, confirm target with developer` — Gate 5 (Step 3.5b), Shape B: excluded pending the developer's answer, not retargeted
- `⚠ MT MIGRATION — will be skipped by /releases-merge` — Step 3.6b (a `businesstaskdata` reference, or an index add on `businesstask`/`businesstaskdata`/`transactions`)
- `⚠ {APP_REPO} STAGING AHEAD OF MAIN` — Step 3.6c (blocks that repo's merges in `/releases-merge` Step 2)
- `⛔ HELD` by the blackout gate (Step 3.8)
- `MULTI-PR` — the ticket has more than one PR (e.g. a `RUX` frontend PR plus its `{RELEASE_APP_REPO}` backend counterpart), **and** they do not all clear the gates: flag it when any one of them is gate-excluded while another is clean, so the user knows only part of the fix would ship. A multi-PR ticket whose PRs are all clean needs no block.
- The ticket's own comments show an **open issue, failing test, unmet reporter feedback, or an irreversible/manual step** that needs a decision before merge (e.g. QA reported a failure after the PR was approved, a reporter said the fix still isn't working, a migration that cannot be rolled back)

Everything else — **HIGH confidence, no unresolved comments, no blackout hold, no open issues** — is a **clean request**. Clean requests get **no block**. They are counted in the summary and included in the Step 6 Dependencies list, and that is all.

> Migration and SUTS annotations alone do **not** make a request an exception. A HIGH-confidence PR that merely has migrations stays clean; its `(has migrations — run manually)` annotation carries forward to `/releases-merge`. Only flag a migration when something about it needs a decision (irreversible, destructive, or requiring a pre-merge backup).

### Format

---

**Pending Release Requests — [today's date]**
**Release story: https://{JIRA_BASE_URL}/browse/{STORY-KEY} — {summary}**
**Release blackout window: [start]–[end]** — Today is [inside / outside] the blackout. [If inside: Only P0/P1 tickets are eligible; all others are HELD.]

**[N] linked tickets, [P] PRs discovered — [C] clean, [F] need review.**

---

#### ⚠ Needs your review

**[TICKET-KEY]** — [ticket summary] — [status]
JIRA: [full URL]
PR: [full GitHub URL(s)] _(SUTS)_ _(has migrations — run manually)_ ← append `_(SUTS)_` only if Step 3.7 flagged the ticket; append `_(has migrations — run manually)_` only if Step 3.6 detected migrations; omit either or both otherwise. Order is `_(SUTS)_` first, then `_(has migrations — run manually)_`. For MULTI-PR, list every PR.
Flag: [the specific reason(s) this needs review — e.g. `⚠ MERGE CONFLICTS — needs rebase`, `⚠ DRAFT PR — not ready to merge`, `⚠ UNRESOLVED COMMENTS — send back to developer (N threads)`, `⚠ NOT APPROVED — merge blocked, no approver`, `⚠ CHANGES REQUESTED — send back to developer`, `⚠ CI FAILED — {check names}`, `⚠ CI PENDING — {check names}`, `⛔ {priority} — HELD (release blackout, not P0/P1)`, `MULTI-PR`, `NEEDS MANUAL REVIEW — no PR found in ticket comments`, `QA reported failure after approval`. List **every** gate the PR fails, not just the first.]
Confidence: [MEDIUM / LOW / NEEDS MANUAL REVIEW / HIGH]
Notes: [what the user needs in order to decide — who left the unresolved threads and whether they're human or bot, stale or current; which specific checks failed and the run URL; what the open issue is; what the irreversible step requires. Be specific enough that the user can act without opening the PR.]

---

*(repeat one block per flagged request; order them most-urgent first)*

---

### Closing lines

After the flagged blocks, include a **Releasable set** line:
`Releasable set: [X] PRs — [N] ST ([list repos]) + [M] MT + [R] RUX + [S] SUTS-API (released by `{SUTS_API_RELEASE_OWNER}`).` (omit a term whose count is zero)

Then add only the lines that apply:

- `Excluded (merge conflicts): [ticket] (#PR), …`
- `Multi-PR RUX release — expect ~{N−1} rebase pauses in Phase 3: {N} RUX PRs queued.` — informational, only when the release has more than one RUX PR. Not an exclusion.
- `Excluded (unresolved review comments): [ticket] (#PR), …`
- `Excluded (not approved / merge blocked): [ticket] (#PR), …`
- `Excluded (CI failed): [ticket] (#PR — {check name}), …`
- `Partial fix — only one half releasable: [ticket] ([repo]#[PR] excluded, [repo]#[PR] clean)` — for a ticket whose `RUX` / `{RELEASE_APP_REPO}` pair is split by the gates.
- `Held for release blackout ([window]) — not P0/P1: [ticket] ({priority}), …` — excluded from Step 6's Dependencies list and from Phase 3 merging unless the user explicitly overrides.
- `No PR found (chase developer): [ticket] — [summary], …`
- `ST-only release — pipeline stops after Phase 3.` (only when every discovered PR is ST — i.e. **no** `{RELEASE_APP_REPO}`, **no** `RUX` **and no** `SUTS-API` PRs. A release containing RUX PRs is not ST-only. A release whose only non-ST PR is a SUTS-API one is also not ST-only: the ST PRs stop after Phase 3, but say explicitly that the SUTS-API PR is still outstanding with `{SUTS_API_RELEASE_OWNER}`.)

If **nothing** was flagged, say so plainly — e.g. `All [N] requests are clean — nothing needs your review.` — and go straight to the closing lines.

> If the user asks to see the full list (e.g. "show me everything", "list them all"), print every request in the compact one-line form: `[TICKET-KEY] — [summary] — [PR URL]`. Only expand to full blocks on request.

### Reconcile the counts before printing

In an exceptions-only report the counts are the **only** representation most requests get — a clean request that silently vanishes leaves no trace for the user to catch. So derive every number from the actual ticket list rather than counting by hand, and verify these identities before printing:

- `[N] linked tickets` **==** the number of qualifying entries collected in Step 2 (count the `outwardIssue` entries in `issuelinks`, don't re-tally from your own report blocks). Count **every** qualifying link, including Epics and any other issue type — the link type is the only filter (Step 2).
- `[C] clean + [F] need review` **==** `[N]`
- `[X] releasable PRs` **==** total PRs discovered − gate-excluded (unresolved comments / not approved / CI failed / merge conflicts) − blackout-HELD − no-PR tickets. A `BEHIND` RUX PR is **not** gate-excluded and still counts toward `[X]`.
- `[N] ST + [M] MT + [R] RUX + [S] SUTS-API` **==** `[X]`
- Tickets and PRs are **not** 1:1 — a ticket can contribute two PRs (RUX + `{RELEASE_APP_REPO}`), so never assume the PR count equals the linked-ticket count. Derive each independently.
- The Step 6 Dependencies list contains exactly `[X]` bullets

If any identity fails to balance, **re-derive from the Step 2 ticket list before printing** — do not adjust a number to make the arithmetic work. State each ticket count from the source data, never from a mental tally of the blocks you just wrote.

## Important rules

- **The report is exceptions-only.** Only requests needing review or a decision get a block; clean requests are a count. See Step 5 for the flag criteria. This governs the report alone — triage still runs every gate against every request, and the Step 6 Dependencies list still contains every releasable PR.
- The linked tickets on the story are the source of truth for what to release; a ticket's **newest PR-bearing comment** is the source of truth for its PR.
- **Every qualifying linked ticket is triaged — no filtering by issue type or status.** Epics, Stories, Tasks and Bugs are all release requests when linked to the story; only the link type (Step 2) decides what qualifies. Never skip an Epic as a container or a "not a real request".
- If the Jira API returns an error for a ticket key, note it rather than skipping the ticket.
- Normalize Jira keys to uppercase.
- Never guess a PR URL — only report one that was found in a comment.
- **Five PR gates** (Step 3.5b): base targeting, unresolved review comments, approval state, CI/unit tests, and mergeability. Check all five on every PR and report every gate a PR fails. A green CI run does not imply approval, an approval does not imply green CI, and neither one tells you the branch still merges cleanly.
- **Base targeting is checked first, and a correction invalidates the other gates.** GitHub computes mergeability, merge state and review decision against the PR's declared base. A PR pointing at the wrong base can report `CLEAN`/`MERGEABLE` while being unmergeable into the branch it will actually merge into — so retarget it in triage (Gate 5), then re-run Gates 1–4 against the corrected base. Never pass a Shape A wrong base downstream for `/releases-merge` to fix: by then the release list is closed, and a revealed conflict halts Phase 3 instead of being a grooming decision.
- **Only two base mismatches are yours to fix (Gate 5, Shape A):** a staging-based repo (`{RELEASE_APP_REPO}`, `RUX`, `SUTS-API`) pointing at `main`/`master`/`production-master`, or an ST repo pointing at `staging`. **Any other base — a feature or ticket branch — is a deliberate stack: report it, exclude it pending the developer's answer, and do not retarget it** (Shape B). Retargeting someone's stack guesses at a dependency you cannot see and produces phantom conflicts.
- **`SUTS-API` is staging-based, not ST**, despite its `master` default branch — expect `staging` and never retarget it to `master`. Its PRs are **released by `{SUTS_API_RELEASE_OWNER}` only**: gate and list them, but do not merge them in Phase 3.
- **A merge conflict is a hard blocker.** `mergeable == CONFLICTING` means the PR cannot be released until the developer rebases, regardless of approvals, green CI, and resolved comments. Nothing else in triage surfaces this, so never skip Gate 4. Treat `mergeable == UNKNOWN` as "not yet computed" — re-query rather than reporting it either way.
- **A missing approver is only a blocker when the merge is `BLOCKED`.** Some repos have no branch-protection rule requiring review, so `reviewDecision: null` there is normal and must not be flagged.
- **No CI ≠ failed CI.** ST repos have no GitHub Actions workflows, so `statusCheckRollup` comes back `null` for them. That is the expected state — never flag it, and never report it as a missing or skipped test run. Only an actual `FAILURE`/`ERROR` conclusion counts against a PR; `SKIPPED` and `NEUTRAL` checks don't either.
- **GitHub is authoritative for approval; the PR page is authoritative for outdated bot threads.** A Jira comment claiming code review passed does not clear Gate 2 — only a GitHub `APPROVED` state does. Conversely, outdated bot review threads can read as unresolved in the API while showing resolved on the PR page; flag them but say so, and defer to the user's read of the page.
- **RUX is in scope** (as of 2026-08-25): `{GITHUB_ORG}/RUX` PRs are gated, reported, listed in Dependencies, and given review tabs exactly like `{RELEASE_APP_REPO}` PRs. There is no repo-based exclusion any more — the only exclusions are the five gates (Step 3.5b), the blackout hold (Step 3.8), and no-PR-found (Step 3.5).
- **Watch the RUX ↔ `{RELEASE_APP_REPO}` pair**: on RUX sites, RUX serves the business center and `{RELEASE_APP_REPO}` serves `/backend/admin/`, so one ticket often has a PR in each. Releasing only one half ships a partial fix — flag any ticket whose paired PRs are split by the gates.
- **RUX PRs go `BEHIND` in lockstep — never treat that as a defect.** Because RUX disallows merge commits, merging any one PR to `staging` puts every other open RUX PR into `BEHIND` at once. A `BEHIND` reading at triage time is a statement about the repo, not about the PR. Do not flag it, do not exclude it, and do not tell the user to chase the author. `/releases-merge` Step 4b resolves them one at a time during the merge run. The only thing to surface is a pacing heads-up when the release carries more than one RUX PR.
- **SUTS handling**: SUTS-tagged tickets (detected in Step 3.7) are **not excluded** — they are included and labeled with `_(SUTS)_` on the PR line.
- **Release blackout**: During the blackout window (computed in Pre-flight), only **P0/P1** tickets are eligible — all others are HELD (Step 3.8), excluded from the Step 6 Dependencies list and from Phase 3 merging unless the user explicitly overrides. Outside the window the gate is a no-op. Always show the computed window in the report header; show a ticket's priority only when it is HELD (or otherwise flagged).

---

## Step 5.5 — Confirmation checkpoint

After outputting the Step 5 report, **stop and wait for the user to confirm** before proceeding to Step 6. Do not modify the story until the user explicitly says to continue (e.g. "looks good", "go ahead", "continue"). If they request corrections, apply them and re-present the report before asking again.

---

## Step 5.7 — BLT-Eng General channel notification check

Before writing to the Jira story, check whether today's start notification has been posted in the BLT-Eng General channel. Load the Teams read tool on demand:

```
ToolSearch("select:mcp__claude_ai_Microsoft_365__read_resource")
```

Then read:

```
teams:///teams/45bde3a3-65a4-4699-8fe8-40fa4317752e/channels/19%3ApFAL1LTrHdyxIuqwtayrJvk1lTLkfDT-_Z9pPbTn5HY1%40thread.tacv2/messages
```

Scan the most recent messages for a post from the user created **today** (current date) that contains:
> I'm gonna start merging to `staging` for today's MT release

- **If found today**: report `✓ Team notified` and proceed to Step 6 immediately.
- **If not found**: display the following to the user and **stop until they confirm** the post has been made:

> Please post the following in the **BLT-Eng General** channel before I continue:
>
> `I'm gonna start merging to staging for today's MT release`
>
> (Confirm with "posted" or "done" when ready.)

Do not proceed to Step 6 until the user confirms.

---

## Step 6 — Verify today's Daily Releases story + write the PR list

After the user confirms the report and the Release Team has been notified, verify the release story (`{STORY-KEY}`, already resolved in Step 1) and write the discovered PR list into its Dependencies section.

The story already exists — this step **verifies and populates**, it does not create. (Only create a story if `{STORY-KEY}` somehow no longer resolves; that should not happen in the new flow.)

### Resolve current user's account ID

Before editing any Jira issue, load `atlassianUserInfo` and `editJiraIssue` via ToolSearch and call `atlassianUserInfo` to resolve the current user's Atlassian `accountId`. Store the result as `{ACCOUNT_ID}` for all subsequent `editJiraIssue` calls in this phase.

```
ToolSearch("select:mcp__claude_ai_Atlassian__atlassianUserInfo")
ToolSearch("select:mcp__claude_ai_Atlassian__editJiraIssue")
```

### Ensure fields are populated

Using the story data already fetched in Step 2, use `editJiraIssue` on `{STORY-KEY}` to set any fields that are **missing or null** (do not overwrite fields that are already populated):

| Field | Value |
|---|---|
| `assignee` | `{"accountId": "{ACCOUNT_ID}"}` (the user) |
| `customfield_11462` (Primary Driver/Goal) | `{"id": "10924"}` ("Internal Op") |
| `customfield_11477` (Developer) | `[{"accountId": "{ACCOUNT_ID}"}]` |
| `customfield_11478` (QA Engineer) | `[{"accountId": "{ACCOUNT_ID}"}]` |
| `customfield_10028` (Story Points) | `2` |
| `timetracking` | `{"originalEstimate": "2h"}` |
| `description` | Use the template below (markdown format, `contentFormat: "markdown"`) — always (re)write the description so the Dependencies list reflects the discovered PRs. |

### Description template

Substitute the following placeholders before submitting:

| Placeholder | How to fill it |
|---|---|
| `[FULL DATE]` | Formatted release date — e.g. `July 28, 2026` |
| `[PR LIST]` | The discovered PR list (see structure below) |
| `[CUTOFF]` | `3:00 pm Mountain Time on [day before release date]` — the **business day** immediately before the release date, written as weekday + full date, e.g. `3:00 pm Mountain Time on Friday August 21, 2026` for a Monday August 24 release. Skip weekends: the day before a Monday release is the preceding Friday, not Sunday. Preserve whatever cutoff the existing story description already states; only compute a new one if none is present. |

```
This story coordinates the [FULL DATE] production release across Munirevs' multi-tenant (MRNexus) and single-tenant (ST repo) platforms.

Release process reference: [BLT Release Process (Weekly + Daily)](https://neumo.atlassian.net/wiki/spaces/BBLAT/pages/4026630147/BLT+Release+Process+Weekly+Daily)

### Dependencies

Release PRs:

[PR LIST]

### Scope

**In scope:** Deployment of the PRs listed in Dependencies to production on [FULL DATE].

**Out of scope:** any tickets linked after [CUTOFF].

### Acceptance Criteria

1. **Merge.** Given the PRs in Dependencies are ready, when each is merged to `staging`, then no merge conflicts occur and the resulting `staging` build deploys without error.
2. **Regression validation.** Given staging regression tests are run, then the run completes with either: (a) all tests passing, (b) all failures matching the pre-documented expected-failure list (production Jira step, SUTS migration step), or (c) any other failure documented by the QA Engineer (Allen Manning) as a comment on this story containing failure name, root cause hypothesis, and the literal text `Approved to proceed — Allen Manning` before production deployment begins.
3. **Smoke check.** Given production deployment completes, when smoke checks are run, then each Smoke-Check URL listed in Dependencies returns HTTP 200, the primary navigation renders within 10 seconds, and no new 5xx responses appear in the browser network tab. Pre-existing JS console errors are out of scope.
4. **Notify requesters.** After production deploy is confirmed, a ✅DONE reaction is added to each original release request post in the Microsoft Teams `Release-Requests-Production` channel (team `BLT-Eng`).
5. **Time logging.** All time spent on this release is logged to this story or its subtasks with activity descriptions before EOD.

### Definition of Done

1. All Dependencies PRs merged to `staging` with no conflicts (per AC #1).
2. Regression tests pass or all failures signed off per AC #2.
3. All Smoke-Check URLs verified healthy after production deploy (per AC #3).
4. ✅DONE reactions posted to every release request in the Teams `Release-Requests-Production` channel (per AC #4).
5. Time logged on this story or its subtasks with activity descriptions before EOD (per AC #5).
```

### `[PR LIST]` structure

One bullet per PR = **just the PR link** — no Smoke-Check URL, SUTS, or migration annotations in the bullet (those live in the Step 5 report only). Use `[full-url](full-url)` markdown link syntax with the same URL in both positions so Jira renders it clickable:

```
* [https://github.com/{GITHUB_ORG}/{st-repo}/pull/{N}](https://github.com/{GITHUB_ORG}/{st-repo}/pull/{N})
* [https://github.com/{GITHUB_ORG}/{RELEASE_APP_REPO}/pull/{N}](https://github.com/{GITHUB_ORG}/{RELEASE_APP_REPO}/pull/{N})
* [https://github.com/{GITHUB_ORG}/RUX/pull/{N}](https://github.com/{GITHUB_ORG}/RUX/pull/{N})
```

**PR ordering rule — ST, then MT, then RUX, then SUTS-API:**

1. **ST PRs first** — every repo that is not `{RELEASE_APP_REPO}`, `RUX` or `SUTS-API`. Group by repo, sort repos **alphabetically** by repo name; where one repo has multiple PRs, sort those by **PR number ascending**.
2. **`{RELEASE_APP_REPO}` (MT) PRs next** — sorted by **PR number ascending**.
3. **`RUX` PRs next** — sorted by **PR number ascending**.
4. **`SUTS-API` PRs last** — sorted by **PR number ascending**. They sit at the end because they are **not merged in Phase 3** (`{SUTS_API_RELEASE_OWNER}` releases them); keeping them in their own trailing block stops `/releases-merge` from reading one as an ST or app-repo PR.

Order by repo class, **not** by ticket. A ticket with PRs in two repos contributes one bullet to each section; its PRs are deliberately not adjacent in the list.

This ordering ensures `/releases-merge` processes the repos in the intended sequence when reading the list top-to-bottom.

**Exclusions:** Omit from the Dependencies list any PR whose ticket is flagged `⚠ UNRESOLVED COMMENTS` (Step 3.5b), HELD by the blackout gate (Step 3.8), or `NEEDS MANUAL REVIEW` (no PR — Step 3.5). These are excluded from Phase 3 merging too, unless the user explicitly overrides.

### Issue links — no re-linking needed

The linked tickets are already linked to the story (that's how Step 2 found them), so **do not** re-create `createIssueLink` links for tickets already present in the story's `issuelinks`. If PR discovery surfaced a ticket that clearly belongs on this release but is **not** linked, note it for the user rather than auto-linking.

## Step 6.5 — Open review tabs in Chrome

After the Jira description has been written (Step 6), launch Chrome tabs so the user can eyeball every linked ticket alongside its PR. This runs on the local Windows machine (Chrome is at `C:\Program Files\Google\Chrome\Application\chrome.exe`, registered in App Paths so `chrome` resolves).

### Build the tab URL list

Order the tabs to match the story's **Dependencies PR list** (Step 6) — the ST-first, then-MRNexus order that `/releases-merge` reads top-to-bottom — not the story's link order. Every tab is an **interleaved pair**: the ticket's Jira URL first, then its PR URL immediately after.

Build the list in two passes:

1. **Dependencies pass (in PR-list order).** Walk the Dependencies PR list top-to-bottom. For each PR, emit its owning ticket's Jira URL, then that PR URL.
   - **Every PR in the Dependencies list gets its own tab — no exceptions.** The Dependencies list and the PR tabs are 1:1: if the list has `[X]` bullets, the launch command contains exactly `[X]` PR URLs. Walk the *PR list*, not the ticket list — a ticket is never "already covered" because one of its PRs was emitted earlier.
   - `MULTI-PR` ticket → its PRs sit at **different positions in different repo sections** (ST, then MT, then RUX), and each one still gets a tab at its own position. Emit the ticket's **Jira** tab once only, immediately before the **first** of its PRs; every subsequent PR of that ticket is emitted bare, at its own position, with no repeated Jira tab. Emitting the Jira tab once must never collapse the ticket's other PRs — the de-duplication applies to the Jira URL alone.
2. **Trailing pass (excluded / no-PR tickets).** After the Dependencies pass, append every linked ticket **not** already emitted above — i.e. tickets excluded from the Dependencies list: HELD (blackout, Step 3.8), `⚠ UNRESOLVED COMMENTS` (Step 3.5b), and `NEEDS MANUAL REVIEW` (no PR — Step 3.5). Walk these in Step 5 report (link) order. For each, emit its Jira URL, then its PR URL **if one was discovered** (HELD and unresolved-comment tickets have a PR even though it's excluded from the release — pair it so the user can review it); `NEEDS MANUAL REVIEW` tickets get the Jira tab only.

**URLs:**
- **Ticket URL:** `https://{JIRA_BASE_URL}/browse/{TICKET-KEY}` (always emitted — one per linked ticket, exactly once).
- **PR URL(s):** the PR(s) discovered for that ticket in Step 3.
- **`RUX` PRs get tabs like any other** — they are part of the release now. A ticket with both a `RUX` and a `{RELEASE_APP_REPO}` PR emits its Jira tab once, then both PR tabs at their respective positions in Dependencies order.
- **Any repo combination can pair, not just RUX + `{RELEASE_APP_REPO}`.** An ST repo pairs with `{RELEASE_APP_REPO}` just as often — e.g. an ST admin-tooling PR that queues a job plus the `{RELEASE_APP_REPO}` PR that executes it. Both halves need tabs. Never treat "one PR already opened for this ticket" as reason to skip the other; the repo names are irrelevant to the rule.

**Open every linked ticket, including excluded ones** so the user can manually review them. This is intentionally broader than the Step 6 Dependencies list; the releasable set simply comes first (Dependencies order), with excluded tickets trailing. Do **not** filter the tab list by release-eligibility.

> Ordering example — Dependencies list is `[st-repo#10, MRNexus#20, MRNexus#21]` (owned by T2, T1, T4), plus T3 is NEEDS MANUAL REVIEW (no PR) and T5 is HELD (has PR #99):
> `T2-jira, st-repo#10, T1-jira, MRNexus#20, T4-jira, MRNexus#21,` **then trailing:** `T3-jira (no PR), T5-jira, #99`
>
> **Multi-PR example — the case that is easiest to get wrong.** Dependencies list is `[st-repo#10, {RELEASE_APP_REPO}#20, {RELEASE_APP_REPO}#21, RUX#30]`, where **T1 owns both `st-repo#10` and `{RELEASE_APP_REPO}#20`**, T2 owns `{RELEASE_APP_REPO}#21`, and T3 owns `RUX#30`:
>
> `T1-jira, st-repo#10, {RELEASE_APP_REPO}#20, T2-jira, {RELEASE_APP_REPO}#21, T3-jira, RUX#30`
>
> That is **7 tabs for 4 PRs and 3 tickets**. T1's Jira tab appears once, but **both** of its PRs get tabs — `{RELEASE_APP_REPO}#20` is emitted bare, with no second T1 Jira tab before it. Emitting `st-repo#10` and stopping there would silently drop half of T1's release.
>
> **Why this rule exists (2026-09-15, BLTE-24146).** That ticket shipped an ST admin-tooling PR that queues a per-license renewal job plus the `{RELEASE_APP_REPO}` PR that honors the job's new flag. Only the ST PR got a tab. Both were in Dependencies and both merged, so the release was correct — but the pair never got eyeballed together during grooming, and the developer's own testing note warned that deploying one half without the other makes the job **silently renew every license in the tenant** while the run log still reads as a pass.

### Verify the count before launching

The PR-tab count is the check that catches a dropped pair. Before running the launch command, confirm:

- **PR tabs == the number of bullets in the Step 6 Dependencies list**, exactly. Count the `pull/` URLs in the command you are about to run and compare against the Dependencies bullet count — they must match.
- **Jira tabs == the number of linked tickets** (Step 2 count), each appearing exactly once.
- Total tabs == (every PR exactly once) + (every linked ticket exactly once), plus any excluded ticket's PR emitted in the trailing pass.

If the PR-tab count is lower than the Dependencies bullet count, a multi-PR ticket has been collapsed — re-derive the list from the **PR list** rather than from the ticket list before launching. Report the counts in the confirmation line, e.g. `Opened 7 tabs in Chrome (3 tickets + 4 PRs)`, so a mismatch is visible after the fact.

### Launch

Reuse the user's current Chrome window (append tabs — do **not** pass `--new-window`). Pass all URLs as arguments in the built order; Chrome opens them as tabs left-to-right in that order. Run via the Bash tool:

```bash
powershell.exe -NoProfile -Command "Start-Process chrome -ArgumentList @('URL1','URL2','URL3', ...)"
```

Substitute the ordered URL list for `'URL1','URL2',…` (single-quoted, comma-separated). Keep them in one `Start-Process` call so tab order is deterministic.

- If Chrome isn't found / `Start-Process` errors, report the failure and **print the ordered URL list** in the chat so the user can open the tabs manually — do not block the rest of the skill.
- Report a one-line confirmation, e.g. `Opened N tabs in Chrome ([T] tickets + [P] PRs).` **`[P]` must equal the Dependencies bullet count** — if it doesn't, a multi-PR ticket was collapsed; fix the list and re-launch rather than reporting the lower number.

## Step 7 — Verify automation subtasks + description grade

After the description is written, confirm the two automation-created subtasks exist and (optionally) capture the description grade. The subtasks are normally already present on an existing story — the story data from Step 2 already contains `subtasks`.

Check for the two subtasks: **"Coding/Development"** and **"Manual Testing"**. If both are already present (from Step 2), proceed immediately. If either is missing (e.g. a freshly created story), re-fetch the story every ~15 seconds (up to 2 minutes / ~8 polls) using `getJiraIssue` with `fields: ["subtasks","comment"]`.

### Subtasks
- If 2 minutes elapse without both subtasks: report the story link, state that the automation subtasks have not appeared, and **stop execution**. Ask the user to confirm once the subtasks are visible before continuing.

Once both subtasks are found, ensure each is configured (set only fields that are missing/null):

**Coding/Development subtask:**
1. `editJiraIssue` with:
   - `assignee: {"accountId": "{ACCOUNT_ID}"}`
   - `customfield_11477` (Developer): `[{"accountId": "{ACCOUNT_ID}"}]`
   - `customfield_11478` (QA Engineer): `[{"accountId": "{ACCOUNT_ID}"}]`
   - `customfield_10028` (Story Points): `1`
   - `timetracking: {"originalEstimate": "1h"}`
   - `description`: `"One Software engineer's coding/development effort"` (if not already populated)
   - `customfield_14515` (Capex Task): `{"id": "16503"}` ("Coding/Development") (if not already populated)
2. Leave status as-is (Open)

**Manual Testing subtask:**
1. `editJiraIssue` with:
   - `assignee: {"accountId": "{ACCOUNT_ID}"}`
   - `customfield_11477` (Developer): `[{"accountId": "{ACCOUNT_ID}"}]`
   - `customfield_11478` (QA Engineer): `[{"accountId": "{ACCOUNT_ID}"}]`
   - `customfield_10028` (Story Points): `1`
   - `timetracking: {"originalEstimate": "1h"}`
   - `description`: `"One QA engineer's manual testing effort"` (if not already populated)
   - `customfield_14515` (Capex Task): `{"id": "16504"}` ("Manual Testing") (if not already populated)
2. Log 1h of work: call `addWorklogToJiraIssue` with `timeSpent: "1h"`
3. Transition to Closed: load `getTransitionsForJiraIssue` and `transitionJiraIssue` via ToolSearch, use `getTransitionsForJiraIssue` to find the "Closed" transition ID (last observed: `431`), then call `transitionJiraIssue`

### Description grade
- Scan the story's comments for one authored by a user whose display name contains "Automation for Jira".
- Extract the grade (e.g. `Ticket grade: good-A`). Expected: **`good-A`**.
- If the grade is anything other than `good-A`, include it prominently in the final output so the user can review the description.
- If no grading comment appears (the story may have been graded already on an earlier run), note it but do not block on it.

### Final output
Always end with the story link regardless of subtask/grade status:

```
Story: https://{JIRA_BASE_URL}/browse/{STORY-KEY}
PRs written to Dependencies: [N] ([list ST repos], [MT count], [RUX count])
Review tabs: [✓ Opened N tabs in Chrome ([T] tickets + [P] PRs)] OR [⚠ Chrome launch failed — URL list printed above]
Subtasks: [✓ Coding/Development ({JIRA_PROJECT}-XXXXX) + ✓ Manual Testing ({JIRA_PROJECT}-XXXXX)] OR [⚠ Not yet created — check automation]
Description grade: [✓ good-A] OR [⚠ {actual grade} — review description] OR [— not yet graded]
```
