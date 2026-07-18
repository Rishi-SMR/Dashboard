# 08 — SOP: Verifying HIPAA compliance of the SMR Dashboard

**Purpose:** a repeatable procedure that answers "is this dashboard actually
following HIPAA?" with evidence rather than opinion.
**Frequency:** monthly, plus before any release that touches auth, caching, the
QuickBooks path, or any new data field.
**Owner:** system maintainer (technical part) + Security Officer (manual part).

---

## The one thing to understand first

HIPAA compliance splits into two halves, and **software can only prove one of them**:

| | What it covers | Can a script check it? |
|---|---|---|
| **Technical safeguards** | Hashing, identity, audit trail, encryption, minimum necessary | ✅ Yes — §2 below |
| **Administrative safeguards** | BAAs, training, policies, risk review, named officers | ❌ No — §3 below |

A green technical run means *the software is holding up its side*. It does not
mean SMR is compliant. Both halves must pass.

---

## 1. Run the automated check

```bash
cd "/path/to/SMR"
node scripts/hipaa-check.mjs                 # against production
node scripts/hipaa-check.mjs --local         # against a local dev server
```

Exit code 0 = all technical controls pass. Non-zero = at least one failed; the
failing IDs are printed at the end.

The check is safe to run any time. It is read-only except for the lockout test,
which deliberately uses a throwaway `@example.invalid` username so it can never
lock a real colleague out.

## 2. What each control means

| ID | Control | Regulation | What a failure means |
|---|---|---|---|
| **A1** | Passwords stored scrypt-hashed | §164.312(a)(2)(i) | A plaintext password is in the users table. Fix immediately. |
| **A2** | No credential outside the hashed table | §164.312(a)(2)(i) | A password reappeared in `app_config`/Vault. Remove it. |
| **A3** | Unauthenticated requests refused | §164.312(a)(1) | **Critical** — patient data is reachable without login. |
| **A4** | Forged session token rejected | §164.312(d) | **Critical** — session signing is broken. |
| **A5** | Wrong password refused | §164.312(d) | Authentication is not verifying credentials. |
| **A6** | Brute force locked out | §164.308(a)(5)(ii)(C) | Password guessing is unthrottled. |
| **A7** | Cookies HttpOnly + Secure | §164.312(e)(1) | Session can be stolen by script or over plain HTTP. |
| **B1** | Every login attempt recorded | §164.312(b) | The audit trail has a hole. |
| **B2** | Every PHI read attributed to a user | §164.312(b) | You cannot answer "who accessed this?" — an audit failure. |
| **C1** | No patient name in the Supabase cache | §164.502(b) | A name is at rest outside Striven. See below. |
| **C2** | Browser receives only PT- references | §164.502(b) | Names are reaching the client. |
| **C3** | QuickBooks holds no patient name | §164.502(e) | PHI is at Intuit, who will not sign a BAA. |
| **D1** | TLS only | §164.312(e)(1) | Traffic can travel unencrypted. |

### About C1 — read this before "fixing" a failure

C1 pulls the real customer names **live from Striven** and searches every cached
dataset for them. It reports the exact JSON path of any hit.

Some fields legitimately contain a person's name that is **not a patient**.
These are reviewed and allowlisted inside the script:

| Path | Why it is not PHI |
|---|---|
| `so_detail.[].rep`, `order_chain.[].rep` | Sales channel / referral partner labels — 16 distinct values across 365 orders ("Maverick Medical - …", "House Account", "CVT Medical - …") |
| `projects.[].createdBy.name`, `.lastUpdatedBy.name` | SMR staff who created or edited the project |
| `vendors.[].name` | "My Company" — a vendor record that happens to share a name with a customer record |

**If C1 fails, it found something NOT on that list — treat it as a real leak
until proven otherwise.** Do not add an entry to the allowlist to make the check
go green; justify it in writing here first, the way the four above are.

Two related fields were checked on 2026-07-18 and found clean, but are worth
re-checking if the data model changes:
- `so_detail.[].payer` — 64 distinct values, **zero** overlap with the patient
  list; they are law firms, the VA and TriCare. Some are named after a solo
  attorney ("Diego Lopez"), which looks like a person but is a business. The
  scrub still maps this field defensively, so a patient name landing there would
  be converted to a reference rather than stored.
- Striven **order numbers** embed a patient surname ("ADubberly DEMO Hidow"), so
  they are deliberately not persisted in the auto-PO log — only the numeric SO id is.

## 3. The manual half — check these too

A script cannot verify any of the following. Tick them monthly; an unticked box
means SMR is not compliant regardless of what the script says.

| ID | Check | Where | Regulation |
|---|---|---|---|
| MANUAL-1 | Signed BAAs with Supabase, Vercel, Striven | [06](06-baa-tracker.md) §5 has the table; [07](07-baa-action-pack.md) has the steps | §164.308(b)(1) |
| MANUAL-2 | All users trained, register signed | [05](05-workforce-training.md) §7 | §164.308(a)(5) |
| MANUAL-3 | Last month's audit-log review recorded | [01](01-policies-and-procedures.md) §10 | §164.308(a)(1)(ii)(D) |
| MANUAL-4 | Risk analysis reviewed within 12 months | [02](02-risk-analysis.md) §6 | §164.308(a)(1)(ii)(A) |
| MANUAL-5 | Security & Privacy Officer named in writing | [01](01-policies-and-procedures.md) §1 | §164.308(a)(2) |
| MANUAL-6 | User list matches current staff; leavers removed | `dashboard_users` vs payroll | §164.308(a)(3)(ii)(C) |
| MANUAL-7 | `APP_USERS` / `ACCESS_PASSWORD` gone from Vercel env | Vercel → Settings → Environment Variables | hygiene |

The monthly audit-log review itself (MANUAL-3):

```sql
select username, ip, at from login_events
where success = false and at > now() - interval '30 days' order by at desc;

select username, count(*), min(at), max(at) from phi_access_events
where at > now() - interval '30 days' group by username order by 2 desc;
```
Look for: departed staff, unfamiliar IPs or countries, bursts of failures,
volumes far outside a person's normal pattern. **Record that you looked**, even
when nothing was found — the record is the deliverable.

## 4. When to run this beyond the monthly cycle

Re-run the technical check before shipping any change that:
- touches login, sessions, or cookies
- adds a new cached dataset or a new field to an existing one
- adds or changes anything posted to QuickBooks
- adds a new external service of any kind (that also needs a BAA first)

## 5. Result log

Keep six years (§164.316(b)(2)).

| Date | Technical result | Manual items outstanding | Run by | Notes |
|---|---|---|---|---|
| 2026-07-18 | **13/13 PASS** | MANUAL-1 (no BAAs), 2, 3, 5, 7 | Maintainer | First run of the automated check found real leaks in `tasks.title`, `projects.name`, `qb_posted*.customer` and the auto-PO log that the earlier manual scrub had missed. All fixed at source and in the stored data, then re-verified. |

---

## Honest summary as of 2026-07-18

**Technical: yes.** All 13 controls pass against production, and the checks are
now automated so drift gets caught instead of assumed away.

**Overall: no, not yet** — and the gap is not in the code. PHI is disclosed to
Supabase, Vercel and Striven with no Business Associate Agreement in place, no
workforce training has been delivered, and no Security Officer is named in
writing. Those are signatures and calendar entries, not commits.

*Not legal advice. Have a compliance professional review this before relying on
it in an audit or a client contract.*
