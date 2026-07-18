# 04 — Data Retention & Disposal Policy

**System:** SMR Cashflow Dashboard · **Effective:** 2026-07-18
**Authority:** §164.310(d)(2)(i)–(ii) (media disposal and re-use),
§164.316(b)(2) (six-year documentation retention), §164.530(j)

Two different clocks apply and they are often confused:

- **HIPAA documentation** — policies, risk analyses, audit reviews, incident
  records, training registers — must be kept **6 years** from creation or last
  effective date. This is a HIPAA requirement.
- **Medical/billing records themselves** — retention is set by **state law** and
  payer contracts, not by HIPAA. *[Confirm SMR's state requirement and record it
  here — typically 5–10 years, longer for minors.]*

---

## 1. Retention schedule

| Data | Where | Retain | Then |
|---|---|---|---|
| Patient orders, invoices, payments (source records) | **Striven ERP** — system of record | Per state law + payer contract *[fill in]* | Follow Striven's deletion process; document |
| Cached copies of the above (`PT-` refs) | Supabase `striven_cache` | **Rebuildable — no retention value.** Purge freely | Overwritten on refresh; safe to truncate |
| Report datasets (`report_vendor_items`, `report_patient_items`) | Supabase `striven_cache` | Regenerate as needed | Overwritten by `scripts/gen-reports.mjs` |
| Invoices posted to QuickBooks (`PT-` ref + amount) | QuickBooks Online | Per accounting/tax retention (commonly 7 years) | Standard financial retention |
| **`login_events`** | Supabase | **6 years** — HIPAA audit documentation | Delete rows older than 6 years |
| **`phi_access_events`** | Supabase | **6 years** — HIPAA audit documentation | Delete rows older than 6 years |
| `dashboard_users` | Supabase | While the user is authorised | Delete the row on termination (same day) |
| This `docs/hipaa/` folder and all logs inside it | Git repository | **6 years** from superseding | Archive, do not silently delete |
| CSV exports from the Reports tab | Wherever the user saved them | **Delete when the task is done** | See §3 |

**Note.** The 6-year audit retention is the conservative reading: OCR treats
access logs as records demonstrating compliance, so keeping them the full
documentation period is the safe default. If storage becomes a problem,
aggregate rather than delete — keep monthly counts per user indefinitely and
prune only the row-level detail past 6 years.

## 2. Purge procedures

**Audit tables — annual, run by the maintainer each January**

```sql
-- keep 6 years exactly; run inside a transaction and check the count first
select count(*) from login_events      where at < now() - interval '6 years';
select count(*) from phi_access_events where at < now() - interval '6 years';

delete from login_events      where at < now() - interval '6 years';
delete from phi_access_events where at < now() - interval '6 years';
```

Record each purge in §5. **Never delete audit rows outside this scheduled purge**
— ad-hoc deletion of audit data looks identical to evidence tampering, and is
explicitly forbidden during an open incident (see [03](03-incident-response-plan.md)).

**Cache — safe to purge at any time**

```sql
delete from striven_cache;   -- rebuilt from Striven on the next refresh
```

**Terminated user**

```sql
delete from dashboard_users where username = '<user>';
```
Then rotate `SESSION_SECRET` in Vercel to kill any live session immediately.
Do **not** delete that user's `login_events` or `phi_access_events` rows — those
must survive the person's departure for the full 6 years.

## 3. Exports and derived files (§164.310(d)(1))

CSV exports from the Reports tab contain `PT-` references, service/item names,
dates and amounts. **Treat an exported file as PHI.**

- Save only to an encrypted work device — never to personal storage, USB sticks,
  or a personal cloud drive.
- Never email an export outside SMR without a BAA covering the recipient.
- Delete the file as soon as the task is done. Empty the trash.
- If the file must be kept, keep it inside an SMR-controlled, encrypted,
  access-controlled location and apply the same 6-year rule as the source data.

## 4. Media disposal (§164.310(d)(2)(i))

Any device that has held PHI — including a laptop that merely displayed the
dashboard, since browser caches persist — must be sanitised before disposal,
resale, return to a leasing company, or reassignment to another person:

| Media | Method |
|---|---|
| SSD / laptop with full-disk encryption | Cryptographic erase (destroy the key) — e.g. macOS Erase All Content and Settings, or BitLocker key deletion followed by a full wipe |
| SSD without encryption | Vendor secure-erase, or physical destruction |
| Hard disk | Multi-pass overwrite (NIST SP 800-88 Purge) or physical destruction |
| Phone / tablet | Factory reset with encryption enabled |
| Paper (printed reports) | Cross-cut shred or bonded destruction service |
| Cloud storage | Delete, then confirm the vendor's deletion/backup-expiry window in writing |

Record every disposal in §5 — **a certificate of destruction from a vendor,
or a signed internal record, is the evidence.** "We wiped it" without a record
does not survive an audit.

## 5. Records

### Purge log
| Date | Data purged | Rows | Run by |
|---|---|---|---|
| *(first audit purge due January 2032 — 6 years from 2026)* | | | |

### Media disposal log
| Date | Device / media | Held PHI? | Method | Certificate | By |
|---|---|---|---|---|---|
| | | | | | |

---
*Not legal advice. State medical-record retention law governs the source records
and must be confirmed locally — the blanks above are deliberate.*
