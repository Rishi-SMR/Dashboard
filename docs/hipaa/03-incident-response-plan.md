# 03 — Incident Response & Breach Notification Plan

**System:** SMR Cashflow Dashboard · **Effective:** 2026-07-18
**Authority:** §164.308(a)(6) (security incident procedures), §164.400–414
(breach notification), §164.530(f) (mitigation)

The clock in a breach starts on **discovery**, not on confirmation. Report first,
analyse second.

---

## 1. Report immediately — do not investigate alone

**Contact the Security Officer the same day** you notice anything below. Use the
fastest channel available; follow up in writing.

| Role | Name | Phone | Email |
|---|---|---|---|
| Security Officer | *[FILL IN]* | *[ ]* | *[ ]* |
| Privacy Officer | *[FILL IN]* | *[ ]* | *[ ]* |
| System maintainer | *[FILL IN]* | *[ ]* | *[ ]* |

> **This table must be filled in before the plan is usable.** A plan nobody can
> execute at 11pm on a Saturday is not a plan.

## 2. What counts as a reportable incident

Report any of these, even if you think it turned out fine:

- A password shared, written down in a shared place, reused, or possibly phished
- A lost or stolen laptop or phone that had a dashboard session on it
- A patient name appearing anywhere it should not — a screen, an export, an
  invoice in QuickBooks, a log
- An unfamiliar login, or a login from an unexpected location, in `login_events`
- A CSV export emailed, uploaded, or copied to a personal device
- PHI pasted into any external tool (AI assistants, spreadsheets online, chat)
- A vendor notifying SMR of a breach on their side (Supabase, Vercel, Striven, Intuit)
- Ransomware, malware, or a suspicious file on any device used with the dashboard
- A sustained burst of failed logins (visible as repeated `429`s or many
  `success = false` rows)

**Ransomware is presumed to be a breach** unless a risk assessment demonstrates
a low probability of compromise. Report it immediately.

## 3. Response steps

### Step 1 — Contain (within hours)

| Situation | Action |
|---|---|
| Compromised user account | Delete the row from `dashboard_users`, then **rotate `SESSION_SECRET`** in Vercel — this invalidates every live session, including the attacker's. |
| Any doubt about session security | Rotate `SESSION_SECRET`. Everyone re-logs in. Cheap. |
| Supabase service key exposed | Rotate it in Supabase → Settings → API, update the Vercel env var and `striven-server/.env`, redeploy. |
| Striven or QuickBooks credentials exposed | Rotate in the vendor console, update `app_config`, redeploy. For QuickBooks also disconnect the app. |
| Lost device | Remote-wipe if managed; rotate `SESSION_SECRET` regardless. |
| Vendor-side breach | Get the vendor's written incident report; it feeds the assessment in Step 3. |

### Step 2 — Preserve evidence and record the timeline

Do **not** delete audit rows, logs, or the offending data — they are the
evidence. Capture, with timestamps:

```sql
-- what the account did
select * from phi_access_events where username = '<user>' order by at desc;
select * from login_events     where username = '<user>' order by at desc;
-- everything in a window
select * from phi_access_events where at between '<start>' and '<end>' order by at;
```
Also collect Vercel function logs for the window. Save copies outside the
affected systems.

### Step 3 — Assess whether it is a breach (§164.402)

An impermissible use or disclosure of PHI is **presumed a breach** unless SMR
demonstrates a **low probability that PHI was compromised**, using all four
factors — document each in writing:

1. **Nature and extent of the PHI.** What fields? For this system, was it only
   `PT-` references and amounts, or did an actual patient name escape (which
   would require access to Striven, not just the dashboard)?
2. **Who received it.** Another workforce member bound by HIPAA? A vendor under
   a BAA? An unknown external party?
3. **Was the PHI actually acquired or viewed**, or merely exposed? Audit rows
   often answer this precisely.
4. **How far the risk has been mitigated.** Retrieved and destroyed? Attested
   in writing? Sessions rotated?

**Exclusions that mean it is not a breach:** unintentional, good-faith access by
a workforce member acting within scope where nothing further was disclosed;
inadvertent disclosure between two authorised people at SMR; or a disclosure to
someone who could not reasonably have retained the information.

Two notes specific to this design:
- The pseudonymisation genuinely helps factor 1 — a leak of `PT-418 · $100 ·
  2026-07-15` is far less identifying than a leak of a name. It does **not**
  make the incident a non-event, because SMR holds the key.
- **Encryption safe harbour:** PHI encrypted to HHS/NIST standards is not
  breach-triggering. Supabase encrypts at rest and all transport is TLS — but
  the safe harbour applies to *encrypted* data at rest or in flight, not to data
  read through a legitimately authenticated session. Do not over-claim it.

Record the conclusion and the reasoning **whether or not** you conclude a breach
occurred. §164.530(j) requires the documentation either way, kept six years.

### Step 4 — Notify (only if it is a breach)

| Who | When | How |
|---|---|---|
| **Affected individuals** | Without unreasonable delay, **≤60 days from discovery** | Written notice by first-class mail (or email if the individual agreed). Must state: what happened, what PHI was involved, steps individuals should take, what SMR is doing, and contact details. |
| **HHS OCR** — 500+ individuals | **≤60 days from discovery** | OCR breach portal |
| **HHS OCR** — under 500 | Annual log, **within 60 days of year end** | OCR breach portal |
| **Media** — 500+ in one state/jurisdiction | ≤60 days | Prominent local outlet |
| **State authorities** | Varies — often stricter | Check the applicable state breach law; several require faster notice than HIPAA |

If SMR is acting as a **Business Associate** to another covered entity for any
of this data, notify that covered entity without unreasonable delay and no later
than 60 days — they carry the individual-notification duty.

### Step 5 — Fix and learn

1. Close the root cause — not just the symptom.
2. Add or amend a control; update [02-risk-analysis](02-risk-analysis.md).
3. Retrain if human error contributed; record it in [05](05-workforce-training.md).
4. Complete the incident record below.

## 4. Incident record

Keep **six years**. One entry per incident, including ones that turned out not
to be breaches.

```
Incident ID:            INC-YYYY-NN
Discovered:             date/time · discovered by
Reported to SO:         date/time
Description:            what happened
Systems affected:       dashboard / Supabase / Striven / QuickBooks / device
PHI involved:           fields, and roughly how many individuals
Containment:            actions taken, with timestamps
Four-factor assessment: 1) 2) 3) 4)
Conclusion:             BREACH / NOT A BREACH — reasoning
Notifications:          who, when, how (or "none required — why")
Root cause:             
Corrective action:      owner, due date, completion date
Closed:                 date · by
```

### Log
| ID | Date | Summary | Breach? | Closed |
|---|---|---|---|---|
| *(none to date)* | | | | |

## 5. Plan testing

Walk through one tabletop scenario annually — recommended first scenario:
*"crystal@ reports her laptop was stolen from a car, unlocked, with the
dashboard open."* Time the response, find who cannot be reached, fix the gaps.
Record the exercise date and lessons here.

| Date | Scenario | Participants | Lessons |
|---|---|---|---|
| *(first due by 2027-07-18)* | | | |

---
*Not legal advice. Breach determination and notification carry legal
consequence — involve counsel and a compliance professional in any real event.*
