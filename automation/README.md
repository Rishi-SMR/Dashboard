# SMR Automations

## striven-auto-po.n8n.json — Auto-PO on new Sales Order

Fixed version of the n8n workflow that raises a vendor Purchase Order automatically
when a Sales Order is created in Striven. Import into n8n (Workflows → Import from file),
re-select the two credentials (SMR Striven basic-auth, Gmail), then **Activate**.

### What was broken in the original → what this version does

1. **Trigger never fired.** Striven has no outbound webhooks, so a webhook-only
   trigger waits forever. Added a **Schedule trigger (every 5 min)** that polls
   `POST /v1/sales-orders/search`, checkpoints the highest SO id in workflow
   static data, and feeds one new SO per run into the same pipeline. The webhook
   path is kept (works if ever called manually/externally).
2. **Cloudflare 403 (error 1010).** Striven sits behind Cloudflare and rejects
   non-browser user agents — n8n's default UA is blocked. Every Striven HTTP node
   now sends a browser `User-Agent` header (same fix our striven-server uses).
3. **No idempotency.** An SO could create duplicate POs on retries/re-runs.
   Added an `Already Processed?` guard (processed SO ids in static data).
4. **Old order's data leaked onto the new PO.** The payload cloned the previous
   PO wholesale — including the *previous patient's* drop-ship customer and
   custom fields. Now: drop-ship customer is overwritten from the **current**
   sales order, `customFields` are stripped, and the PO title/memo reference the
   current SO number (this also keeps the dashboard's Order-Tracking chain intact).
5. **One bad line killed the whole run.** Code-node `throw`s aborted everything.
   The fragile chain (`Get Previous PO Detail` → … → `Download PO PDF`) now has
   error outputs wired to an **Automation Error Alert** email and returns to the
   line loop, so the remaining lines still process.
6. **PDF was never attached.** The Gmail attachment had an empty binary mapping;
   it now binds the downloaded PDF (`data`).
7. **Retry back-off** on the PO search was 5×60s (runs hung for minutes); now 3×5s.

### Pilot mode (DEMO/test patients only)

A `DEMO Only Gate (PILOT)` IF-node sits after the SO fetch: only sales orders whose
type/name/customer contains "demo" or "test" continue. **Go-live:** delete that
node (or reconnect its False output to `Extract Sales Order Lines1`).

### Still intentionally test-mode

- `Email Vendor with Gmail1` sends to the internal inbox, not the vendor. For
  live, change `sendTo` to `={{ $('Select Vendor Contact1').item.json.vendorEmail }}`.
- Vendor choice = "same vendor as the last PO for this item". Items with no
  prior PO only alert (by design). A real item→vendor mapping table can replace
  this later.

### Test procedure

1. Import + activate. First poll run only baselines the checkpoint (no POs).
2. Create a DEMO-patient Sales Order in Striven.
3. Within ~5 min the workflow should: create the PO (status In Progress),
   download its PDF, and email the PO (internal inbox) — or send a
   no-previous-PO / error alert.
4. Verify in the dashboard: Order Tracking shows the SO with its new PO linked.
