# HIPAA compliance file — SMR Cashflow Dashboard

**System:** SMR Cashflow Dashboard — https://cfovaani.in
**Covered Entity:** Sports Med Recovery (SMR)
**Last updated:** 2026-07-18

This folder is the written record HIPAA expects a covered entity to be able to
produce on request. The Security Rule does not only ask "is the software
secure" — it asks "can you *show* the analysis, the policies, and the training."
Working code satisfies roughly half of it; these documents are the other half.

| # | Document | Satisfies |
|---|---|---|
| [01](01-policies-and-procedures.md) | Policies & procedures | §164.316(a) |
| [02](02-risk-analysis.md) | Risk analysis + risk management plan | §164.308(a)(1)(ii)(A)–(B) |
| [03](03-incident-response-plan.md) | Incident response & breach notification | §164.308(a)(6), §164.400–414 |
| [04](04-data-retention-and-disposal.md) | Retention & disposal | §164.310(d)(2), §164.316(b)(2) |
| [05](05-workforce-training.md) | Workforce training | §164.308(a)(5) |
| [06](06-baa-tracker.md) | Business Associate Agreements | §164.308(b)(1), §164.502(e) |
| [07](07-baa-action-pack.md) | BAA action pack — click paths + ready-to-send email | — |
| [08](08-verification-sop.md) | **SOP: how to verify compliance** (`node scripts/hipaa-check.mjs`) | §164.308(a)(8) |

---

## Read this first: what "PT-418" actually means

The dashboard never displays or stores a patient's name. Every patient appears
as a reference like `PT-418`, where 418 is the patient's Striven customer id.

**This is pseudonymisation, not de-identification.** It is a real and large
reduction in exposure, but it does *not* take the data outside HIPAA:

- Under §164.514(b) (Safe Harbor), data is de-identified only when 18 identifier
  categories are removed **and** no re-identification key is retained. SMR keeps
  the key — Striven maps 418 back to a person.
- Therefore the order history, dates of service and dollar amounts stored in
  Supabase against `PT-418` remain **PHI**, and Supabase remains a **Business
  Associate**. A signed BAA with Supabase is required. See [06](06-baa-tracker.md).

The honest one-line summary is: *direct identifiers have been removed from every
system except the system of record; the remaining data is still protected.*

QuickBooks is the one exception worth calling out. Intuit will not sign a BAA
for QuickBooks Online, so the design deliberately gives Intuit only a reference
and a dollar amount — no name, no clinical detail, no date of birth. Whether an
account label plus an invoice amount is enough to make Intuit a Business
Associate is a judgement call your compliance reviewer should confirm; the
architecture is built to make the answer "no."

---

## Current technical state (verified 2026-07-18)

Implemented and running in production:

- Passwords stored scrypt-hashed in `dashboard_users`; no plaintext credential
  exists anywhere (env vars, Vault and `app_config` copies were purged).
- Per-user HMAC-signed session tokens — the server can attribute every request
  to a named individual. No shared password, no shared token.
- Login gate fails **closed**: if the user table is unreachable, logins are
  refused rather than falling back to a weaker credential.
- Brute-force lockout: 5 consecutive failures in 15 minutes → 429.
- Session cookies are `HttpOnly; Secure; SameSite=Lax`, 12-hour lifetime.
- `login_events` records every login attempt; `phi_access_events` records every
  authenticated read of patient-derived data (user, path, IP, timestamp).
- Patient names are stripped on every cache write (`scrubPhi`) and were removed
  from all previously cached data.
- All 8 QuickBooks customers were renamed from patient names to `PT-` refs;
  linked transactions and original dates survived intact.

Known gaps, with owners, are tracked in [02-risk-analysis.md](02-risk-analysis.md).
The two that need a human, not a commit:

1. **Signed BAAs** — Supabase, Vercel, Striven. Nothing in code substitutes.
   Click paths and a ready-to-send email are in [07](07-baa-action-pack.md).
2. **Delete `APP_USERS` and `ACCESS_PASSWORD` from the Vercel project's
   environment variables.** Vercel → project `dashboard` → Settings →
   Environment Variables → ⋯ → Remove. *Severity reduced 2026-07-18:* the code
   has ignored them since that date and all three passwords were rotated, so the
   values there are dead — but credentials should not sit in a console.

---

## Standing caveat

These documents were drafted by an engineer (with AI assistance), not by a
lawyer or a certified HIPAA assessor. They are a genuine, specific starting
record — not a legal opinion, and not a certification. Have a compliance
professional review them before you rely on them in an audit, a client contract,
or a breach response.
