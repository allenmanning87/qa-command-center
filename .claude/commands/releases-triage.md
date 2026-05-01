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
- **Phase 3** = `/releases-merge` skill (merge PRs, create release tags)
- **Phase 4** = `/releases-regression` skill (staging regression tests)
- **Phase 5** = `/releases-deploy` skill (production deploy)

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
   - The Jira ticket URL or tenant URL contains `suts` — another team handles SUTS tenant deployments
5. The remaining messages are the **pending release requests**.

If no message with a custom reaction exists, treat all messages as candidates and note this.

## Step 3 — Resolve JIRA ticket + PR for each pending request

**Speed rule:** As soon as the pending release list is finalized (end of Step 2), fire ALL of the following simultaneously in one parallel batch — do not wait for one check to finish before starting the next:
- `getJiraIssue` for every pending ticket (Step 3)
- `gh api graphql` review-thread query for every confirmed PR (Step 3.5)
- `gh api repos/.../pulls/N/files` migration check for every ST repo PR (Step 3.6)

Analyze confidence and assemble the report only after the entire batch has returned.

Apply this decision tree for each pending message:

### Extract from post body
- **Jira URL**: Look for `{JIRA_BASE_URL}/browse/TICKET` or `{JIRA_DOMAIN_OLD}/browse/TICKET` (old domain, still valid)
- **PR URL**: Look for `github.com/{GITHUB_ORG}/*/pull/NNN`
- **Branch name**: Look for text labeled `Branch:`, `BR:`, or a string matching the pattern `[a-z]+-\d+-[a-z-]+`

### Derive missing pieces
- If no Jira key found → extract from branch name: the first segment matching `[A-Za-z]+-\d+` (case-insensitive, e.g. `proj-20097` → `PROJ-20097`)
- If no PR URL found → proceed to Jira comment lookup below

### Jira comment lookup (always do this, even when post provides both)
Fetch the Jira issue using `getJiraIssue` with `fields: ["summary", "status", "comment"]` and `responseContentFormat: "markdown"`. Fetch all pending tickets in parallel.

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

---

**Request 1** *(HIGH confidence — compact format)*
Requester: [Full name]
Posted: [time, e.g. 3:04 PM]
JIRA: [full URL] — [ticket summary from Jira lookup]
PR: [full GitHub URL] _(has migrations — run manually)_ ← only if Step 3.6 detected migrations; omit otherwise
Review Comments: [✓ No unresolved comments] OR [⚠ UNRESOLVED COMMENTS — send back to developer]
Confidence: HIGH

---

**Request 2** *(MEDIUM / LOW / NEEDS MANUAL REVIEW — full format)*
Requester: [Full name]
Posted: [time, e.g. 3:04 PM]
JIRA: [full URL] — [ticket summary from Jira lookup]
PR: [full GitHub URL] _(has migrations — run manually)_ ← only if Step 3.6 detected migrations; omit otherwise
Review Comments: [✓ No unresolved comments] OR [⚠ UNRESOLVED COMMENTS — send back to developer]
Confidence: [MEDIUM / LOW / NEEDS MANUAL REVIEW]
Notes: [brief explanation — what matched, what was derived, any discrepancies]

---

**Request 3**
...

---

After the list, include a **Summary** line:
`X pending requests — Y HIGH, Z MEDIUM, W LOW, V NEEDS MANUAL REVIEW`

If there are any NEEDS MANUAL REVIEW items, list what specific information is missing so the user knows exactly what to look for.

## Important rules

- Always look up the Jira ticket even when the post appears to have everything — the developer's comment is the source of truth for branch and PR.
- If the Jira API returns an error for a ticket key, note it rather than skipping the request.
- Normalize Jira keys to uppercase (e.g. `proj-20097` → `PROJ-20097`).
- Never guess a PR URL — only report one if it was found in the post or in a Jira comment.
- Do not include posts from the user that are "this release is complete" replies — only original release request posts.
- **RUX exclusion**: If a request's PR targets the `{GITHUB_ORG}/RUX` repo, omit it from the report entirely and note at the bottom: `Excluded (RUX — handled by another team): [ticket]`.
- **SUTS exclusion**: If a request's Jira URL or tenant URL contains `suts`, omit it from the report entirely and note at the bottom: `Excluded (SUTS — handled by another team): [ticket]`.

---

## Step 5.5 — Confirmation checkpoint

After outputting the Step 5 report, **stop and wait for the user to confirm** before proceeding to Step 6. Do not create or check for the Jira story until the user explicitly says to continue (e.g. "looks good", "go ahead", "continue"). If they request corrections, apply them and re-present the report before asking again.

---

## Step 5.7 — Release Team channel notification check

Before creating the Jira story, check whether today's start notification has been posted in the Release Team channel:

```
teams:///teams/45bde3a3-65a4-4699-8fe8-40fa4317752e/channels/19%3A4fba8c314fec43c49fea7724dbbcdc02%40thread.tacv2/messages
```

Scan the most recent messages for a post from the user created **today** (current date) that contains:
> I'm gonna start merging to `staging` for today's MT release

- **If found today**: report `✓ Release Team notified` and proceed to Step 6 immediately.
- **If not found**: display the following to the user and **stop until they confirm** the post has been made:

> Please post the following in the **Release Team 🚀** channel before I continue:
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
Replace `[FULL DATE]` with the formatted date (e.g. "April 10, 2026") and `[PR LIST]` with the grouped PR list described below:

```
This ticket tracks the daily release process for [FULL DATE]. It includes preparing release artifacts, coordinating with teams, executing the deployment, and verifying successful implementation. Time logged here helps track release effort and identify process improvements.

### Acceptance Criteria

1. All PRs in the Dependencies section are merged to `staging` without conflicts
2. Staging regression tests pass (or all failures are documented known issues)
3. Production deployment completes without errors; smoke check passes on affected tenant URLs
4. ✅DONE reaction added to each request in the Release Requests channel after production deploy
5. Time is logged to this story or its subtasks with activity descriptions before EOD

### Scope

Covers all components and features included in today's release. See dependencies for the specific changes being deployed.

### Dependencies

* Release PRs:

    * (ST repos — one bullet per PR, each repo grouped together, alphabetical by repo name)
    * [https://github.com/{GITHUB_ORG}/{st-repo}/pull/{N}](https://github.com/{GITHUB_ORG}/{st-repo}/pull/{N}) — has migrations — run manually ← append only if Step 3.6 detected migrations for this PR; omit otherwise
    * ({RELEASE_APP_REPO} always last)
    * [https://github.com/{GITHUB_ORG}/{RELEASE_APP_REPO}/pull/{N}](https://github.com/{GITHUB_ORG}/{RELEASE_APP_REPO}/pull/{N})
```

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
