## Pre-flight — Read configuration

Before doing anything else, read the `.env` file at the repo root using the `Read` tool and extract these variables for use throughout this skill:

- `JIRA_BASE_URL` → strip `https://` to get `{JIRA_DOMAIN}` (e.g. `your-company.atlassian.net`)
- `GITHUB_ORG`
- `JIRA_PROJECT`
- `JIRA_RELEASES_EPIC`
- `RELEASE_APP_REPO`

---

You are executing **Phase 1** (Teams triage) and **Phase 2** (Jira story creation) of the daily release process.

- **Phase 1** = Steps 1–5: Read the Teams channel, identify pending release requests, resolve tickets and PRs, output the triage report, and wait for you to confirm.
- **Phase 2** = Steps 6–7: Create (or verify) today's Daily Releases Jira story with all fields, issue links, and subtasks configured.
- **Phase 3** = `/releases-merge` skill (merge PRs, create release tags; gate on staging-PR CI + explicit go-ahead for `/fast-forward`)
- **Phase 5** = `/releases-deploy` skill (production deploy via `deploy-production.yml`, which runs the e2e regression suite as a built-in blocking tollgate)

> **Phase 4 retired:** the standalone `/releases-regression` step no longer exists — its e2e suite now runs as a blocking gate inside the Phase 5 deploy workflow.

## Pre-flight — Determine the release blackout window

**Policy:** No releases are permitted in the window spanning **3 business days before through 3 business days after the 20th of the month** — *unless* the request is a **P0 or P1** priority ticket. During the blackout window, any pending request whose Jira priority is **not** P0/P1 must be **held** (excluded from today's release) and flagged in the report.

Compute the window up front, using today's date (the `currentDate` provided in context; confirm with `date +%F` if unsure):

1. Anchor on the **20th of the current month**.
2. Walk **backward 3 business days** (Mon–Fri, skipping Sat/Sun) from the 20th → blackout **start** date.
3. Walk **forward 3 business days** from the 20th → blackout **end** date.
4. The blackout window is `[start, end]` inclusive. *(Worked example: June 2026 — the 20th is a Saturday; 3 business days before = Tue Jun 17, 3 business days after = Wed Jun 24 → blackout = **Jun 17–24, 2026**.)*
5. Record whether **today** falls inside `[start, end]`. Store as `{IN_BLACKOUT}` (true/false). Always report the computed window in the Step 5 header, regardless of the value.

> Business-day counting excludes weekends only. If company holidays might shift the count, note the uncertainty in the report rather than guessing.

If `{IN_BLACKOUT}` is false, the priority gate in Step 3.8 is a no-op — every priority is eligible. Priority is still fetched and shown in the report for visibility.

### Priority → eligibility mapping

This Jira instance uses two overlapping priority naming schemes. A request is **blackout-eligible (P0/P1)** if its priority name matches any of:
- contains `(p0)` or `(p1)` — e.g. `Emergency (p0)`, `Critical (p1)`
- starts with `P1` — e.g. `P1 Highest-Critical`

**Everything else is held during blackout**, including: `Major (p2)`, `Minor (p3)`, `Trivial (p4)`, `P2 High`, `P3 Medium (Default)`, `P4 Low`.

## Channel details

- Chat ID: `19:7e219e0790d54cd4811d6a4ecad93c5a@thread.tacv2`
- Read messages using: `teams:///chats/19%3A7e219e0790d54cd4811d6a4ecad93c5a%40thread.tacv2/messages`
- Read a specific message using: `teams:///chats/19%3A7e219e0790d54cd4811d6a4ecad93c5a%40thread.tacv2/messages/{messageId}`
- Jira cloud ID: `{JIRA_DOMAIN}` (from `JIRA_BASE_URL` in `.env`)

## Pre-flight — Load deferred tools

All MCP tools used in this workflow are deferred and **must be loaded via ToolSearch before any other step**. Do this first, in parallel:

```
ToolSearch("select:mcp__claude_ai_Microsoft_365__read_resource")
ToolSearch("select:mcp__claude_ai_Atlassian__getJiraIssue")
ToolSearch("select:mcp__claude_ai_Atlassian__createIssueLink")
ToolSearch("select:mcp__claude_ai_Atlassian__addWorklogToJiraIssue")
```

Do not proceed until both tools are confirmed available.

## Step 1 — Fetch channel messages

Read the channel message list URI. It returns the most recent messages as concatenated JSON objects (not a JSON array — parse each `{...}` block separately).

**Important limitation:** The list endpoint does NOT include `reactions` data. To check whether a message has a custom reaction, you must fetch it individually via the per-message URI.

**Deleted messages:** Any message with a `null` body content AND a `deletedDateTime` field set is a deleted post — skip it entirely, it is not a release request.

Collect from the list:
- `id`
- `from.displayName`
- `createdDateTime`
- `body.content` (HTML — parse links and text from it; may be null if deleted)
- `deletedDateTime` (if present and non-null → deleted, skip)
- `reactions` (note: will be empty `[]` in list view even if reactions exist — fetch individually to verify)

**Immediately after reading the list**, fetch every non-deleted message individually in a single parallel batch using the per-message URI. Do not try to predict which messages need fetching — fetch all of them at once. This gives you complete `reactions` data for all messages before Step 2 begins, with no further individual fetches needed.

## Step 2 — Find the pending queue

1. Identify the **last message** that has a reaction with `reactionType: "custom"` — this is the Done (✅DONE) emoji the user adds when a release is complete.
   - Use the individually-fetched message data from Step 1 (already complete — no additional fetches needed).
2. All messages **after** that message's `createdDateTime` are candidates.
3. From those candidates, keep only messages that satisfy **both**:
   - No `reactionType: "custom"` on the post itself
   - No reply from the user containing "this release is complete"
4. From those, **exclude** any message where:
   - The PR URL targets the `/RUX/` repo (e.g. `github.com/{GITHUB_ORG}/RUX/pull/...`) — another team handles RUX releases
5. The remaining messages are the **pending release requests**.

Note: SUTS-tagged requests are **no longer excluded**. SUTS detection happens in Step 3.7 and is informational only — used to label the PR in the Step 5 report and Step 6 Jira description. RUX repo is the sole exclusion criterion.

If no message with a custom reaction exists, treat all messages as candidates and note this.

## Step 3 — Resolve JIRA ticket + PR for each pending request

**Speed rule:** As soon as the pending release list is finalized (end of Step 2), fire ALL of the following simultaneously in one parallel batch — do not wait for one check to finish before starting the next:
- `getJiraIssue` for every pending ticket (Step 3)
- `gh api graphql` review-thread query for every confirmed PR (Step 3.5)
- `gh api repos/.../pulls/N/files` migration check for every ST repo PR (Step 3.6)

SUTS detection (Step 3.7) reuses the Jira issue summary returned by the Step 3 call — no additional network call is needed. The blackout priority gate (Step 3.8) reuses `fields.priority.name` from the same call. Run both during the same analysis pass after the batch returns.

Analyze confidence and assemble the report only after the entire batch has returned.

Apply this decision tree for each pending message:

### Extract from post body
- **Jira URL**: Look for `{JIRA_BASE_URL}/browse/TICKET` or `{JIRA_DOMAIN_OLD}/browse/TICKET` (old domain, still valid)
- **PR URL**: Look for `github.com/{GITHUB_ORG}/*/pull/NNN`
- **Branch name**: Look for text labeled `Branch:`, `BR:`, or a string matching the pattern `[a-z]+-\d+-[a-z-]+`
- **Tenant URL**: Look for any URL matching `https://*.munirevs.com[/...]`, `https://*.blt.govos.com[/...]`, or `https://suts.blt.govos.com[/...]`. This is the Smoke-Check URL for the PR in the Step 6 Dependencies list. If no tenant URL is present in the post body:
  - For SUTS-tagged requests → fall back to `https://suts.blt.govos.com/`
  - For MRNexus (MT) requests → fall back to the originating tenant from the corresponding Jira ticket if mentioned in a developer comment, otherwise use the first tenant URL seen in any developer comment, otherwise leave as `(MT — production smoke check on default MT site)` and flag in the report

### Derive missing pieces
- If no Jira key found → extract from branch name: the first segment matching `[A-Za-z]+-\d+` (case-insensitive, e.g. `proj-20097` → `PROJ-20097`)
- If no PR URL found → proceed to Jira comment lookup below

### Jira comment lookup (always do this, even when post provides both)
Fetch the Jira issue using `getJiraIssue` with `fields: ["summary", "status", "comment", "priority"]` and `responseContentFormat: "markdown"`. Fetch all pending tickets in parallel. The `priority` field (`fields.priority.name`) feeds the blackout gate in Step 3.8 — no extra API call is needed.

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
    else if (i.type==='hardBreak') out.push('\n');
    else if (i.content) out.push(...extractText(i.content));
  }
  return out;
}
const comments = issue.fields.comment.comments.slice(-10);
for (const c of comments) {
  const txt = extractText(c.body && c.body.content || []).join('');
  console.log('['+c.created.substring(0,16)+'] '+c.author.displayName+':');
  console.log(txt.substring(0,600));
  console.log();
}
"
```

Note: Python is not available on this machine — always use Node.js (`node -e`) for Bash scripting.

**Markdown response path:** If the tool returns a markdown string directly (no file save), scan only the last 10 comment blocks (search from the bottom of the response) rather than reading the full output.

Scan comments for developer-posted entries that mention a branch name and/or a GitHub PR URL.

- If multiple PR-mentioning comments exist → use the **newest** one
- Cross-reference what the developer's comment says vs. what the requester posted:
  - Branch matches, PR matches → confirms HIGH confidence
  - Branch matches, PR differs → trust developer's comment, flag discrepancy
  - Branch mismatches → flag for manual review
  - No developer comment found → flag for manual lookup

### Multiple tickets on one branch
If the Jira comments or branch name suggest multiple ticket keys (e.g. the developer mentions a second ticket), list all of them and flag as MULTI-TICKET.

## Step 3.5 — Check each PR for unresolved review comments

For every confirmed PR (regardless of confidence level), run the following GraphQL query to detect unresolved review threads. Run all queries in parallel.

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

Replace `REPO` with the repo name (e.g. `{RELEASE_APP_REPO}`, `[example-repo]`) and `N` with the PR number.

- If **any** `isResolved` value is `false` → the PR has unresolved review comments. Mark it as **SEND BACK TO DEVELOPER** in the Step 5 report. Do not release it.
- If all are `true` (or the array is empty) → no action needed.

Add a `Review Comments` field to every request block in the Step 5 report:
- `✓ No unresolved comments` — safe to release
- `⚠ UNRESOLVED COMMENTS — send back to developer` — do not include in today's release

**Important:** PRs flagged as SEND BACK TO DEVELOPER should be omitted from the Jira story's PR list in Step 6, and should NOT be merged in Phase 3. Note them prominently in the Step 5 report so the user can notify the developer.

## Step 3.6 — Check ST repo PRs for migrations

For every confirmed PR in a **non-`{RELEASE_APP_REPO}` (ST) repo**, check whether the PR contains migration files. Run all checks in parallel.

```bash
gh api repos/{GITHUB_ORG}/REPO/pulls/N/files --jq '[.[] | select(.filename | test("migrations/"; "i")) | .filename]'
```

Replace `REPO` and `N` with the repo name and PR number.

- If the output is a non-empty array → the PR has migrations that must be run manually on the ST tenant. Mark it with `(has migrations — run manually)` in the Step 5 report and in the Step 6 Jira description PR list.
- If the output is `[]` → no annotation needed.
- Skip `{RELEASE_APP_REPO}` PRs — MT migrations are handled automatically during the merge process.

## Step 3.7 — Detect SUTS-targeted requests

Flag each pending request as **SUTS-targeted** if any of the following (case-insensitive) contain the substring `suts`:
- The Jira ticket URL from the post body
- The tenant URL from the post body (if one is present)
- The Jira ticket summary returned by the `getJiraIssue` call in Step 3

This detection is **informational only** — it never causes a request to be excluded (RUX repo is the sole exclusion criterion, applied in Step 2). It is used to:
- Append a `_(SUTS)_` tag to the PR line in the Step 5 report
- Append a ` — SUTS` annotation to the PR entry in the Step 6 Jira description

No additional API call is required — the Jira summary needed for this check is already in the Step 3 response.

## Step 3.8 — Apply the release blackout priority gate

Using `{IN_BLACKOUT}` (from the Pre-flight blackout computation) and each ticket's `fields.priority.name` (from the Step 3 `getJiraIssue` response — no extra call):

- **If `{IN_BLACKOUT}` is false** → gate is a no-op. Every request is eligible. Still record each request's priority name for the report.
- **If `{IN_BLACKOUT}` is true** → for each pending request, classify its priority via the eligibility mapping in the Pre-flight section:
  - **Eligible (P0/P1)** — priority name contains `(p0)` / `(p1)`, or starts with `P1` → request stays in today's release.
  - **Held (not P0/P1)** — any other priority → mark the request **HELD — release blackout (not P0/P1)**. It is **excluded from today's release**: omit it from the Jira story PR list in Step 6, and do **not** merge it in Phase 3. Surface it prominently in the Step 5 report so the user can tell the requester it's deferred until after the blackout window.

This gate is independent of confidence and review-comment status — a HIGH-confidence, clean-review P2 ticket is still HELD during the blackout. Like the review-comment gate, the user may explicitly override it (e.g. a P2 that leadership has cleared); apply an override only on explicit user direction in the conversation, and note it in the report.

Add a `Priority` field to every request block in the Step 5 report:
- `✓ {priority name} — eligible` (P0/P1, or any priority outside the blackout window)
- `⛔ {priority name} — HELD (release blackout, not P0/P1)` (held requests)

## Step 4 — Assign confidence level

| Level | Criteria |
|---|---|
| **HIGH** | Requester provided both JIRA + PR, developer comment confirms both match |
| **MEDIUM** | One piece was missing from the post but found via Jira comments, and cross-checks pass |
| **LOW** | Mismatch found between requester post and developer comment; or multiple conflicting PRs; or ticket had to be inferred from branch name only |
| **NEEDS MANUAL REVIEW** | No branch name, no Jira key derivable, or irreconcilable conflict |

## Step 5 — Output the report

Present results clearly, one block per pending request, in chronological order (oldest first). Use this format:

---

**Pending Release Requests — [today's date]**
**Release blackout window: [start]–[end]** — Today is [inside / outside] the blackout. [If inside: Only P0/P1 requests are eligible; all others are HELD.]

---

**Request 1** *(HIGH confidence — compact format)*
Requester: [Full name]
Posted: [time, e.g. 3:04 PM]
JIRA: [full URL] — [ticket summary from Jira lookup]
PR: [full GitHub URL] _(SUTS)_ _(has migrations — run manually)_ ← append `_(SUTS)_` only if Step 3.7 flagged the request; append `_(has migrations — run manually)_` only if Step 3.6 detected migrations; omit either or both otherwise. Order is `_(SUTS)_` first, then `_(has migrations — run manually)_`.
Review Comments: [✓ No unresolved comments] OR [⚠ UNRESOLVED COMMENTS — send back to developer]
Priority: [✓ {priority name} — eligible] OR [⛔ {priority name} — HELD (release blackout, not P0/P1)]
Confidence: HIGH

---

**Request 2** *(MEDIUM / LOW / NEEDS MANUAL REVIEW — full format)*
Requester: [Full name]
Posted: [time, e.g. 3:04 PM]
JIRA: [full URL] — [ticket summary from Jira lookup]
PR: [full GitHub URL] _(SUTS)_ _(has migrations — run manually)_ ← append `_(SUTS)_` only if Step 3.7 flagged the request; append `_(has migrations — run manually)_` only if Step 3.6 detected migrations; omit either or both otherwise. Order is `_(SUTS)_` first, then `_(has migrations — run manually)_`.
Review Comments: [✓ No unresolved comments] OR [⚠ UNRESOLVED COMMENTS — send back to developer]
Priority: [✓ {priority name} — eligible] OR [⛔ {priority name} — HELD (release blackout, not P0/P1)]
Confidence: [MEDIUM / LOW / NEEDS MANUAL REVIEW]
Notes: [brief explanation — what matched, what was derived, any discrepancies]

---

**Request 3**
...

---

After the list, include a **Summary** line:
`X pending requests — Y HIGH, Z MEDIUM, W LOW, V NEEDS MANUAL REVIEW`

If there are any NEEDS MANUAL REVIEW items, list what specific information is missing so the user knows exactly what to look for.

If the blackout gate (Step 3.8) HELD any requests, add a **Blackout** line listing them so the user can defer them:
`Held for release blackout ([window]) — not P0/P1: [ticket] ({priority}), [ticket] ({priority})`
These are excluded from Step 6's story PR list and from Phase 3 merging unless the user explicitly overrides.

## Important rules

- Always look up the Jira ticket even when the post appears to have everything — the developer's comment is the source of truth for branch and PR.
- If the Jira API returns an error for a ticket key, note it rather than skipping the request.
- Normalize Jira keys to uppercase (e.g. `proj-20097` → `PROJ-20097`).
- Never guess a PR URL — only report one if it was found in the post or in a Jira comment.
- Do not include posts from the user that are "this release is complete" replies — only original release request posts.
- **RUX exclusion**: If a request's PR targets the `{GITHUB_ORG}/RUX` repo, omit it from the report entirely and note at the bottom: `Excluded (RUX — handled by another team): [ticket]`.
- **SUTS handling**: SUTS-tagged requests (detected in Step 3.7) are **not excluded** — they are included in the report and labeled with `_(SUTS)_` on the PR line. They are also annotated with `— SUTS` in the Step 6 Jira description.
- **Release blackout**: During the blackout window (3 business days before/after the 20th, computed in Pre-flight), only **P0/P1** requests are eligible — all others are HELD (Step 3.8), excluded from the Step 6 story PR list and from Phase 3 merging unless the user explicitly overrides. Outside the window the gate is a no-op. Always show the computed window and each request's priority in the report.

---

## Step 5.5 — Confirmation checkpoint

After outputting the Step 5 report, **stop and wait for the user to confirm** before proceeding to Step 6. Do not create or check for the Jira story until the user explicitly says to continue (e.g. "looks good", "go ahead", "continue"). If they request corrections, apply them and re-present the report before asking again.

---

## Step 5.7 — BLT-Eng General channel notification check

Before creating the Jira story, check whether today's start notification has been posted in the BLT-Eng General channel:

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

## Step 6 — Create or verify today's Daily Releases story

After the user confirms the pending release report and the Release Team has been notified, create (or verify) the Jira story that tracks today's release work.

### Resolve current user's account ID

Before creating or editing any Jira issue, load `atlassianUserInfo` via ToolSearch and call it to resolve the current user's Atlassian `accountId`. Store the result as `{ACCOUNT_ID}` for all subsequent `editJiraIssue` calls in this phase.

```
ToolSearch("select:mcp__claude_ai_Atlassian__atlassianUserInfo")
```

### Check for existing story
Search for a non-closed story matching `summary ~ "Releases YYYY-MM-DD"` under epic `{JIRA_RELEASES_EPIC}` using JQL:
```
summary ~ "Releases [TODAY]" AND "Epic Link" = {JIRA_RELEASES_EPIC} AND statusCategory != Done
```
- **If found**: use that issue key — skip to "Ensure fields are populated" below.
- **If not found**: create a new story (see "Create the story" below).

### Create the story
Use `createJiraIssue` with:
- `project`: `{JIRA_PROJECT}`
- `issuetype`: `Story` (id `10000`)
- `summary`: `Releases YYYY-MM-DD` (today's date)
- `parent`: `{JIRA_RELEASES_EPIC}`
- Then proceed to populate all fields via `editJiraIssue` as below.

### Ensure fields are populated
Use `editJiraIssue` on the story key. Set any fields that are missing or null:

| Field | Value |
|---|---|
| `assignee` | `{"accountId": "{ACCOUNT_ID}"}` (the user) |
| `customfield_11462` (Primary Driver/Goal) | `{"id": "10924"}` ("Internal Op") |
| `customfield_11477` (Developer) | `[{"accountId": "{ACCOUNT_ID}"}]` |
| `customfield_11478` (QA Engineer) | `[{"accountId": "{ACCOUNT_ID}"}]` |
| `customfield_10028` (Story Points) | `2` |
| `timetracking` | `{"originalEstimate": "2h"}` |
| `description` | Use the template below (markdown format, `contentFormat: "markdown"`) |

### Description template

The template below produces a description aligned with the Jira description-grader rubric (target: `good-A`). The grader rejects generic process boilerplate and demands concrete, testable specifics — every section below exists to satisfy one of its rubric items, so do not strip detail in the name of brevity.

Substitute the following placeholders before submitting:

| Placeholder | How to fill it |
|---|---|
| `[FULL DATE]` | Formatted date — e.g. `May 20, 2026` |
| `[ISO DATE]` | Same date in ISO form — e.g. `2026-05-20` |
| `[RELEASE NARRATIVE]` | One paragraph (2–4 sentences) listing each release item by ticket key and a short value-phrase (e.g. `a batch-edit performance fix (BLTE-20164)`, `a Lyndon, KY XML schema (BLI-2442)`). Use the Jira summaries fetched in Step 3 to derive each value-phrase — paraphrase to one short noun phrase per ticket; do **not** quote the full Jira summary. Close the paragraph with: `Tracking time here feeds release-effort reporting and continuous process improvement.` |
| `[QA NAME]` | The current user's `displayName` from `atlassianUserInfo` — e.g. `Allen Manning` |
| `[PR LIST]` | The PR list (see structure below) |

```
This story coordinates the [FULL DATE] production release across Munirevs' multi-tenant (MRNexus) and single-tenant (ST repo) platforms. [RELEASE NARRATIVE]

### Acceptance Criteria

1. **Merge.** Given the PRs in Dependencies are ready, when each is merged to `staging`, then no merge conflicts occur and the resulting `staging` build deploys without error.
2. **Regression validation.** Given staging regression tests are run, then the run completes with either: (a) all tests passing, (b) all failures matching the pre-documented expected-failure list (production Jira step, SUTS migration step), or (c) any other failure documented by the QA Engineer ([QA NAME]) as a comment on this story containing failure name, root cause hypothesis, and the literal text `Approved to proceed — [QA NAME]` before production deployment begins.
3. **Smoke check.** Given production deployment completes, when smoke checks are run, then each Smoke-Check URL listed in Dependencies returns HTTP 200, the primary navigation renders within 10 seconds, and no new 5xx responses appear in the browser network tab. Pre-existing JS console errors are out of scope.
4. **Notify requesters.** After production deploy is confirmed, a ✅DONE reaction is added to each original release request post in the Microsoft Teams `Release-Requests-Production` channel (team `BLT-Eng`).
5. **Time logging.** All time spent on this release is logged to this story or its subtasks with activity descriptions before EOD.

### Scope

**In scope:** Deployment of the PRs listed in Dependencies to production on [FULL DATE]. SUTS-tagged PRs target the Colorado SUTS (Sales & Use Tax System) tenant. MRNexus migrations are applied automatically; ST-repo PRs that contain migrations are annotated inline.

**Out of scope:** Hotfixes raised after staging cutoff, schema migrations not referenced in the listed PRs, RUX repo releases (handled by a separate team), and any change not merged to `staging` before regression testing begins.

### Dependencies

Release PRs (each row lists the PR, Smoke-Check URL, and migration/SUTS notes):

[PR LIST]

### Definition of Done

1. All Dependencies PRs merged to `staging` with no conflicts (per AC #1).
2. Regression tests pass or all failures signed off per AC #2.
3. All Smoke-Check URLs verified healthy after production deploy (per AC #3).
4. ✅DONE reactions posted to every release request in the Teams `Release-Requests-Production` channel (per AC #4).
5. Time logged on this story or its subtasks with activity descriptions before EOD (per AC #5).
```

### `[PR LIST]` structure

One bullet per PR. Each bullet must include the PR link, the Smoke-Check URL (from Step 3 tenant-URL extraction), and any SUTS / migration annotations:

```
* [https://github.com/{GITHUB_ORG}/{st-repo}/pull/{N}](https://github.com/{GITHUB_ORG}/{st-repo}/pull/{N}) — Smoke-Check URL: {tenant-url} — SUTS — has migrations — run manually
* [https://github.com/{GITHUB_ORG}/{RELEASE_APP_REPO}/pull/{N}](https://github.com/{GITHUB_ORG}/{RELEASE_APP_REPO}/pull/{N}) — Smoke-Check URL: {tenant-url} — SUTS — MRNexus migration applied automatically
* [https://github.com/{GITHUB_ORG}/{st-repo-without-migration}/pull/{N}](https://github.com/{GITHUB_ORG}/{st-repo-without-migration}/pull/{N}) — Smoke-Check URL: {tenant-url} — No migration
```

Annotation rules per bullet (compose in this order, separated by ` — `):

1. **PR link** — `[full-url](full-url)` markdown link, same URL in both positions so Jira renders it clickable.
2. **Smoke-Check URL** — `Smoke-Check URL: {tenant-url-from-step-3}`. Always include — this is what AC #3 tests against.
3. **SUTS** — append ` — SUTS` if Step 3.7 flagged the request. Omit otherwise.
4. **Migration annotation** — required on every bullet:
   - ST repo with migrations detected in Step 3.6 → `has migrations — run manually`
   - ST repo with no migrations → `No migration`
   - MRNexus PR (regardless of SUTS) → `MRNexus migration applied automatically`

**PR grouping rule:** List all non-`{RELEASE_APP_REPO}` (ST) PRs first, grouped by repo and sorted alphabetically by repo name. List all `{RELEASE_APP_REPO}` (MT) PRs last. This ordering ensures `/releases-merge` naturally processes ST repos before MT when reading top-to-bottom.

**Important:** Each PR must use `[full-url](full-url)` markdown link syntax with the same URL in both positions so Jira renders it as a clickable link. Example:
`[https://github.com/{GITHUB_ORG}/[example-repo]/pull/768](https://github.com/{GITHUB_ORG}/[example-repo]/pull/768)`

### Link story to each pending ticket

After `editJiraIssue` completes, create an issue link from the Daily Releases story to **each** pending ticket using `createIssueLink`. Run all link calls in parallel.

For each pending ticket key (e.g. `PROJ-5583`, `PROJ-20094`, etc.):

```
createIssueLink({
  cloudId: "{JIRA_DOMAIN}",
  type: "Polaris work item link",
  outwardIssue: "<CHILD-TICKET-KEY>",
  inwardIssue: "<STORY-KEY>"
})
```

- Link type confirmed: `"Polaris work item link"` (id 10301) — outward label = "implements", inward label = "is implemented by"
- `inwardIssue` = the Daily Releases story (renders as "implements" on the story when viewed)
- `outwardIssue` = the child ticket being released
- Note: the API parameter names are counterintuitive — setting the story as `inwardIssue` is what produces the "implements" label on the story's Linked Work Items panel.

## Step 7 — Wait for automation subtasks + description grade

After the story is created or confirmed, poll for two things simultaneously:
1. The two automation-created subtasks: **"Coding/Development"** and **"Manual Testing"**
2. A comment from **"Automation for Jira"** containing a description grade

Re-fetch the story every ~15 seconds (up to 2 minutes / ~8 polls) using `getJiraIssue` with `fields: ["subtasks", "comment"]`.

### Subtasks
- Stop polling as soon as both subtasks appear.
- If 2 minutes elapse without both subtasks: report the story link, state that the automation subtasks have not appeared, and **stop execution** — do not proceed to further steps. Ask the user to confirm once the subtasks are visible before continuing.

Once both subtasks are found, immediately perform the following on each:

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
3. Transition to Closed: use `getTransitionsForJiraIssue` to find the "Closed" transition ID (last observed: `431`), then call `transitionJiraIssue`

### Description grade
- While polling, scan comments for one authored by a user whose display name contains "Automation for Jira".
- Extract the grade from the comment body (e.g. `Ticket grade: good-A`).
- Expected grade: **`good-A`**
- If the grade is anything other than `good-A`, include it prominently in the final output so the user can review the description.
- If no grading comment appears within the 2-minute window, note it but do not block on it.

### Final output
Always end with the story link regardless of subtask/grade status:

```
Story: https://{JIRA_BASE_URL}/browse/[ISSUE-KEY]
Subtasks: [✓ Coding/Development ({JIRA_PROJECT}-XXXXX) + ✓ Manual Testing ({JIRA_PROJECT}-XXXXX)] OR [⚠ Not yet created — check automation]
Description grade: [✓ good-A] OR [⚠ {actual grade} — review description] OR [— not yet graded]
```
