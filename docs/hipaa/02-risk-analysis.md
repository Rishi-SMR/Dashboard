# 02 — Risk Analysis & Risk Management Plan

**System:** SMR Cashflow Dashboard · **Date:** 2026-07-18
**Authority:** 45 CFR §164.308(a)(1)(ii)(A) (risk analysis) and (B) (risk management)
**Method:** NIST SP 800-30 style — enumerate where PHI lives and moves, identify
threats to each, rate likelihood × impact, record the control and the residual risk.

A risk analysis is only useful if it is honest about what is *not* fixed. The
open items in §4 are stated plainly for that reason.

---

## 1. Where PHI lives and how it moves

```
  Striven ERP (SYSTEM OF RECORD — holds patient names, full detail)
      │  HTTPS, OAuth client credentials, server-side only
      ▼
  Vercel serverless functions (api/index.js)  ── transient, no disk persistence
      │  scrubPhi(): patient name ──► PT-<id>   ← direct identifiers removed here
      ├──────────────► Supabase Postgres        (cache + config + audit logs)
      ├──────────────► Browser (React SPA)      (PT- refs only)
      └──────────────► QuickBooks Online        (PT- refs + amounts only)
```

| Store | Contains | PHI? | Encryption | BAA |
|---|---|---|---|---|
| Striven ERP | Names, orders, full detail | **Yes** | Vendor-managed, TLS | ❌ not signed |
| Supabase Postgres | `PT-` refs, amounts, dates, item names, audit logs | **Yes** (pseudonymised) | AES-256 at rest, TLS | ❌ not signed |
| Vercel functions | Transient request data only | In transit | TLS | ❌ not signed |
| Browser | `PT-` refs, financial figures | **Yes** (pseudonymised) | TLS + device encryption | n/a |
| QuickBooks Online | `PT-` refs + invoice amounts | Designed to fall below the PHI threshold | Vendor-managed | ❌ Intuit will not sign |

**Note on pseudonymisation.** `PT-418` is not de-identified data under
§164.514(b) — SMR retains the key in Striven. Removing names sharply reduces the
harm of any breach, and it removes Intuit from the PHI chain, but it does not
remove Supabase or Vercel from it. See [README](README.md).

## 2. Risk rating scale

Likelihood and impact are each rated Low / Medium / High. Risk = the higher of
the two when they differ by one step, capped by impact.

## 3. Risks with controls in place (residual risk accepted)

| ID | Threat | L | I | Control implemented | Residual |
|---|---|---|---|---|---|
| R-01 | Credential database stolen → passwords reused elsewhere | L | H | scrypt hashing with per-user random salt; no plaintext copy exists in code, env, Vault or `app_config` (all purged 2026-07-18) | **Low** |
| R-02 | Password guessing / credential stuffing | M | H | 5 failures in 15 min → 429 lockout, derived from the `login_events` table so it holds across serverless instances | **Low-Med** — see R-03 |
| R-04 | Session token stolen and replayed | L | H | HMAC-SHA256 signed token bound to a username; `HttpOnly` (JS cannot read it), `Secure` (never sent in clear), `SameSite=Lax` (blocks cross-site submission); 12-hour expiry | **Low** |
| R-05 | Cannot tell who accessed patient data | L | H | Per-user tokens replaced the former shared global token; `phi_access_events` records user, path, IP, time on every authenticated read | **Low** |
| R-06 | Patient names leak to the browser or to disk | M | H | `scrubPhi()` on every cache write; `maskName()` at the response boundary; all historical cache rewritten (customers 350, invoices 156, so 367, payments 147) | **Low** |
| R-07 | Patient names disclosed to Intuit (no BAA possible) | M | H | QB customers created/matched by `PT-` ref only; all 8 pre-existing patient-name customers renamed; the legacy SO-posting path that sent names was deleted | **Low** |
| R-08 | Auth accidentally disabled by a config error | L | H | `getAuth()` always reports the gate on; if `dashboard_users` is unreachable the login path fails **closed** rather than falling back | **Low** |
| R-09 | Secrets exposed to the browser | L | H | All credentials read server-side only; the SPA calls same-origin `/api/*` and never sees a key | **Low** |
| R-10 | Data intercepted in transit | L | H | TLS everywhere; `Secure` cookies; Striven and QBO called over HTTPS | **Low** |
| R-11 | Data loss / corruption | L | M | Striven is the system of record — Supabase holds a rebuildable cache; `scripts/` can regenerate it; Supabase runs platform backups | **Low** |

## 4. OPEN RISKS — not yet mitigated

These are the real gaps. Each has an owner and a target date, per
§164.308(a)(1)(ii)(B).

| ID | Threat | L | I | Risk | Required action | Owner | Target |
|---|---|---|---|---|---|---|---|
| **R-12** | **No BAA with Supabase, Vercel or Striven.** PHI is disclosed to three vendors with no contractual safeguard. This is a per-vendor violation regardless of how good the technical controls are. | **H** | **H** | **HIGH** | Execute BAAs — see [06](06-baa-tracker.md). Supabase needs Team plan + HIPAA add-on; Vercel offers one to Pro teams via a HIPAA add-on. If a vendor will not sign, the data must move. | Security Officer | **Immediate** |
| **R-13** | **Stale credentials remain in Vercel environment variables** (`APP_USERS`, `ACCESS_PASSWORD`). *Downgraded from HIGH on 2026-07-18:* the code ignores them, and all three passwords were rotated that day, so the values are dead. Residual issue is hygiene — credentials should not sit in a console. | L | L | **LOW** | Delete both env vars in the Vercel dashboard. 2 minutes. Could not be done from code — the stored Vercel CLI token is revoked. | Maintainer | 30 days |
| **R-03** | **No multi-factor authentication.** A phished or reused password is sufficient to reach PHI. Lockout slows guessing but does nothing against a *correct* stolen password. | M | H | **MED-HIGH** | Add MFA (TOTP is implementable on the current stack), or front the app with an identity provider that offers it. | Maintainer | 90 days |
| R-14 | **No documented, exercised backup restore.** Supabase backs up automatically but no restore has ever been tested, and Striven's backup posture is unverified. §164.308(a)(7) wants a tested contingency plan. | L | M | MED | Perform one restore test; document the result and the RTO. Confirm Striven's backup/DR terms in writing. | Maintainer | 90 days |
| R-15 | **Audit logs grow without review or retention limits.** Controls exist; the *habit* does not. An unreviewed log satisfies nobody at audit. | M | M | MED | Start the monthly review in [01 §5](01-policies-and-procedures.md); apply the retention rule in [04](04-data-retention-and-disposal.md). | Security Officer | Monthly from Aug 2026 |
| R-16 | **12-hour session with no idle timeout.** An unattended, unlocked workstation stays authenticated for up to 12 hours. | M | M | MED | Either shorten the session, or add an idle timeout that clears the cookie after ~30 minutes of inactivity. Device screen-lock (policy §7) is the current partial control. | Maintainer | 90 days |
| R-17 | **Supabase service-role key is a single high-value secret** stored in Vercel env. It bypasses RLS and reads every table. | L | H | MED | Rotate on any suspected exposure and on staff departure; consider a narrower key. It was previously pasted into a chat session, so **rotate it once as a precaution** — but note the rotation must be done *together with* updating the Vercel env var, or production breaks instantly. Do it in the same sitting as R-13. | Maintainer | 30 days |
| R-18 | **Personal access tokens in `.credentials.local`** (Supabase PAT, and account passwords) sit in plaintext on a developer workstation. | M | H | MED | Confirm the disk is encrypted; rotate the Supabase PAT, which was previously pasted into a chat session; consider moving to a password manager. | Maintainer | 30 days |
| R-19 | **No workforce training has been delivered or recorded.** §164.308(a)(5) requires it, and the record of it. | H | M | MED | Deliver [05](05-workforce-training.md) to all three users and sign the register. | Security Officer | 30 days |
| R-20 | **Non-patient personal names remain in cached data**: the `rep` field on orders (16 distinct sales-channel labels over 365 orders), project `createdBy`/`lastUpdatedBy` (SMR staff), and one vendor record. Assessed as workforce/business data, not PHI, and deliberately retained. | L | L | LOW | Documented decision — no action. The allowlist is enforced in `scripts/hipaa-check.mjs`, so anything *else* fails the check. | — | — |
| R-21 | **Patient names were found embedded in free-text and internal state** — `tasks.title` ("Temple - Fidel Castillo"), `projects.name` ("Jan Vaiz AFO- L1971", a name plus an orthotic HCPCS code), the QuickBooks posted maps, and the auto-PO log's drop-ship field. The first remediation pass scrubbed only the four primary datasets and missed these. | — | H | **CLOSED 2026-07-18** | Fixed at source (auto-PO log no longer stores the Striven order number, which embeds a surname) and in the stored data; `scrubPhi` now redacts by field name and inside free text across every dataset. Caught by `scripts/hipaa-check.mjs`, which now runs monthly per [08](08-verification-sop.md). | Maintainer | Done |

## 5. Summary

The technical safeguards for this system are, as of 2026-07-18, in reasonable
shape: identity, authentication, audit, transmission security and minimisation
of identifiers are all implemented and verified in production.

**The system is nonetheless not compliant**, principally because PHI is
disclosed to three vendors under no Business Associate Agreement (R-12). No
amount of code fixes that — it needs a purchase and a signature. R-03 (no MFA)
is the most significant remaining *technical* weakness.

## 6. Review

This analysis is reviewed annually and whenever the system changes materially —
a new data store, a new vendor, a new category of data, or an incident.

| Date | Reviewer | Trigger | Outcome |
|---|---|---|---|
| 2026-07-18 | System maintainer (AI-assisted) | Initial analysis | 11 risks controlled, 9 open — see §4 |

---
*Not legal advice. A qualified assessor should validate this analysis.*
