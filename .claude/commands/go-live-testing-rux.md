## Pre-flight — Read configuration

Before doing anything else, read the `.env` file at the repo root using the `Read` tool and extract these variables:

- `REPOS_PARENT` (default: `C:\Git-Repositories`) → used to construct the `blt-e2e` path: `{REPOS_PARENT}\blt-e2e`
- `BLT_DOMAIN` (e.g. `blt.example.com`) → used for URL parsing below

---

You are running go-live testing for the RUX (React UX / Spark UI) platform on a `blt-e2e` TestCafe suite.

Work through the phases below in order. Complete each phase fully before moving to the next. The current implementation covers Phase 1 only; Phase 2 sections will be added incrementally.

---

## Phase 1 — Configure .env for the target environment

### Step 1: Ask for the URL

Ask the user exactly this:

> "What is the URL we're go-live testing? (e.g. `https://[tenant-name]-staging.{BLT_DOMAIN}/`)"

Wait for their response before doing anything else.

### Step 2: Parse the URL

From the URL the user provides, derive these three values:

**Environment label** — determined by URL structure:
- URL contains `-staging.{BLT_DOMAIN}` → `Staging`
- URL contains `.qa.{BLT_DOMAIN}` → `QA`
- URL contains `-uat.{BLT_DOMAIN}` → `UAT`

**Subdomain** — the hostname segment before `.{BLT_DOMAIN}` or `.qa.{BLT_DOMAIN}`:
- `https://[tenant-name]-staging.{BLT_DOMAIN}/` → subdomain = `[tenant-name]-staging`
- `https://[tenant-name]-uat.{BLT_DOMAIN}/` → subdomain = `[tenant-name]-uat`
- `https://[my-test-tenant].qa.{BLT_DOMAIN}/` → subdomain = `[my-test-tenant]`

**Tenant name** — subdomain with the environment suffix stripped:
- `[tenant-name]-staging` → `[tenant-name]`
- `[tenant-name]-uat` → `[tenant-name]`
- `[my-test-tenant]` → `[my-test-tenant]` (QA subdomain has no suffix to strip)

The three output lines you will write are:
```
# <tenant> <Environment> Site
TEST_TENANT='<subdomain> react'
TEST_TENANT_URL='<url-exactly-as-provided>'
```

Example for `https://[tenant-name]-uat.{BLT_DOMAIN}/`:
```
# [tenant-name] UAT Site
TEST_TENANT='[tenant-name]-uat react'
TEST_TENANT_URL='https://[tenant-name]-uat.{BLT_DOMAIN}/'
```

### Step 3: Read .env

Read `{REPOS_PARENT}\blt-e2e\.env` in full before making any changes.

### Step 4: Plan the edit

Identify:
1. Every line matching `^TEST_TENANT=` or `^TEST_TENANT_URL=` (uncommented) — these need `# ` prepended
2. The **last tenant block** in the file — defined as the last `# ... Site` comment followed immediately by a `TEST_TENANT` line and a `TEST_TENANT_URL` line (whether currently commented or not). This entire three-line block will be **replaced** with the new three lines.

Rules:
- Lines 1–12 (ENV, API_URL, LOGIN_EMAIL, LOGIN_PASS, EMAIL_TEST_ADDR, EMAIL_TEST_PASS, gmail comment) are never touched.
- Do not add or remove blank lines anywhere else in the file.
- Do not duplicate comment headers. Replace the last block's comment header, don't append a new block.

### Step 5: Confirm with the user

Show the user exactly what you intend to write for the new last block:

> "I'll update `.env` with the following block as the active tenant (all others will be commented out):"
>
> ```
> # <tenant> <Environment> Site
> TEST_TENANT='<subdomain> react'
> TEST_TENANT_URL='<url>'
> ```
>
> "Confirm? (yes / no)"

Do not write anything until the user confirms. If they say no, stop and ask what to change.

### Step 6: Write the changes

Use the Edit tool to make the minimal changes to `.env`:
1. Comment out any currently-uncommented `TEST_TENANT=` or `TEST_TENANT_URL=` lines (outside the last block).
2. Replace the three lines of the last block with the new values.

### Step 7: Verify

Read `.env` back. Confirm:
- Exactly one uncommented `TEST_TENANT=` line exists.
- Exactly one uncommented `TEST_TENANT_URL=` line exists.
- They match what the user approved.

Report the final active block to the user so they can visually verify it.

---

## Phase 2 — Test execution

_Sections are built incrementally via `/design`. Placeholder sections are marked `_(not yet implemented)_`. When implementing a section, replace its placeholder with the full step-by-step instructions._

New tests live in `tests/goLive/rux/` inside `blt-e2e`. Existing tests reuse their current filter flags. New tests get `goLiveRux*` filter flags added to `config.js`.

---

### 2.A — Pre-login

Tests run without a logged-in user. Run all 4 checks in order — do not stop early if one fails.

All commands must run from `{REPOS_PARENT}\blt-e2e`. Use `cd {REPOS_PARENT}\blt-e2e &&` as a prefix on each Bash call.

---

#### Step 2.A.1 — Register new user

Run:
```
npx testcafe chrome tests/reactSites/account/reactCreateUserNonAdmin.js -S -s takeOnFails=true,path=./artifacts/screenshots --assertion-timeout 30000 --skip-js-errors --page-request-timeout 30000
```

Record result: **PASS** (exit code 0) or **FAIL** (non-zero). Proceed to next step regardless.

---

#### Step 2.A.2 — Password reset

Run:
```
npx testcafe chrome tests/reactSites/account/resetPassword.js -S -s takeOnFails=true,path=./artifacts/screenshots --assertion-timeout 30000 --skip-js-errors --page-request-timeout 30000
```

This file contains two tests (invalid user + business user). Both must pass for this check to count as PASS.

Record result: **PASS** or **FAIL**. Proceed to next step regardless.

---

#### Step 2.A.3 — Terms of Use

Run:
```
npx testcafe chrome tests/businessCenter/termsOfUse.js -S -s takeOnFails=true,path=./artifacts/screenshots --assertion-timeout 30000 --skip-js-errors --page-request-timeout 30000
```

Record result: **PASS** or **FAIL**. Proceed to next step regardless.

---

#### Step 2.A.4 — Help dropdown / FAQ (pre-login)

Run:
```
npx testcafe chrome tests/reactSites/account/validateFAQLoginPage.js -S -s takeOnFails=true,path=./artifacts/screenshots --assertion-timeout 30000 --skip-js-errors --page-request-timeout 30000
```

Record result: **PASS** or **FAIL**.

---

#### Step 2.A.5 — Help dropdown / Quick Links (pre-login)

Run:
```
npx testcafe chrome ../qa-command-center/tests/e2e/validateQuickLinksLoginPage.js -S -s takeOnFails=true,path=./artifacts/screenshots --assertion-timeout 30000 --skip-js-errors --page-request-timeout 30000
```

Record result: **PASS** or **FAIL**. A **FAIL** here indicates the Quick Links page has not been configured with content for this tenant.

---

#### Step 2.A.6 — Summary

After all 5 tests have run, print a summary table:

| Check | Result |
|---|---|
| Register new user | PASS / FAIL |
| Password reset | PASS / FAIL |
| Terms of Use | PASS / FAIL |
| Help dropdown / FAQ | PASS / FAIL |
| Help dropdown / Quick Links | PASS / FAIL |

If any check failed, add: "Screenshots for failed tests are in `{REPOS_PARENT}\blt-e2e\artifacts\screenshots\`."

---

### 2.B — Dashboard: Top Toolbar _(not yet implemented)_

- Help dropdown (FAQs, Quick Links) matches Legacy site content
- Cart icon navigates to shopping cart page
- Account menu → Log Out logs the user out and returns to login page

---

### 2.C — Dashboard: Left Toolbar _(not yet implemented)_

- Collapse/Expand toggles the sidebar correctly
- Dashboard nav item is present and active on load
- Manage Accounts nav item shows the count of businesses attached to the test user
- Administration nav item is visible for admin users; hidden for non-admin users; clicking it redirects to Legacy site
- Transaction History nav item navigates to the transaction history page
- Pendo Help Button is present (BLT sites only — skip if not a BLT site)

Existing tests to reuse: `verifyTransactionHistoryPageLoads`

---

### 2.D — Dashboard: Main Content (pre-account) _(not yet implemented)_

- "Use Previous Layout" button reverts to legacy site; legacy site shows "Return to Spark" button that navigates back
- Announcements panel is present and matches announcements on Legacy site; "View All" loads all announcements with correct formatting
- Before connecting to an account: Business Details section is blank and "Welcome to…" section shows applicable registration options (confirm against Legacy)

Existing tests to reuse: `sutsValidateAnnouncements`

---

### 2.E — Dashboard: Main Content (post-account) _(not yet implemented)_

- Business Select Dropdown appears only when user is connected to 2+ businesses; switching businesses updates details and activity
- Business Details section shows: Business Name, Business Type, Business Account Number, Activation Code
- "Share Activation Code" opens share modal with Copy Data action
- "View" button navigates to Business Settings page
- Activity section loads with All / New & Pending / Completed filter tabs working correctly
- Activity section column sorting works on all columns
- Workflows that should not be removable (return payment fees, approval tasks) cannot be removed; others can be removed individually and in bulk

Existing tests to reuse: `sutsValidateBusinessDetails`

---

### 2.F — Manage Accounts _(not yet implemented)_

- "Expand All" expands all attached businesses to show open/pending workflow details
- "Remove" removes user from a single account and from multiple accounts
- "Hide" hides a business from default view; hidden businesses only visible when "Show hidden businesses" toggle is on; "Unhide" works; tested with 1 and 2+ accounts
- All / Due This Month / Past Due filters return correct task sets
- "Add a Business" popup shows applicable registration options (confirm against Legacy)
- "View Dashboard" navigates back to that business's dashboard; tested with multiple businesses

Existing tests to reuse: `sutsValidateManageAccounts`, `sutsAddABusiness`

---

### 2.G — Registration Workflows _(not yet implemented)_

- "I'm connecting to an established account": mismatched account number + activation code from a different business does NOT link; both fields enforce 6-digit validation; valid pair adds business to list
- "Add a business registering for the first time": all forms, tasks, document uploaders, fees match Legacy functionality

---

### 2.H — Workflow Execution _(not yet implemented)_

_Each site has unique workflows — these checks apply to every active workflow on the tenant under test._

- UI text in workflow matches Legacy (no "click the Orange button" when button is now Blue/Continue)
- Info messages display; document uploaders function
- Submitting with missing required fields shows validation errors; errors are sensible
- Partial fills with quotes/apostrophes save correctly on Save/Continue
- Radio buttons retain state after a failed submit
- Date pickers appear and function; all options make sense
- "Save and return to business center" saves state; returning to workflow restores all saved data
- Top task bar cannot be used to skip ahead in a multi-step task
- After submit: approval shows correct form data and document uploads; approving updates business details; generated licenses/emails render correctly; paid fees appear in Transactions tab

---

### 2.I — Shopping Cart _(not yet implemented)_

- Single pending-payment workflow: cart icon → select task → redirects to payment screen
- Multiple pending-payment workflows across businesses: cart icon → select all → bulk payment screen handles all selected tasks
- Past-due task: P&I is applied to total on payment screen when task due date has been edited past-due from admin side
