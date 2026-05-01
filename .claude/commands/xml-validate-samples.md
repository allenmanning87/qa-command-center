# Validate XML Test Sample Files

You are validating a completed XML test sample library against the original ticket requirements and base screenshots. This skill is invoked automatically by `xml-generate-samples` after file generation, but can also be run independently.

---

## What You Need

You should already have in context (passed from `xml-generate-samples`):
- The **ticket requirements** (form element tag, field tags, calculation rules, negative-field rules, PaymentAmount logic, tolerance amount)
- The **field type map** from Step 2 of xml-generate-samples: which fields are user-input (yellow/gross/employees) and which are calculated (white/tax/penalty/interest/total)
- The **on-time screenshot** base values (2070 Q1, penalty/interest = 0.00)
- The **late screenshot** base values (2019 Q1, penalty/interest populated)
- The **output folder path** where files were written

**If running standalone** (not invoked from xml-generate-samples): before asking the user for anything, check whether `{output_folder}\_ticket\REQUIREMENTS.md` exists and read it. That file contains the ticket text, field type map, base values, and calculation rules — use it as your source of truth. You only need to ask the user for missing information that isn't documented there.

**Key rule to apply throughout all checks**: User-input fields (gross, employees) must never change between variants — only calculated fields (tax, penalty, interest, total) are shifted in tolerance tests. Negated fields in rejection tests are always user-input fields.

---

## Validation Steps

### 1 — File Inventory Check

Read the output folder. Confirm the expected files are present based on the form's field structure:

**Required categories:**
- Accepted: 5 Dollars Extra — Taxes, Penalties, Interests (3 files)
- Accepted: 5 Dollars Short — Taxes, Penalties, Interests (3 files)
- Accepted: Exact Filings — Penalties Are 25 Minimum, Penalties Greater Than 25 Minimum (2 files)
- Accepted: Zero Gross Filings (1 file)
- Rejected: 501 Cents Extra — Taxes, Penalties, Interests (3 files)
- Rejected: 501 Cents Short — Taxes, Penalties, Interests (3 files)
- Rejected: one file per negative field (count from ticket)
- Rejected: one file per calculation-validation rule (count from ticket — look for "Field A = expression" rules; these appear as `Rejected - {FieldTag} Is Incorrect.xml`)
- Penalty Min/Max Tests (5 files — only if ticket defines a penalty minimum and maximum):
  - Accepted: {PenaltyTag} Honors Minimum, Between Min and Max, Honors Maximum (3 files)
  - Rejected: {PenaltyTag} Below Minimum, Above Maximum (2 files)
- Rejected: Total Is Incorrect (1 file)
- Rejected: PaymentAmount Is Incorrect (1 file)
- Submit: 1 file — two-body (`On Time, P&I Paid`) if ticket has no P&I Not Paid flow, three-body (`On Time, P&I Not Paid, P&I Paid`) if it does. Check `_ticket\REQUIREMENTS.md` Submit Scenario section to determine which applies.

Report any missing files immediately as a **BLOCKER**.

---

### 2 — Exact Filing Validation

Open the two Exact Filings files. For each `<FilingBody>`:

**LATE body (TaxYear 2019, TaxQuarter 1):**
- Every field value must match the **late screenshot** exactly
- Penalty and interest fields must be populated (non-zero)
- Total field must equal the sum of all tax + penalty + interest fields — **verify this arithmetic explicitly**: e.g., if NetTax=20.21, Penalty=25.00, then TotalAmountDue must be 45.21, NOT 20.21. A total that equals only the NetTax value and excludes Penalty is a common generation error — flag it as a BLOCKER.
- No inline comments expected on these fields (values are exact)

**ON TIME body (TaxYear 2070, TaxQuarter 1):**
- Gross and employee fields must match the **on-time screenshot**
- Penalty and interest fields must be `0.00`
- Total field must equal the sum of tax fields only
- No inline comments expected

**PaymentAmount** must equal the sum of all `TotalAmountDue` values across both bodies in the file.

Flag any mismatch as a **BLOCKER**.

---

### 2.5 — Penalty Min/Max Validation

Skip this step if the ticket defines no penalty minimum or maximum.

For all five penalty min/max files, verify the single LATE `<FilingBody>` only (no on-time body expected):

**Accepted — Honors Minimum:**
- Penalty = minimum value (e.g., $25.00), NOT the calculated rate × NetTax
- NetTax must be low enough that rate × NetTax < minimum
- TotalAmountDue = NetTax + minimum penalty ✓
- PaymentAmount = TotalAmountDue ✓
- Inline comment on `<Penalty>` explaining scenario (e.g., `calculated = 5.05, below $25.00 minimum`)

**Accepted — Between Min and Max:**
- Penalty = exact calculated value; confirm `min < Penalty < max_rate × NetTax`
- TotalAmountDue = NetTax + Penalty ✓
- No inline comment needed (value is exact)

**Accepted — Honors Maximum:**
- Penalty = max_rate × NetTax (the cap); confirm rate × NetTax would exceed this cap
- TotalAmountDue = NetTax + capped penalty ✓
- Inline comment on `<Penalty>` explaining max cap applied

**Rejected — Below Minimum:**
- Same NetTax as Honors Minimum file
- Penalty = calculated value (below minimum) — must NOT equal the minimum
- TotalAmountDue = NetTax + below-min penalty ✓
- Inline comment on `<Penalty>` explaining it is below the minimum

**Rejected — Above Maximum:**
- Same NetTax as Honors Maximum file
- Penalty = (max cap) + tolerance + 1.00 — must exceed the ceiling
- TotalAmountDue = NetTax + above-max penalty ✓
- Inline comment on `<Penalty>` explaining it exceeds the maximum

Flag any arithmetic mismatch as a **BLOCKER**. Flag missing inline comments as an **ISSUE**.

---

### 3 — Tolerance Variant Validation

For each Accepted ($5.00) and Rejected ($5.01) tolerance file, verify:

**Tax variants** — only calculated tax fields shift; user-input fields never change:
- Each tax field differs from the exact value by exactly ±tolerance or ±(tolerance+0.01)
- Gross and employees fields are **identical** to base exact values — flag any change as a BLOCKER
- Total and PaymentAmount reflect the combined shift across all tax fields (e.g., 2 tax fields → total shifts by ±2×tolerance)
- Penalty and interest fields are unchanged from the base exact values
- Inline comments are present on each shifted field and on total/PaymentAmount

**Penalty variants** — **single LATE `<FilingBody>` only** (no on-time body):
- Each penalty field differs from the base late value by exactly ±tolerance or ±(tolerance+0.01)
- Tax, interest, gross, and employees fields are all **unchanged** from base late values
- TotalAmountDue and PaymentAmount reflect the shift
- Flag any on-time body present as a **BLOCKER** — these files must be single-body

**Interest variants** — **single LATE `<FilingBody>` only** (no on-time body):
- Each interest field differs from the base late value by exactly ±tolerance or ±(tolerance+0.01)
- Tax, penalty, gross, and employees fields are all **unchanged** from base late values
- TotalAmountDue and PaymentAmount reflect the shift
- Flag any on-time body present as a **BLOCKER** — these files must be single-body

**On-time body tax fields in tax variants**: should be shifted by the same amount as the late body tax fields. On-time total and the combined PaymentAmount must be consistent with this.

Flag each arithmetic error or missing comment as an **ISSUE**. Flag any shifted user-input field (gross/employees) as a **BLOCKER**.

---

### 4 — Zero Gross Validation

All fields must be `0.00`. Employee count must be `0`. PaymentAmount must be `0.00`. Both bodies must be zeroed out.

---

### 5 — Negative Field Rejection Validation

For each "Is Negative" file:
- Only the targeted field should be negative; all other fields must hold base values
- Late body uses base late values (with one field negated)
- On-time body uses base on-time values (with the same field negated)
- PaymentAmount should still reflect the base total (the file tests the negative field, not the payment)

Verify one file exists per field listed in the ticket as disallowing negatives. Cross-reference the ticket's negative-field list.

---

### 5.5 — Calculation Validation Rejection Files

Read `_ticket\REQUIREMENTS.md` for the **Calculation-Validation Rejection Rules** section. If that section is absent, scan the ticket for rules of the form "Field A = expression involving other fields" to build the list.

For each rule, verify the corresponding `Rejected - {FieldTag} Is Incorrect.xml` file exists. Flag any missing file as a **BLOCKER**.

For each file that exists, open it and verify:
- The targeted field (and its Total-section counterpart) is set to an incorrect value (`base + 1.00` or `1.00` for total/subtotal fields)
- All other fields hold their correct base values (late body = late screenshot values, on-time body = on-time screenshot values)
- Every wrong field has a `<!-- DELIBERATELY INCORRECT: ... -->` comment explaining the expected formula
- PaymentAmount = sum of TotalAmountDue across both bodies:
  - For base+1.00 files: `(late TotalAmountDue) + (on-time TotalAmountDue)` using correct base values (the error is upstream, not in TotalAmountDue itself unless the rule targets SubTotalAmountDue)
  - For SubTotalAmountDue Is Incorrect: TotalAmountDue = `1.00` on both bodies → PaymentAmount = `2.00`

Flag any arithmetic mismatch or missing comment as a **BLOCKER**.

---

### 6 — Rejected Total / PaymentAmount Validation

**Total Is Incorrect file:**
- All fields correct; total field set to `1.00` on each body
- PaymentAmount = `2.00` (sum of the two fake totals)

**PaymentAmount Is Incorrect file:**
- All fields correct; totals match the base late + on-time values
- PaymentAmount = `1.00` (deliberately wrong)

---

### 7 — Submit Scenario Validation

Check `_ticket\REQUIREMENTS.md` for the Submit Scenario section to confirm whether the file is two-body (On Time + P&I Paid) or three-body (On Time + P&I Not Paid + P&I Paid). Flag an unexpected body count as a **BLOCKER**.

All gross, tax, and employee fields must be non-zero across all bodies — flag any `0.00` on a gross, tax, or employee field as a **BLOCKER** (these fields must have realistic values to trigger the correct SKU transaction on the business).

**On Time body (TaxYear 2070, TaxQuarter 1):**
- Gross/tax/employee fields match the on-time screenshot values (non-zero)
- Penalty and interest fields = `0.00`
- TotalAmountDue = NetTax only

**P&I Not Paid body** *(three-body files only — skip if not present)* **(TaxYear 2019, TaxQuarter 1):**
- Gross/tax/employee fields match the late screenshot values (non-zero)
- Penalty and interest fields must be `0.00` — flag any non-zero penalty/interest here as a **BLOCKER**
- TotalAmountDue = NetTax only
- PaymentAmount contribution = NetTax only

**P&I Paid body (TaxYear 2019 Q2 for three-body; TaxYear 2017 Q3 for two-body):**
- Gross/tax/employee fields match the late screenshot values (non-zero)
- Penalty and interest fields populated with the calculated late values (non-zero)
- TotalAmountDue = NetTax + Penalty (+ Interest if applicable)
- PaymentAmount contribution = TotalAmountDue (full payment)

**PaymentAmount** = sum of all bodies' TotalAmountDue contributions.

---

### 8 — Structure and Header Validation

Spot-check 3–4 files for:
- Correct XML declaration and `<Transmission>` namespace attributes
- `TransmissionId` is unique per file and follows `000000000{NNN}aaaaaaaaD` format
- `SubmissionId` is `8082552480002feb2421`
- `ETIN`, `TINTypeValue`, `BusinessNameLine1`, and `IdentificationNumber` match the values recorded in `_ticket\REQUIREMENTS.md` — **do not check against any hardcoded values here**; use whatever was documented for this specific form and filer
- Form element tag matches the tag from the ticket exactly (case-sensitive)

---

## Reporting

### If all checks pass:

```
✅ VALIDATION PASSED — Ready to Test

Output folder: {REPOS_PARENT}\qa-command-center\.claude\XML Samples\{ClientName}\{FormName}\
Files validated: {N}

All files confirmed correct against ticket requirements and screenshots.
Upload these files to the XML testing tool on the target test tenant to proceed.
```

### If issues are found:

Categorize findings as:

**BLOCKERS** — must be fixed before testing (wrong values, missing files, PaymentAmount arithmetic errors)
**ISSUES** — likely to cause test confusion (missing inline comments, wrong field zeroed in negative test)

Format the report as:

```
❌ VALIDATION FAILED — Issues Found

BLOCKERS:
1. [FileName] — [description of problem, expected vs actual values]
2. ...

ISSUES:
1. [FileName] — [description]
2. ...
```

**If invoked from xml-generate-samples**: pass the full report back and state "Returning findings to xml-generate-samples. Please correct the above and re-run validation."

**If running standalone**: fix every BLOCKER and ISSUE directly by editing the affected files, then re-run validation. Do not ask the user to fix items you can correct yourself. Continue the fix → re-validate loop until a clean pass is achieved.

Do not declare the library ready until a clean validation pass is achieved.
