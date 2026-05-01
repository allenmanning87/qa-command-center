# Generate XML Test Sample Files

## Pre-flight — Read configuration

Before doing anything else, read the `.env` file at the repo root using the `Read` tool and extract:

- `REPOS_PARENT` (default: `C:\Git-Repositories`) → used to construct the XML Samples output path: `{REPOS_PARENT}\qa-command-center\.claude\XML Samples\`

---

You are building a complete library of XML test sample files for a new multi-tenant Business Center bulk filing form. This skill works for any client — the form element names, field tags, rates, and validation rules are all derived from the ticket and screenshots you provide.

---

## Quarter Due Date Reference

Use these when constructing TaxYear/TaxQuarter combinations:

| Quarter | Period | Due Date |
|---------|--------|----------|
| Q1 | Jan 1 – Mar 31 | Apr 30 |
| Q2 | Apr 1 – Jun 30 | Jul 31 |
| Q3 | Jul 1 – Sep 30 | Oct 31 |
| Q4 | Oct 1 – Dec 31 | Jan 31 |

**Standard years used in test files:**
- **Late filing**: TaxYear `2019`, TaxQuarter `1` (due 2019-04-30, filed years later)
- **On-time filing**: TaxYear `2070`, TaxQuarter `1` (due date far in the future)
- **Submit P&I Paid**: TaxYear `2017`, TaxQuarter `3`
- **Submit P&I Not Paid**: TaxYear `2017`, TaxQuarter `2`

---

## Step 1 — Gather Inputs

Ask the user for ALL of the following before doing any work. Items 1–6 are always required. Item 7 is conditional — ask for it only if the ticket does not explicitly state the withholding rate(s), penalty rate, and interest rate.

**1. JIRA ticket**
The ticket number or text. This reveals:
- The XML form element tag (e.g., `WaltonTIFQuarterlyWithholding`)
- All XML field tag names and their roles
- Which fields cannot be negative (and their validation error messages)
- Calculation rules and rates for each tax/penalty/interest field (if provided)
- Total field formula and PaymentAmount validation logic (P&I Paid vs Not Paid)

Do **not** read the PR diff. The PR is what is being tested — derive all field names, calculation rules, and logic exclusively from the ticket text and the screenshots. Using the PR would build test files to match the PR's implementation, including any bugs in it.

**After reading the ticket:** If the ticket does not explicitly list the withholding rate(s), penalty rate, and interest rate, you must collect item 7 before proceeding.

**2. Screenshot — On-Time Form**
A screenshot of the rendered form filled out and calculated with a due date of **2070-04-30** (Q1 on-time scenario). Read the exact field values from this screenshot — penalty and interest should be `0.00`.

> **Save to disk first — do not attach to chat.** Claude cannot save screenshots from chat. Save the screenshot anywhere (e.g., Desktop), then provide the full file path (e.g., `C:\Users\allen\Desktop\screenshot-ontime.png`). Claude will move it into `_ticket\` automatically.

**3. Screenshot — Late Form**
A screenshot of the rendered form filled out and calculated with a due date of **2019-04-30** (Q1 late scenario). Read the exact field values from this screenshot — penalty and interest will be populated.

> **Save to disk first — do not attach to chat.** Save the screenshot anywhere and provide the full file path. Claude will move it into `_ticket\` automatically.

**4. Filer identity — the business being filed for**
The FEIN or SSN and the business name of the taxpayer whose returns are in this transmission. These go in `<TINTypeValue>` and `<BusinessNameLine1>`. Ask: *"What is the FEIN/SSN and business name for the business being filed for?"*

**5. Transmitter identity — the business doing the bulk filing**
The FEIN or SSN of the software provider or payroll company submitting the transmission on behalf of the filer. This goes in `<Transmitter><ETIN>`. Ask: *"What is the FEIN/SSN of the transmitter (the entity doing the bulk filing)?"*

**6. Client folder name**
A short, filesystem-safe name for the client (e.g., `cityoftownky`, `examplecounty`). This becomes the parent folder so all of a client's forms stay nested together. Ask: *"What client folder name should I use for organizing these files?"*

**7. (Conditional) Rate table screenshot**
*Ask only if the ticket does not specify withholding rate(s), penalty rate, and interest rate.*
A screenshot of the database rate table showing the `form_id`, `rate_name`, and `value` columns for this form. Ask: *"The ticket doesn't include the calculation rates. Can you save a screenshot of the rate table (e.g., from an admin DB query filtering on this form's ID) to disk and provide the full file path? Claude will move it into `_ticket\` automatically."*

Do not proceed until you have items 1–6 plus item 7 if rates were missing from the ticket.

---

## Step 2 — Extract and Confirm Base Values

From the **ticket**, extract:
- The XML form element tag
- Every XML field tag, classified by type:
  - **User-input fields** (highlighted yellow on the form): gross earnings fields, employees count — these are entered by the filer and are never recalculated by the system
  - **Calculated fields** (white on the form): tax fields, penalty fields, interest fields, total field — these are computed by the system from the user-input values and the rules in the ticket

This distinction matters for every variant: tolerance shifts apply only to calculated fields; negative-field rejections apply only to user-input fields.

From the **two screenshots**, read the exact dollar values for every field. Build a confirmation table:

| XML Tag | Field Type | On-Time Value | Late Value |
|---------|-----------|--------------|------------|
| (each field) | user-input / calculated | | |

Also note:
- PaymentAmount for P&I Paid = late total field value
- PaymentAmount for P&I Not Paid = sum of late **tax fields only** (not penalty or interest)

**CRITICAL — TotalAmountDue ≠ NetTax**: The total field is `NetTax + Penalty + Interest` (all calculated fields summed). Do NOT copy the NetTax value into TotalAmountDue. Read TotalAmountDue directly from the screenshot — it will differ from NetTax whenever penalty or interest is non-zero. For late filings: TotalAmountDue = NetTax + Penalty (+ Interest if applicable). For on-time filings with no penalty/interest: TotalAmountDue = NetTax.

Present this table to the user and ask them to confirm before writing any files.

---

## Step 3 — Determine Variant Values

From the confirmed base values, compute all variants. Round all monetary values to 2 decimal places (standard half-up).

**The tolerance amount comes from the ticket** (e.g., "$5 tolerance", "$1 tolerance"). Use whatever the ticket specifies — the examples below use $5.00/$5.01 but substitute the correct amounts.

**Calculated fields only are shifted in tolerance variants. User-input fields (gross, employees) never change.**

| Variant | What Changes |
|---------|-------------|
| +$tolerance taxes | Add tolerance to each tax field; adjust total and PaymentAmount by (tolerance × count of tax fields). Gross and employees unchanged. |
| -$tolerance taxes | Subtract tolerance from each tax field; adjust total and PaymentAmount. |
| +$tolerance penalties | Add tolerance to each penalty field; adjust total and PaymentAmount. Tax, interest, gross, employees unchanged. |
| -$tolerance penalties | Subtract tolerance from each penalty field. |
| +$tolerance interests | Add tolerance to each interest field; adjust total and PaymentAmount. |
| -$tolerance interests | Subtract tolerance from each interest field. |
| +$(tolerance+0.01) taxes | Same fields as tax variant but one cent over tolerance — this is the rejection threshold |
| -$(tolerance+0.01) taxes | Same |
| +$(tolerance+0.01) penalties | Same for penalty fields |
| -$(tolerance+0.01) penalties | Same |
| +$(tolerance+0.01) interests | Same for interest fields |
| -$(tolerance+0.01) interests | Same |

**Tax tolerance variants** have TWO FilingBodies (LATE + ON TIME). Shift the same tax fields in both bodies. On-time body penalty/interest stay `0.00`.

**Penalty and interest tolerance variants** have a **single LATE FilingBody only** — no on-time body. On-time penalty/interest is always `0.00` and is already covered by the exact filing tests. Including an on-time body in these files would just duplicate work that's already validated elsewhere.

**Zero gross variant**: All fields = `0.00`, employees = `0`. Both bodies zeroed.

**Large gross variant** (for "Penalties Greater Than 25 Minimum"): Multiply the late-form gross value(s) by 10. Recalculate all calculated fields (tax, penalty, interest, total) using the same rates from the ticket. Penalty must exceed $25. User-input fields (gross, employees) reflect the multiplied gross. On-time body uses the base (non-multiplied) values. If the base gross already produces penalty > $25, use the base for both penalty-scenario files and note this to the user.

**Penalty minimum/maximum variants**: If the ticket defines both a minimum and maximum for a penalty field, generate 5 additional files. Use the penalty field's exact XML tag name in the file name (e.g., `<Penalty>` → `Penalty`). Each file has a **single LATE `<FilingBody>` only** — penalty is irrelevant on on-time filings. PaymentAmount = that body's TotalAmountDue.

First, derive two driving NetTax values. Set GrossEarningsUnionPromenade=0 to keep the math clean:
- **Below-min NetTax**: NetTax where `rate × NetTax = min − tolerance − 1.00` (calculated penalty sits $1 below the accepted tolerance floor). Solve: `NetTax = (min − tolerance − 1.00) / rate`.
- **Above-max NetTax**: NetTax where calculated penalty at the standard rate would exceed `max_rate × NetTax + tolerance + 1.00` — i.e., a gross large enough that even the capped (max) penalty is clearly beyond the acceptance range.

| File | NetTax used | Penalty submitted | Expected outcome |
|------|-------------|-------------------|-----------------|
| `Accepted - {PenaltyTag} - Honors Minimum.xml` | below-min NetTax | minimum (e.g., $25.00) | Accept — honors the floor |
| `Accepted - {PenaltyTag} - Between Min and Max.xml` | between thresholds | exact calculated value | Accept — in valid range |
| `Accepted - {PenaltyTag} - Honors Maximum.xml` | above-max NetTax | maximum cap (max_rate × NetTax) | Accept — honors the ceiling |
| `Rejected - {PenaltyTag} - Below Minimum.xml` | same below-min NetTax | calculated value (below min) | Reject — under the floor |
| `Rejected - {PenaltyTag} - Above Maximum.xml` | same above-max NetTax | max cap + tolerance + 1.00 | Reject — over the ceiling |

TotalAmountDue = NetTax + submitted Penalty. Add an inline comment on the `<Penalty>` line explaining the scenario (e.g., `<!-- calculated 10% = 5.05, below $25.00 minimum -->`). Add a matching comment on `<TotalAmountDue>`.

Show the user a summary of all variant values and confirm before writing.

---

## Step 3.5 — Write Ticket Documentation

Before writing any XML files, create a `_ticket\` subdirectory inside the output folder and write `REQUIREMENTS.md` there:

```
{REPOS_PARENT}\qa-command-center\.claude\XML Samples\{ClientName}\{FormName}\_ticket\REQUIREMENTS.md
```

This file is the single source of truth for both `xml-generate-samples` and `xml-validate-samples`. Write it using the following template:

```markdown
# {FormName} — Ticket Requirements

## Ticket
**JIRA:** {ticket_url_or_id}

## Ticket Summary
{paste full ticket text here, or a faithful condensed version covering all rules}

## Form Element Tag
`{XmlFormTag}`

## Field Type Map

| XML Tag | Field Type | On-Time Value | Late Value |
|---------|-----------|--------------|------------|
| {each field} | user-input / calculated | {value} | {value} |

**User-input fields** (yellow on form — never shifted in tolerance tests, negated in rejection tests):
- {list}

**Calculated fields** (white on form — shifted in tolerance tests, never negated):
- {list}

## Calculation Rules
- {rate and formula for each calculated field}
- TotalAmountDue = {formula — must explicitly state which fields are summed}
- Penalty minimum: ${X}
- Penalty maximum: {X}% of tax due
- Tolerance: $5.00 accepted, $5.01 rejected

## PaymentAmount Logic
- P&I Paid: PaymentAmount = TotalAmountDue (full payment including penalty/interest)
- P&I Not Paid: PaymentAmount = sum of tax fields only (excluding penalty/interest)

## Negative-Field Rules
Fields that reject negative values (one rejection file per field):
- {list each field tag and its validation error message from the ticket}

## Screenshots

### Late Form (2019 Q1 — due 2019-04-30, filed late)
Screenshot: `_ticket\screenshot-late.png` (if saved here) or description:
- {field}: {value}
- {field}: {value}
- ...

### On-Time Form (2070 Q1 — due 2070-04-30, on time)
Screenshot: `_ticket\screenshot-ontime.png` (if saved here) or description:
- {field}: {value}
- {field}: {value}
- ...
```

After creating `_ticket\`, move the screenshot files the user provided into it using Bash:

```bash
mv "{path_user_provided_for_late_screenshot}" "{REPOS_PARENT}\qa-command-center\.claude\XML Samples\{ClientName}\{FormName}\_ticket\screenshot-late.png"
mv "{path_user_provided_for_ontime_screenshot}" "{REPOS_PARENT}\qa-command-center\.claude\XML Samples\{ClientName}\{FormName}\_ticket\screenshot-ontime.png"
```

If a rate table screenshot was also provided (item 7), move it too:

```bash
mv "{path_user_provided_for_rate_table}" "{REPOS_PARENT}\qa-command-center\.claude\XML Samples\{ClientName}\{FormName}\_ticket\screenshot-rates.png"
```

Update the `## Screenshots` section of `REQUIREMENTS.md` to reference the final paths (e.g., `_ticket\screenshot-late.png`) once the move is confirmed.

---

## Step 4 — Write All Files

Save all XML files to:
```
{REPOS_PARENT}\qa-command-center\.claude\XML Samples\{ClientName}\{FormName}\
```

The `_ticket\` subdirectory was already created in Step 3.5. Do not put XML test files inside `_ticket\`.

Report the exact final path to the user when done.

### File List (standard ~22 files; adjust count based on number of negative-field rejections)

**Accepted — Tolerance Tests — Taxes** (TWO `<FilingBody>` elements: LATE 2019 Q1 + ON TIME 2070 Q1)
1. `{FormName} - Accepted - 5 Dollars Extra - Taxes.xml`
2. `{FormName} - Accepted - 5 Dollars Short - Taxes.xml`

**Accepted — Tolerance Tests — Penalties/Interests** (ONE `<FilingBody>` — LATE 2019 Q1 only)
3. `{FormName} - Accepted - 5 Dollars Extra - Penalties.xml`
4. `{FormName} - Accepted - 5 Dollars Extra - Interests.xml`
5. `{FormName} - Accepted - 5 Dollars Short - Penalties.xml`
6. `{FormName} - Accepted - 5 Dollars Short - Interests.xml`

**Accepted — Exact Filings** (each has TWO `<FilingBody>` elements: LATE + ON TIME)
7. `{FormName} - Accepted - Exact Filings - Penalties Are 25 Minimum.xml` — base late values (penalty = $25.00)
8. `{FormName} - Accepted - Exact Filings - Penalties Greater Than 25 Minimum.xml` — large gross late values + base on-time values

**Accepted — Zero Gross** (TWO `<FilingBody>` elements)
9. `{FormName} - Accepted - Zero Gross Filings.xml`

**Rejected — Tolerance Tests — Taxes** (TWO `<FilingBody>` elements: LATE + ON TIME)
10. `{FormName} - Rejected - 501 Cents Extra - Taxes.xml`
11. `{FormName} - Rejected - 501 Cents Short - Taxes.xml`

**Rejected — Tolerance Tests — Penalties/Interests** (ONE `<FilingBody>` — LATE 2019 Q1 only)
12. `{FormName} - Rejected - 501 Cents Extra - Penalties.xml`
13. `{FormName} - Rejected - 501 Cents Extra - Interests.xml`
14. `{FormName} - Rejected - 501 Cents Short - Penalties.xml`
15. `{FormName} - Rejected - 501 Cents Short - Interests.xml`

**Rejected — Negative Fields** (one file per field that rejects negatives; TWO `<FilingBody>` elements each)
16+. `{FormName} - Rejected - {FieldXmlTag} Is Negative.xml` — negate only that one field; all other fields use base late values (on-time body uses base on-time values). Generate one file per gross field AND one for the employees field.

**Penalty Minimum/Maximum Tests** (ONE `<FilingBody>` each — LATE only; omit entirely if ticket defines no penalty min/max)
N+1. `{FormName} - Accepted - {PenaltyTag} - Honors Minimum.xml`
N+2. `{FormName} - Accepted - {PenaltyTag} - Between Min and Max.xml`
N+3. `{FormName} - Accepted - {PenaltyTag} - Honors Maximum.xml`
N+4. `{FormName} - Rejected - {PenaltyTag} - Below Minimum.xml`
N+5. `{FormName} - Rejected - {PenaltyTag} - Above Maximum.xml`

**Rejected — Calculation Validation** (TWO `<FilingBody>` elements each — LATE + ON TIME)

Scan the ticket for every rule of the form "Field A must equal expression involving other fields." Generate one rejection file per rule. These are distinct from tolerance tests — they test the system's cross-field validation, not payment tolerance windows.

For each rule, identify the field being validated (`{FieldTag}`) and set it to **`1.00`** per jurisdiction. Do not use `base_value + 1.00` — small offsets may fall within the system's tolerance window and be accepted. The Total section field that sums this tag must reflect the sum of the wrong values (e.g., two jurisdictions at 1.00 each → Total = 2.00). Leave all other fields at their correct base values. Add `<!-- DELIBERATELY INCORRECT: should equal {formula} -->` on every wrong field.

Common patterns to look for in tickets:
- "SubjectEarnings = TotalEarnings − ExcludedEarnings" → `Rejected - SubjectEarnings Is Incorrect.xml`
- "WithholdingRate = SubjectEarnings × rate" → `Rejected - WithholdingRate Is Incorrect.xml`
- "FeeDue = WithholdingRate" → `Rejected - FeeDue Is Incorrect.xml`
- "SubTotalAmountDue = FeeDue + Penalty + Interest" → `Rejected - SubTotalAmountDue Is Incorrect.xml`
  - For this case, set SubTotalAmountDue = `1.00` AND TotalAmountDue = `1.00` (since TotalAmountDue follows SubTotalAmountDue); PaymentAmount = `2.00`

The `{TotalFieldTag} Is Incorrect` file below covers the TotalAmountDue = SubTotalAmountDue rule specifically (TotalAmountDue wrong, SubTotalAmountDue correct).

N+1 through N+{count}. `{FormName} - Rejected - {FieldTag} Is Incorrect.xml` (one per calculation rule, in field order from the ticket)

**Rejected — Invalid Totals** (TWO `<FilingBody>` elements)
N+{next}. `{FormName} - Rejected - {TotalFieldTag} Is Incorrect.xml` — all fields correct; set total = `1.00` on each body; set PaymentAmount = `2.00`
N+{next}. `{FormName} - Rejected - PaymentAmount Is Incorrect.xml` — all fields correct; set PaymentAmount = `1.00`

**Submit — P&I Scenarios**

First, check the ticket for whether a "P&I remainder" or "balance due" flow is defined — i.e., a scenario where the filer submits the tax-only portion now and pays penalty/interest separately later. If the ticket does NOT describe this flow, omit the P&I Not Paid body.

- **Ticket defines P&I Not Paid flow** → ONE file, THREE `<FilingBody>` elements: name `{FormName} - Submit - On Time, P&I Not Paid, P&I Paid.xml`
- **Ticket does NOT define P&I Not Paid flow** → ONE file, TWO `<FilingBody>` elements: name `{FormName} - Submit - On Time, P&I Paid.xml`

Use the **screenshot values** for all gross, tax, and employee fields across all bodies — every field must have a realistic non-zero value so that the correct SKU transaction is triggered on the business.

  - **On Time body** (TaxYear 2070, TaxQuarter 1): All gross/tax/employee fields populated from on-time screenshot; Penalty = `0.00`; TotalAmountDue = NetTax; PaymentAmount contribution = NetTax
  - **P&I Not Paid body** *(only if ticket defines this flow)* (TaxYear 2019, TaxQuarter 1): All gross/tax/employee fields populated from late screenshot; Penalty and interest fields set to `0.00`; TotalAmountDue = NetTax; PaymentAmount contribution = NetTax only
  - **P&I Paid body** (TaxYear 2019, TaxQuarter 2 if three-body; TaxYear 2017, TaxQuarter 3 if two-body): All gross/tax/employee fields populated from late screenshot; Penalty and interest fields populated with calculated late values; TotalAmountDue = NetTax + Penalty (+ Interest); PaymentAmount contribution = TotalAmountDue
  - PaymentAmount = sum of all bodies' contributions

---

## XML Structure Template

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Transmission xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="BCPYBulkFilingTransmission.xsd" transmissionVersion="BCPYV100">
    <TransmissionHeader>
        <TransmissionId>000000000{NNN}aaaaaaaaD</TransmissionId>
        <Transmitter>
            <ETIN>{TRANSMITTER_ETIN}</ETIN>
        </Transmitter>
    </TransmissionHeader>
    <Return>
        <ReturnHeader>
            <SubmissionId>8082552480002feb2421</SubmissionId>
            <Filer>
                <TIN>
                    <TINType>FEIN</TINType>
                    <TINTypeValue>{FILER_TIN}</TINTypeValue>
                </TIN>
                <Name>
                    <BusinessNameLine1>{FILER_BUSINESS_NAME}</BusinessNameLine1>
                </Name>
            </Filer>
            <FinancialTransaction>
                <ACHCredit>
                    <PaymentAmount>{SUM_OF_ALL_TOTAL_FIELDS_IN_THIS_FILE}</PaymentAmount>
                    <IdentificationNumber>12345678</IdentificationNumber>
                </ACHCredit>
            </FinancialTransaction>
        </ReturnHeader>
        <ReturnData>
            {FILING_BODIES}
        </ReturnData>
    </Return>
</Transmission>
```

**TransmissionId**: Start at `100` and increment by `1` per file.

**Two-body filing structure** (tolerance/exact/rejection tests):
```xml
<FilingBody>
<!-- LATE -->
    <TaxYear>2019</TaxYear>
    <{FormTag}>
        <TaxQuarter>1</TaxQuarter>
        {LATE_FIELD_VALUES}
    </{FormTag}>
</FilingBody>
<FilingBody>
<!-- ON TIME -->
    <TaxYear>2070</TaxYear>
    <{FormTag}>
        <TaxQuarter>1</TaxQuarter>
        {ONTIME_FIELD_VALUES_PENALTIES_AND_INTEREST_ARE_ZERO}
    </{FormTag}>
</FilingBody>
```

**One-body Submit structure**:
```xml
<FilingBody>
<!--P&I PAID, DECREASE BY ONE TaxQuarter-->
    <TaxYear>2017</TaxYear>
    <{FormTag}>
        <TaxQuarter>3</TaxQuarter>
        {FIELDS}
    </{FormTag}>
</FilingBody>
```
(Use TaxQuarter `2` and comment `<!--P&I NOT PAID, DECREASE BY ONE TaxQuarter-->` for the Not Paid file.)

**Inline comments** — add on any field deliberately shifted from its exact value:
- `<!-- ADD 5.00 TO REAL VALUE -->`
- `<!-- SUBTRACT 5.00 TO REAL VALUE -->`
- `<!-- ADD 5.01 TO REAL VALUE -->`
- `<!-- SUBTRACT 5.01 TO REAL VALUE -->`
- `<!-- ADD {X} TO REAL VALUE -->` when total/PaymentAmount reflects multiple shifted fields

---

## Final Report + Validation Handoff

After writing all files, tell the user:
1. The exact output path: `{REPOS_PARENT}\qa-command-center\.claude\XML Samples\{ClientName}\{FormName}\`
2. Total number of files written
3. A numbered list of all file names
4. Any judgment calls made (e.g., skipping large-gross variant, non-standard field structure)

Then immediately invoke the `/xml-validate-samples` skill, passing it:
- The ticket requirements
- The on-time screenshot base values (extracted in Step 2)
- The late screenshot base values (extracted in Step 2)
- The output folder path

**Feedback loop**: If `xml-validate-samples` returns BLOCKERs or ISSUEs, address every item it reports, rewrite the affected files, then re-invoke `xml-validate-samples`. Repeat until a clean pass is achieved. Do not report the library as ready to the user until validation passes.
