# 01 — Policies & Procedures

**Applies to:** SMR Cashflow Dashboard (https://cfovaani.in) and everyone with a
login to it.
**Owner:** Security Officer (see §1).
**Effective:** 2026-07-18 · **Review cycle:** annually, or after any material change.
**Authority:** 45 CFR §164.316(a) — a covered entity must implement reasonable
policies and procedures and keep them in writing.

---

## 1. Roles

| Role | Person | Responsibility |
|---|---|---|
| Security Officer (§164.308(a)(2)) | *[assign — recommend the practice owner]* | Owns this file, approves access, runs the annual review, leads incident response |
| Privacy Officer (§164.530(a)) | *[assign — may be the same person]* | Patient rights, complaints, minimum-necessary decisions |
| System maintainer | *[assign — the engineer holding deploy access]* | Applies technical controls, provides audit evidence on request |

> These roles are **not optional and cannot be left blank.** Fill in the names
> before treating this document as complete.

## 2. What data this system handles

The dashboard is a financial reporting tool over SMR's Striven ERP. It handles:

- **Patient-derived financial data** — orders, invoices, payments, service and
  item names, dates, amounts, each tied to a pseudonymous reference `PT-<id>`.
  This **is PHI** (see [README](README.md) — SMR holds the re-identification key).
- **Business data** — vendors, purchase orders, staff/sales-rep names,
  commission figures. Not PHI.
- **Credentials and audit records** — hashed passwords, login and access logs.

The dashboard does **not** handle clinical notes, diagnoses, images, insurance
identifiers, dates of birth, addresses or contact details, and must not be
extended to do so without a fresh risk analysis.

## 3. Minimum necessary (§164.502(b))

Every payload the backend returns must be the smallest set of fields that
answers the question on screen. Concretely, and enforced in code:

- Patient names are replaced with `PT-<id>` before any value is cached or sent
  to a browser (`scrubPhi` in `api/_striven.js`).
- No endpoint returns a raw patient record; endpoints return shaped aggregates.
- "Just in case" fields are not added to responses. If a field is not rendered,
  it is not sent.

**Procedure — adding a new field or endpoint:** the maintainer must confirm in
the pull request description (a) which screen consumes the field, (b) whether it
is patient-derived, and (c) if so, why a reference is not sufficient. A change
that would send a patient name to the browser is refused.

## 4. Access control (§164.308(a)(3), §164.312(a))

**Unique identity.** Every user has their own account in the Supabase
`dashboard_users` table. Shared accounts and shared passwords are prohibited —
the previous shared `ACCESS_PASSWORD` gate was removed on 2026-07-18 and must
not be reintroduced.

**Authorisation.** Access is granted by the Security Officer only, and only to
workforce members whose job requires the financial data. Current authorised
users are the three accounts in `dashboard_users`; the list is reviewed at least
annually and at every staffing change.

**Procedure — granting access:**
1. Security Officer approves, in writing (email is fine), naming the person and
   the business reason.
2. Maintainer inserts a row into `dashboard_users` with a **scrypt-hashed**
   password (`hashPassword()` in `api/_striven.js`). Never insert a plaintext
   password — the login path no longer upgrades them.
3. The password is delivered to the user out-of-band and they are told not to
   reuse it elsewhere.
4. The new user completes [05-workforce-training](05-workforce-training.md)
   before first login.

**Procedure — terminating access (§164.308(a)(3)(ii)(C)) — same day:**
1. Delete the user's row from `dashboard_users`. Access dies within 60 seconds
   (the user cache TTL); their existing session token remains valid for up to
   12 hours.
2. To kill live sessions immediately, rotate `SESSION_SECRET` in the Vercel
   environment — this invalidates **every** session and forces all users to log
   in again. Do this whenever a departure is not amicable.
3. Record the removal in the access log (§10).

**Password rules.** Minimum 12 characters, not reused from another system,
changed immediately if exposure is suspected. Passwords are stored only as
scrypt hashes; the plaintext copies in `.credentials.local` are for the
administrator's own accounts and must stay on an encrypted, gitignored disk.

**Not yet implemented:** multi-factor authentication. See risk R-03 in
[02-risk-analysis](02-risk-analysis.md).

## 5. Audit controls (§164.312(b))

Two tables record activity, written by the server and readable only with the
service-role key:

- `login_events` — username, success/failure, IP, timestamp. Every attempt.
- `phi_access_events` — username, request path, IP, timestamp. Every
  authenticated read of patient-derived data.

**Procedure — monthly audit review** (Security Officer, first week of each month):
1. In the Supabase SQL editor run:
   ```sql
   -- failed logins, newest first
   select username, ip, at from login_events
   where success = false and at > now() - interval '30 days' order by at desc;

   -- who read patient data, and how much
   select username, count(*), min(at), max(at) from phi_access_events
   where at > now() - interval '30 days' group by username order by 2 desc;
   ```
2. Look for: logins by departed staff, access from unexpected countries or IPs,
   bursts of failures (attempted guessing), or access volumes far outside a
   person's normal pattern.
3. Record the review — date, who ran it, anything investigated — in §10 below.
   **An unrecorded review does not count.** The record is the deliverable.

## 6. Transmission & storage security (§164.312(e), §164.312(a)(2)(iv))

- All traffic is HTTPS/TLS; the site is served only over TLS and session cookies
  are marked `Secure`, so they cannot be sent over a downgraded connection.
- Data at rest in Supabase is encrypted by the platform (AES-256).
- Credentials live in the Supabase `app_config` table and Vercel environment
  variables, read server-side only. They are never sent to the browser.
- No PHI is written to application logs. Error messages must not interpolate
  patient data.
- PHI must not be emailed, exported to personal devices, pasted into chat tools,
  or put into any AI service that is not covered by a BAA. CSV exports from the
  Reports tab contain `PT-` references and financial data — treat an exported
  file as PHI: keep it on an encrypted work device and delete it when done.

## 7. Workstation & device security (§164.310(b)–(c))

Anyone logging into the dashboard must use a device with full-disk encryption
(FileVault / BitLocker), a screen lock of 15 minutes or less, a supported and
patched OS, and no shared user profile. Do not log in from public or shared
computers.

## 8. Business Associates (§164.308(b)(1))

SMR may not disclose PHI to a vendor without a signed BAA. The vendor list,
current status, and how to obtain each agreement are in
[06-baa-tracker.md](06-baa-tracker.md). **Several are unsigned as of
2026-07-18 — this is the single largest open compliance gap.**

## 9. Incident reporting (§164.308(a)(6))

Any suspected exposure — a shared password, a lost laptop, an emailed export, a
name appearing where it should not, an unfamiliar login in the audit table — is
reported to the Security Officer **the same day**. Do not wait until you are
sure it was real. Follow [03-incident-response-plan.md](03-incident-response-plan.md).

## 10. Records

HIPAA requires these records be kept **six years** (§164.316(b)(2)).

### Policy review log
| Date | Reviewed by | Changes |
|---|---|---|
| 2026-07-18 | *[Security Officer]* | Initial version |

### Access change log
| Date | User | Action | Approved by |
|---|---|---|---|
| 2026-07-18 | rishi@sportsmedrecovery.com | Existing — migrated to hashed password | *[ ]* |
| 2026-07-18 | crystal@sportsmedrecovery.com | Existing — migrated to hashed password | *[ ]* |
| 2026-07-18 | admin@sportsmedrecovery.com | Existing — migrated to hashed password | *[ ]* |

### Audit review log
| Month | Reviewed by | Findings | Action taken |
|---|---|---|---|
| *(first entry due August 2026)* | | | |

---
*Drafted by the system maintainer with AI assistance. Not legal advice — have a
compliance professional review before relying on this in an audit.*
