# 07 — BAA Action Pack (ready to send)

Everything needed to close risk R-12 is prepared here. Each item is either a
short click-path or an email that can be sent as-is. **Only a human can complete
these** — they require a purchase and a signature in SMR's name.

Target: all three executed within 30 days of 2026-07-18.

---

## A. Supabase — organisation `Rishi-SMR`, project `Dashboard` (`ldkeeiefpsrncfxmgyhr`, ap-southeast-1)

Currently on a plan below Team, so no BAA is available yet.

**Click path (about 10 minutes):**
1. https://supabase.com/dashboard/org/mkugujzizmiqdeejdiyw/billing → upgrade to **Team**
2. Same org → **Legal / Compliance** → enable the **HIPAA add-on**
3. Request the BAA there and sign it electronically
4. Project `Dashboard` → Settings → mark as a **High Compliance** project
5. Work through any configuration checks it flags, then save the executed PDF

**One thing to expect at step 5:** the project sits in `ap-southeast-1`
(Singapore). HIPAA does not require US residency, but confirm this is acceptable
to SMR and to any payer contracts, and that the BAA covers that region. If it
must move, do it *before* signing — a region migration afterwards is painful.

---

## B. Vercel — team `rishi-smr`, project `dashboard`

**Click path (about 5 minutes):**
1. https://vercel.com/rishi-smr/~/settings/billing → confirm the team is on
   **Pro** (upgrade from Hobby if needed)
2. Settings → Billing → purchase the **HIPAA add-on**; the BAA is executed there
3. Save the executed PDF

**While you are in there — do this too (risk R-13):**
Settings → `dashboard` → Environment Variables → delete **`APP_USERS`** and
**`ACCESS_PASSWORD`**. The code has ignored them since 2026-07-18 and the
passwords they contain were rotated the same day, so they are now worthless —
but they are still credentials sitting in a console and should not be there.

---

## C. Striven — email ready to send

Send to your Striven account manager, or support@striven.com.

> **Subject: Business Associate Agreement request — Sports Med Recovery**
>
> Hello,
>
> Sports Med Recovery is a healthcare provider and a HIPAA covered entity. We
> store patient-related records in Striven, which means Striven creates,
> receives and maintains Protected Health Information on our behalf.
>
> Under 45 CFR §164.502(e) we are required to have a signed Business Associate
> Agreement in place with you. Could you please send us your BAA for execution?
>
> While we arrange that, we would also appreciate written answers to the
> following, which we need for our documented risk analysis:
>
> 1. Is customer data encrypted at rest, and with what key management?
> 2. What are your breach notification commitments and timelines to us?
> 3. What are your backup, retention and data-deletion terms, including what
>    happens to our data if we terminate?
> 4. Do any subcontractors process our data, and are they bound by equivalent
>    HIPAA terms?
> 5. Do you hold SOC 2 Type II or an equivalent attestation we can review?
>
> If Striven does not offer a BAA, please tell us directly so we can assess our
> options.
>
> Thank you,
> *[Your name]*
> *[Title]*, Sports Med Recovery
> *[Phone / email]*

**If they decline**, escalate rather than let it sit. SMR's patient data is in
Striven regardless of this dashboard, so an unsigned BAA is an existing exposure
that predates and outlives this project.

---

## D. Intuit / QuickBooks — no BAA, by design

No action. Intuit does not offer BAAs for QuickBooks Online, and the system is
built so that none is needed: QuickBooks receives `PT-<id>` references and
amounts only. Verify any time with:

```
node scripts/qb-migrate-customers-to-refs.mjs      # dry run — must report 0 to rename
```

Ask your compliance reviewer to confirm and document this judgement rather than
assuming it. See [06-baa-tracker.md §4](06-baa-tracker.md).

---

## Tracking

| Vendor | Action | Owner | Done |
|---|---|---|---|
| Supabase | Team plan + HIPAA add-on + BAA + High Compliance | | ☐ |
| Vercel | Pro + HIPAA add-on + BAA | | ☐ |
| Vercel | Delete `APP_USERS` + `ACCESS_PASSWORD` env vars | | ☐ |
| Striven | Send email above; obtain signed BAA | | ☐ |
| All | File executed PDFs, record dates in [06 §5](06-baa-tracker.md) | | ☐ |

---
*Not legal advice — have counsel review each agreement before signing.*
