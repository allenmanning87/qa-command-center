## Pre-flight — Read configuration

Before doing anything else, read the `.env` file at the repo root using the `Read` tool and extract these variables for use throughout this skill:

- `JIRA_BASE_URL` → strip `https://` to get `{JIRA_DOMAIN}` (e.g. `your-company.atlassian.net`)
- `GITHUB_ORG`
- `JIRA_PROJECT`
- `JIRA_RELEASES_EPIC`
- `RELEASE_APP_REPO`

---

You are executing **Phase 1** (Jira-story triage) and **Phase 2** (Jira story verification + PR list) of the daily release process.

- **Phase 1** = Steps 1–5: Resolve today's release story, read its linked tickets, discover the PR(s) for each ticket from its Jira comments, run the PR gates, output the triage report, and wait for you to confirm.
- **Phase 2** = Steps 6–7: Verify today's Daily Releases Jira story's fields and subtasks, and write the discovered PR list into the story's Dependencies section.
- **Phase 3** = `/releases-merge` skill (merge PRs, create release tags; gate on staging-PR CI + explicit go-ahead for `/fast-forward`)
- **Phase 5** = `/releases-deploy` skill (production deploy via `deploy-production.yml`, which runs the e2e regression suite as a built-in blocking tollgate)

> **Phase 4 retired:** the standalone `/releases-regression` step no longer exists — its e2e suite now runs as a blocking gate inside the Phase 5 deploy workflow.

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

For each discovered PR, parse `<repo>` from `github.com/{GITHUB_ORG}/<repo>/pull/N`:
- `<repo> == {RELEASE_APP_REPO}` (`MRNexus`) → **MT**.
- Any other repo → **ST**.
- `<repo> == RUX` → **excluded** (RUX releases are handled by another team). Do not include RUX PRs in the report body; note at the bottom: `Excluded (RUX — handled by another team): [ticket]`.

### Step 3.5 — No PR found

If no PR URL is discoverable in **any** comment on a ticket:
- Flag the ticket **NEEDS MANUAL REVIEW** with note `no PR found in ticket comments`.
- **Exclude** it from the Dependencies/merge PR list.
- Surface it prominently in the Step 5 report so the user can chase the developer.
- **Never guess a PR URL** — only report one that was actually found in a comment.

## Step 3.5b — Check each PR for unresolved review comments

For every discovered PR (regardless of confidence level), run the following GraphQL query to detect unresolved review threads. Run all queries in parallel.

```bash
gh api graphql -f query='{
  repository(owner: "{GITHUB_ORG}", name: "REPO") {
    pullRequest(number: N) {
      reviewThreads(first: 50) {
        nodes { isResolved }
      }
    }
  }
}'
```

Replace `REPO` with the repo name (e.g. `{RELEASE_APP_REPO}`, an ST repo) and `N` with the PR number.

- If **any** `isResolved` value is `false` → the PR has unresolved review comments. Mark it as **SEND BACK TO DEVELOPER** in the Step 5 report. Do not release it.
- If all are `true` (or the array is empty) → no action needed.

Add a `Review Comments` field to every request block in the Step 5 report:
- `✓ No unresolved comments` — safe to release
- `⚠ UNRESOLVED COMMENTS — send back to developer` — do not include in today's release

**Important:** PRs flagged as SEND BACK TO DEVELOPER should be omitted from the Jira story's PR list in Step 6, and should NOT be merged in Phase 3. Note them prominently in the Step 5 report so the user can notify the developer.

## Step 3.6 — Check ST repo PRs for migrations

For every discovered PR in a **non-`{RELEASE_APP_REPO}` (ST) repo**, check whether the PR contains migration files. Run all checks in parallel.

```bash
gh api repos/{GITHUB_ORG}/REPO/pulls/N/files --jq '[.[] | select(.filename | test("migrations/"; "i")) | .filename]'
```

Replace `REPO` and `N` with the repo name and PR number.

- If the output is a non-empty array → the PR has migrations that must be run manually on the ST tenant. Mark it with `(has migrations — run manually)` in the Step 5 report.
- If the output is `[]` → no annotation needed.
- Skip `{RELEASE_APP_REPO}` PRs — MT migrations are handled automatically during the merge process.

> Note: the migration/SUTS annotations are shown in the **Step 5 report only**. The Step 6 Dependencies bullets are just the PR link (see Step 6).

## Step 3.7 — Detect SUTS-targeted requests

Flag each linked ticket as **SUTS-targeted** if any of the following (case-insensitive) contain the substring `suts`:
- The Jira ticket key/URL
- Any tenant URL found in the ticket's comments (e.g. `https://*.munirevs.com`, `https://*.blt.govos.com`, `https://suts.blt.govos.com`)
- The Jira ticket summary returned by the Step 3.1 call

This detection is **informational only** — it never causes a ticket to be excluded (RUX repo is the sole exclusion criterion, applied in Step 3.4). It is used to append a `_(SUTS)_` tag to the PR line in the Step 5 report. No additional API call is required.

## Step 3.8 — Apply the release blackout priority gate

Using `{IN_BLACKOUT}` (from the Pre-flight blackout computation) and each ticket's `fields.priority.name` (from the Step 2 issuelinks payload / Step 3.1 response — no extra call):

- **If `{IN_BLACKOUT}` is false** → gate is a no-op. Every ticket is eligible. Still record each ticket's priority name for the report.
- **If `{IN_BLACKOUT}` is true** → for each linked ticket, classify its priority via the eligibility mapping in the Pre-flight section:
  - **Eligible (P0/P1)** — priority name contains `(p0)` / `(p1)`, or starts with `P1` → ticket stays in today's release.
  - **Held (not P0/P1)** — any other priority → mark the ticket **HELD — release blackout (not P0/P1)**. It is **excluded from today's release**: omit it from the Dependencies PR list in Step 6, and do **not** merge it in Phase 3. Surface it prominently in the Step 5 report.

This gate is independent of confidence and review-comment status — a HIGH-confidence, clean-review P2 ticket is still HELD during the blackout. The user may explicitly override it (e.g. a P2 that leadership has cleared); apply an override only on explicit user direction in the conversation, and note it in the report.

Add a `Priority` field to every request block in the Step 5 report:
- `✓ {priority name} — eligible` (P0/P1, or any priority outside the blackout window)
- `⛔ {priority name} — HELD (release blackout, not P0/P1)` (held requests)

## Step 4 — Assign confidence level

| Level | Criteria |
|---|---|
| **HIGH** | A single, unambiguous PR found in a developer comment; cross-checks (branch/PR) consistent |
| **MEDIUM** | PR found, but the branch/PR cross-check is imperfect, or the PR had to be taken from prose rather than a clearly-labeled "PR:" line |
| **LOW** | Conflicting PRs across comments (Step 3.3), or `MULTI-PR` (multiple PRs for one ticket that need manual confirmation) |
| **NEEDS MANUAL REVIEW** | No PR discoverable in any comment (Step 3.5) |

## Step 5 — Output the report

Present results clearly, one block per linked ticket, in the story's link order. Use this format:

---

**Pending Release Requests — [today's date]**
**Release story: https://{JIRA_BASE_URL}/browse/{STORY-KEY} — {summary}**
**Release blackout window: [start]–[end]** — Today is [inside / outside] the blackout. [If inside: Only P0/P1 tickets are eligible; all others are HELD.]

---

**Request 1** *(HIGH confidence — compact format)*
JIRA: [full URL] — [ticket summary] — [status]
PR: [full GitHub URL] _(SUTS)_ _(has migrations — run manually)_ ← append `_(SUTS)_` only if Step 3.7 flagged the ticket; append `_(has migrations — run manually)_` only if Step 3.6 detected migrations; omit either or both otherwise. Order is `_(SUTS)_` first, then `_(has migrations — run manually)_`.
Review Comments: [✓ No unresolved comments] OR [⚠ UNRESOLVED COMMENTS — send back to developer]
Priority: [✓ {priority name} — eligible] OR [⛔ {priority name} — HELD (release blackout, not P0/P1)]
Confidence: HIGH

---

**Request 2** *(MEDIUM / LOW / NEEDS MANUAL REVIEW — full format)*
JIRA: [full URL] — [ticket summary] — [status]
PR: [full GitHub URL(s)] _(SUTS)_ _(has migrations — run manually)_ ← same annotation rules as above. For MULTI-PR, list every PR.
Review Comments: [✓ No unresolved comments] OR [⚠ UNRESOLVED COMMENTS — send back to developer] OR [— no PR to check]
Priority: [✓ {priority name} — eligible] OR [⛔ {priority name} — HELD (release blackout, not P0/P1)]
Confidence: [MEDIUM / LOW / NEEDS MANUAL REVIEW]
Notes: [brief explanation — which comment the PR came from, any discrepancy, why the confidence is below HIGH, or "no PR found in ticket comments"]

---

**Request 3**
...

---

After the list, include a **Summary** line:
`X linked tickets — Y HIGH, Z MEDIUM, W LOW, V NEEDS MANUAL REVIEW`

If there are any NEEDS MANUAL REVIEW items, add a dedicated line listing exactly which tickets have **no discoverable PR** so the user knows which developers to chase:
`No PR found (chase developer): [ticket] — [summary], [ticket] — [summary]`

If the blackout gate (Step 3.8) HELD any tickets, add a **Blackout** line:
`Held for release blackout ([window]) — not P0/P1: [ticket] ({priority}), [ticket] ({priority})`
These are excluded from Step 6's Dependencies list and from Phase 3 merging unless the user explicitly overrides.

If a run has **no MT PR** (every discovered PR is ST), note it: `ST-only release — pipeline stops after Phase 3.`

## Important rules

- The linked tickets on the story are the source of truth for what to release; a ticket's **newest PR-bearing comment** is the source of truth for its PR.
- If the Jira API returns an error for a ticket key, note it rather than skipping the ticket.
- Normalize Jira keys to uppercase.
- Never guess a PR URL — only report one that was found in a comment.
- **RUX exclusion**: If a discovered PR targets the `{GITHUB_ORG}/RUX` repo, omit it from the report body and note at the bottom: `Excluded (RUX — handled by another team): [ticket]`.
- **SUTS handling**: SUTS-tagged tickets (detected in Step 3.7) are **not excluded** — they are included and labeled with `_(SUTS)_` on the PR line.
- **Release blackout**: During the blackout window (computed in Pre-flight), only **P0/P1** tickets are eligible — all others are HELD (Step 3.8), excluded from the Step 6 Dependencies list and from Phase 3 merging unless the user explicitly overrides. Outside the window the gate is a no-op. Always show the computed window and each ticket's priority in the report.

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
| `[CUTOFF]` | The prior business day and time the story used as its link cutoff — e.g. `3:00 pm Mountain Time on Monday July 27, 2026`. Preserve whatever cutoff the existing story description already states; if none is present, use 3:00 pm Mountain Time on the business day before the release date. |

```
This story coordinates the [FULL DATE] production release across Munirevs' multi-tenant (MRNexus) and single-tenant (ST repo) platforms.

### Dependencies

Release PRs:

[PR LIST]

### Scope

**In scope:** Deployment of the PRs listed in Dependencies to production on [FULL DATE].

**Out of scope:** RUX repo releases (handled by a separate team), and any tickets linked after [CUTOFF].

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
```

**PR grouping rule:** List all non-`{RELEASE_APP_REPO}` (ST) PRs first, grouped by repo and sorted alphabetically by repo name. List all `{RELEASE_APP_REPO}` (MT) PRs last. This ordering ensures `/releases-merge` naturally processes ST repos before MT when reading top-to-bottom.

**Exclusions:** Omit from the Dependencies list any PR whose ticket is flagged `⚠ UNRESOLVED COMMENTS` (Step 3.5b), HELD by the blackout gate (Step 3.8), or `NEEDS MANUAL REVIEW` (no PR — Step 3.5). These are excluded from Phase 3 merging too, unless the user explicitly overrides.

### Issue links — no re-linking needed

The linked tickets are already linked to the story (that's how Step 2 found them), so **do not** re-create `createIssueLink` links for tickets already present in the story's `issuelinks`. If PR discovery surfaced a ticket that clearly belongs on this release but is **not** linked, note it for the user rather than auto-linking.

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
PRs written to Dependencies: [N] ([list ST repos], [MT count])
Subtasks: [✓ Coding/Development ({JIRA_PROJECT}-XXXXX) + ✓ Manual Testing ({JIRA_PROJECT}-XXXXX)] OR [⚠ Not yet created — check automation]
Description grade: [✓ good-A] OR [⚠ {actual grade} — review description] OR [— not yet graded]
```
