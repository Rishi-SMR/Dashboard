/**
 * Verifies the STAGE LABEL pipeline end to end, against the live reports.
 *
 * Stages are not computed here: they are read from Striven labels that arrive
 * through saved reports listed in STRIVEN_LABELS_URL. Those reports are built
 * by hand in Striven, so everything about them can change without notice — the
 * columns can be renamed, the scope narrowed, a report dropped — and each of
 * those failures is SILENT. A board whose report stopped covering it does not
 * error; it draws every order in stage 1 and looks like a slow month.
 *
 * That is what this catches. It re-derives the boards from the raw report rows
 * and compares them against what getPiStages() actually serves:
 *
 *   1. every report fetches completely (row count matches totalRecords, all
 *      pages followed) and every row carries an order identifier
 *   2. no two reports disagree about the same order
 *   3. each order's stages are exactly what its labels map to, and its current
 *      stage is the furthest of them; each board's cards sum to the board
 *   4. no patient field carries more than an initial and a surname
 *   5. rep attribution matches the report, folded through commRep()
 *
 * Run: node scripts/audit-labels.mjs   (or npm run audit:labels)
 */
const S = await import('../api/_striven.js');
const C = await import('../api/_commission-config.js');
const problems = [];
const bad = (s) => problems.push(s);

// ── 1. each report fetches completely ───────────────────────────────────────
const urls = String(await S.cfgValue('STRIVEN_LABELS_URL')).split(/[\s,]+/).filter(Boolean);
console.log('reports configured: ' + urls.length + '\n');
const reports = [];
for (let i = 0; i < urls.length; i += 1) {
  const rows = []; let next = urls[i]; let pages = 0; let total = null; let ok = true;
  while (next && pages < 25) {
    const res = await fetch(next).catch(() => null);
    if (!res || !res.ok) { ok = false; break; }
    const j = await res.json().catch(() => null);
    if (!j) { ok = false; break; }
    if (total == null) total = j.totalRecords;
    rows.push(...(Array.isArray(j.data) ? j.data : []));
    next = typeof j.nextPage === 'string' && /^https?:\/\//i.test(j.nextPage) ? j.nextPage : null;
    pages += 1;
  }
  if (!ok) bad('report #' + (i + 1) + ': fetch failed');
  if (total != null && rows.length !== total) bad('report #' + (i + 1) + ': got ' + rows.length + ' rows but totalRecords says ' + total);
  const noId = rows.filter((r) => !S.labelRowKeys(r).length).length;
  if (noId) bad('report #' + (i + 1) + ': ' + noId + ' rows carry no order identifier');
  const nums = rows.map((r) => String(r.Number ?? '').trim().toLowerCase());
  const dupes = new Set(nums.filter((n, k) => n && nums.indexOf(n) !== k));
  console.log('  #' + (i + 1) + ': ' + String(rows.length).padStart(4) + ' rows · totalRecords ' + total
    + ' · pages ' + pages + ' · no-identifier ' + noId + ' · repeated order rows ' + dupes.size);
  reports.push(rows);
}

// ── 2. the merge: do any two reports disagree about an order? ───────────────
const so = await S.sbCacheRead('so').then((b) => b?.data ?? []).catch(() => []);
const idByKey = new Map();
for (const o of (Array.isArray(so) ? so : [])) {
  for (const k of [o?.number, o?.name]) {
    const kk = String(k ?? '').trim().toLowerCase();
    if (kk && !idByKey.has(kk)) idByKey.set(kk, String(o.id));
  }
}
const seen = new Map();
for (let i = 0; i < reports.length; i += 1) {
  for (const r of reports[i]) {
    let id = null;
    for (const k of S.labelRowKeys(r)) { id = idByKey.get(k); if (id) break; }
    if (!id) { bad('report #' + (i + 1) + ': identifier "' + (S.labelRowKeys(r)[0] ?? '') + '" matches no sales order'); continue; }
    const set = S.labelRowLabels(r).map((x) => x.toLowerCase()).sort().join(' | ');
    const prev = seen.get(id) || [];
    prev.push(set);
    seen.set(id, prev);
  }
}
let conflicts = 0;
for (const [id, list] of seen) {
  const sets = [...new Set(list)];
  if (sets.length > 1) {
    conflicts += 1;
    if (conflicts <= 5) bad('order ' + id + ': reports disagree — ' + sets.join('   VS   '));
  }
}
console.log('\n  merged: ' + seen.size + ' orders resolved · reports disagreeing on an order: ' + conflicts);

// ── 3. the served payload, re-derived independently ────────────────────────
const p = await S.getPiStages({ email: 'a@t', repName: null, role: 'admin' });
const MAPS = { PI: C.PI_LABEL_STAGE, PIP: C.PIP_LABEL_STAGE, VA: C.VA_LABEL_STAGE };
const STAGES = { PI: C.PI_STAGES, PIP: C.PIP_STAGES, VA: C.VA_STAGES };
const review = new Set(C.REVIEW_LABELS.map((x) => String(x).toLowerCase()));
console.log('');
for (const [board, list] of [['PI', p.orders], ['PIP', p.pipOrders], ['VA', p.vaOrders]]) {
  const rows = list || [];
  const map = MAPS[board]; const stages = STAGES[board];
  let mismatchStages = 0; let mismatchStage = 0; const unmapped = new Set();
  for (const o of rows) {
    const labels = o.labels || [];
    const attested = stages.filter((s) => labels.some((l) => {
      const m = map[String(l).trim().toLowerCase()];
      return Array.isArray(m) ? m.includes(s) : m === s;
    }));
    for (const l of labels) {
      const k = String(l).trim().toLowerCase();
      if (!map[k] && !review.has(k)) unmapped.add(l);
    }
    if (labels.length && attested.length) {
      if (JSON.stringify(o.stages) !== JSON.stringify(attested)) {
        mismatchStages += 1;
        if (mismatchStages <= 3) bad(board + ' ' + o.ref + ': stages ' + JSON.stringify(o.stages) + ' but labels ' + JSON.stringify(labels) + ' attest to ' + JSON.stringify(attested));
      }
      const furthest = attested[attested.length - 1];
      if (o.stage !== furthest) {
        mismatchStage += 1;
        if (mismatchStage <= 3) bad(board + ' ' + o.ref + ': sits at "' + o.stage + '" but its furthest attested stage is "' + furthest + '"');
      }
    }
  }
  const buckets = (board === 'PI' ? p.stages : board === 'PIP' ? p.pipStages : p.vaStages) || [];
  const sum = buckets.reduce((s, b) => s + b.current, 0);
  if (sum !== rows.length) bad(board + ': stage cards sum to ' + sum + ' but the board holds ' + rows.length);
  for (const b of buckets) {
    const listed = rows.filter((o) => (o.stages || []).includes(b.stage)).length;
    if (b.count !== listed) bad(board + ' ' + b.stage + ': count ' + b.count + ' but ' + listed + ' orders are listed there');
    if (b.count < b.current) bad(board + ' ' + b.stage + ': listed ' + b.count + ' is fewer than standing ' + b.current);
  }
  const labelled = rows.filter((o) => (o.labels || []).length).length;
  console.log('  ' + board.padEnd(4) + String(rows.length).padStart(4) + ' orders · labelled ' + String(labelled).padStart(4)
    + ' · stage-set mismatches ' + mismatchStages + ' · current-stage mismatches ' + mismatchStage
    + ' · unmapped labels ' + (unmapped.size ? [...unmapped].join(',') : 0)
    + ' · cards sum ' + (sum === rows.length ? 'OK' : 'WRONG'));
}

// ── 4. PHI: patient names never carry a full first name ────────────────────
const allRows = [...(p.orders || []), ...(p.pipOrders || []), ...(p.vaOrders || [])];
const phi = allRows.filter((o) => String(o.patient || '').trim().split(/\s+/).length > 2);
if (phi.length) bad(phi.length + ' orders carry more than an initial and a surname');
console.log('\n  patient fields checked: ' + allRows.length + ' · violations ' + phi.length);

// ── 5. rep attribution agrees with the report ──────────────────────────────
const repByNum = new Map();
for (const rows of reports) {
  for (const r of rows) {
    const n = String(r.Number ?? '').trim().toLowerCase();
    if (n && r.SalesRepFullName) repByNum.set(n, String(r.SalesRepFullName));
  }
}
const numById = new Map((Array.isArray(so) ? so : []).map((o) => [String(o.id), String(o.number ?? '').trim().toLowerCase()]));
let repChecked = 0; let repDiff = 0;
// Compared THROUGH commRep(), which is the fold the portal itself applies: a
// sub-rep's orders are paid to the rep above them, so Striven's
// "Maylon Sanders - Denise Zavala" is Maylon's order by design and tested as
// such in _comm-rep.test.js. Comparing the raw strings would report that rule
// as three defects.
for (const o of allRows) {
  const n = numById.get(String(o.soId));
  const fromReport = n && repByNum.get(n);
  if (!fromReport || !o.rep) continue;
  repChecked += 1;
  const folded = S.commRep(fromReport);
  if (String(folded).toLowerCase() !== String(o.rep).toLowerCase()) {
    repDiff += 1;
    if (repDiff <= 6) bad(o.ref + ': portal rep "' + o.rep + '" vs report "' + fromReport + '" (folds to "' + folded + '")');
  }
}
console.log('  rep attribution compared on ' + repChecked + ' orders · disagreements ' + repDiff);

console.log(problems.length
  ? '\n' + problems.length + ' PROBLEM(S):\n  ' + problems.slice(0, 25).join('\n  ')
  : '\n✓ every check passed');
