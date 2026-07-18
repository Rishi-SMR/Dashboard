# 06 — Business Associate Agreement (BAA) Tracker

**System:** SMR Cashflow Dashboard · **Effective:** 2026-07-18
**Authority:** §164.308(b)(1), §164.502(e), §164.504(e)

A covered entity may not disclose PHI to a vendor that creates, receives,
maintains or transmits it on the entity's behalf without a signed BAA. **This is
the largest open gap in SMR's compliance posture** (risk R-12) — the technical
safeguards are in place; the contracts are not.

Owner: Security Officer. Verify pricing and plan requirements directly with each
vendor before purchasing — plan tiers change.

---

## Status summary

| Vendor | Role | Receives PHI? | BAA | Priority |
|---|---|---|---|---|
| **Supabase** | Postgres — cache, config, audit logs | **Yes** (pseudonymised) | ❌ **Not signed** | **1 — critical** |
| **Vercel** | Hosting + serverless functions | **Yes, in transit** | ❌ **Not signed** | **2 — critical** |
| **Striven** | ERP — system of record | **Yes, in full** (names) | ❌ **Not signed** | **3 — critical** |
| Intuit (QuickBooks Online) | Accounting | Designed to receive none | ⚠️ Intuit will not sign | 4 — see below |
| Hostinger | DNS for cfovaani.in | No — DNS only | Not required | — |
| GitHub | Source code | No — no PHI in the repo | Not required | — |

---

## 1. Supabase — highest priority

**Why it needs one:** Supabase stores order, invoice and payment history keyed to
`PT-` references, plus the audit logs. Because SMR holds the re-identification
key in Striven, this is PHI.

**What Supabase requires (verify current terms):**
- At least the **Team plan** — BAAs are not offered on Free or Pro.
- Plus the **HIPAA add-on** enabled on the organisation.
- Projects handling PHI must then be marked **High Compliance**, which enables
  additional configuration checks.

**Steps:**
1. Upgrade the "Dashboard" organisation to Team.
2. Enable the HIPAA add-on (Organisation → Settings → Add-ons / Compliance).
3. Request and sign the BAA from the dashboard.
4. Mark project `ldkeeiefpsrncfxmgyhr` as a High Compliance project and resolve
   any checks it flags.
5. Save the executed PDF in §5 and file the date below.

**Reference:** [Supabase HIPAA compliance docs](https://supabase.com/docs/guides/security/hipaa-compliance) ·
[HIPAA projects](https://supabase.com/docs/guides/platform/hipaa-projects)

## 2. Vercel

**Why it needs one:** every API request carrying patient-derived data passes
through Vercel's serverless functions. Transmission alone makes them a Business
Associate — they need not store anything.

**Good news, and a correction to earlier guidance:** a BAA no longer requires
Enterprise. Vercel makes HIPAA BAAs available to **Pro** teams through a HIPAA
add-on purchasable in Settings → Billing; Enterprise customers go through their
account manager. The BAA covers Vercel's global infrastructure. (Secure Compute,
recommended for the most sensitive workloads, remains Enterprise-only — likely
unnecessary here, but confirm with them.)

**Steps:**
1. Confirm the `rishi-smr` team is on Pro (or upgrade from Hobby).
2. Settings → Billing → purchase the HIPAA add-on; execute the BAA.
3. Confirm which regions/features the BAA covers for the `dashboard` project.
4. File the executed agreement in §5.

**Reference:** [HIPAA BAAs for Pro teams](https://vercel.com/changelog/hipaa-baas-are-now-available-to-pro-teams) ·
[HIPAA compliance guide](https://vercel.com/kb/guide/hipaa-compliance-guide-vercel) ·
[BAA text](https://vercel.com/legal/baa)

## 3. Striven

**Why it needs one:** Striven is the system of record and holds full patient
detail including names. Of the three, this is the vendor with the most PHI.

Striven does not publish HIPAA terms the way the developer platforms do, so this
is a direct conversation with your account manager. Ask specifically:

- Will you execute a BAA with Sports Med Recovery?
- Is PHI encrypted at rest, and under whose key management?
- What are your breach notification commitments and timelines to us?
- What are your backup, retention and data-deletion terms on termination?
- Do subcontractors touch our data, and are they bound by equivalent terms?

If Striven will not sign a BAA, escalate — SMR is storing patient data in it
regardless, so this gap exists with or without the dashboard.

## 4. Intuit / QuickBooks Online — the deliberate exception

Intuit does **not** sign BAAs for QuickBooks Online; QBO is not offered as a
HIPAA-compliant service. The architecture responds to that by keeping PHI out of
QuickBooks entirely rather than by seeking an agreement:

- Customers are created and matched **only** as `PT-<id>` references.
- All 8 pre-existing patient-name customers were renamed on 2026-07-18.
- The invoice posting path sends a reference, a date, a document number and
  amounts. No name, no clinical detail, no contact information.
- The legacy sales-order path that had sent names was removed.

**Verification you can repeat any time** — every customer name in QuickBooks
should match `PT-<digits>`:

```
node scripts/qb-migrate-customers-to-refs.mjs      # dry run; must report 0 to rename
```

**Ask your compliance reviewer to confirm** the residual judgement: an account
label plus an invoice amount, with the key held only by SMR, is intended to fall
below the threshold that would make Intuit a Business Associate. That conclusion
should be documented by a professional, not assumed.

**Standing rule:** never send a patient name, DOB, address, phone, email,
diagnosis or clinical description to QuickBooks — no matter how convenient a
future feature makes it.

## 5. Executed agreements

Store signed PDFs somewhere durable and access-controlled (not this repository)
and record them here. Retain **6 years** past termination (§164.316(b)(2)).

| Vendor | Signed on | Signed by (SMR) | Vendor signatory | Expiry / review | File location |
|---|---|---|---|---|---|
| Supabase | | | | | |
| Vercel | | | | | |
| Striven | | | | | |

## 6. Ongoing obligations

- **Before adding any new vendor** that will touch PHI — analytics, error
  tracking, email, backup, an AI service — get the BAA signed *first*. Adding
  the tool and sorting the paperwork later is itself the violation.
- Review this tracker annually alongside [02-risk-analysis](02-risk-analysis.md).
- If a vendor reports a breach, run [03-incident-response-plan](03-incident-response-plan.md).
- On terminating a vendor, confirm in writing what happens to SMR's data and
  when it is destroyed.

---
*Not legal advice. Vendor plan requirements and BAA terms change — verify each
directly, and have counsel review before signing.*
