import { useEffect, useRef, useState } from 'react';
import { fetchPiStages, type PiStages, type PiStageName, type PiStageOrder, type PiBoard } from '../strivenApi';
import { SoLink } from './SoLink';
import { formatCurrency } from '../format';
import { C } from '../chartTheme';
import { DeviceChips } from './DeviceChips';
import { TrackingCell } from './TrackingCell';
import { ColumnFilter, SortHead } from './ColumnFilter';
import { downloadXlsx, printToPdf, stamped, type Sheet } from '../export';

// Cool → warm across the pipeline, so position reads as progress at a glance.
// Colour per stage, for BOTH boards. The keys had drifted from the real stage
// names ('Awaiting LOP', 'Dispensed', 'Shipped' no longer exist), so every card
// was falling through to undefined and rendering an uncoloured rule.
const STAGE_C: Record<string, string> = {
  // PI
  'Order received': '#64748B',
  'LOP requested': '#D97706',
  'Dispense/Shipped': '#0A369F',
  Delivered: '#0891B2',
  'Waiting for first payment': '#7C3AED',
  'Waiting for settlement': '#16A34A',
  // PIP — three stages. No LOP and no settlement: the bill goes to the auto
  // insurer and is either outstanding or settled.
  'Waiting on PIP Payment': '#7C3AED',
  'Bill settled': '#16A34A',
  // VA — four stages. 'Order received' and 'Delivered' are shared with PI
  // above; only the two that name the VA's own money need entries. The wait and
  // the terminal stage take the same purple/green as their PI and PIP
  // counterparts, so "waiting on the payer" and "money in" read identically
  // whichever board you are on.
  'Waiting on VA payment': '#7C3AED',
  Paid: '#16A34A',
};
const stageColor = (s: string) => STAGE_C[s] || '#64748B';
// Days in a stage past which a row is worth chasing.
const STALE_DAYS = 14;

// STAGES ARE READ-ONLY. They come from Striven and are re-read on every load,
// so there is nothing to pick: a dropdown would offer a choice the next refresh
// silently overwrites. Each row states where its stage came from instead of
// pretending it can be set here. Shared with the Excel export so the file and
// the screen use the same wording.
const SOURCE_TEXT: Record<string, { label: string; title: string }> = {
  labels: { label: 'Striven labels', title: "Set by this order's labels in Striven. Change the label there and it follows on the next refresh." },
  striven: { label: 'Striven stage field', title: 'Read from the Stage custom field on the sales order in Striven.' },
  portal: { label: 'Portal (legacy)', title: 'Set by hand in the portal before stages were read from Striven. Any Striven label supersedes it.' },
  default: { label: 'No label yet', title: 'Striven carries no stage label on this order, so it sits at stage 1, where every sales order starts.' },
};
const sourceOf = (s: string) => SOURCE_TEXT[s] ?? SOURCE_TEXT.default;

// Sentinel option in the label filter for orders Striven has not tagged. The
// parentheses keep it from colliding with a real label, which never has them.
const NO_LABEL = '(no label)';
type SortKey = 'ref' | 'account' | 'devices' | 'units' | 'revenue' | 'days' | 'tracking';

// Which SIDEBAR ENTRY mounted this component, and therefore which programme's
// boards it shows. One implementation, because the ageing, the label folding,
// the drill table and the exports are identical across programmes — only the
// stage list and the wording differ, and both of those come from the server.
export type PipelineKind = 'PI' | 'VA';
/** The boards each entry owns. 'REVIEW' is not a programme — see below. */
const BOARDS_OF: Record<PipelineKind, PiBoard[]> = { PI: ['PI', 'PIP'], VA: ['VA'] };

// ── Personal Injury / VA pipelines ───────────────────────────────────────────
// Striven only carries In Progress / Completed / Canceled / Incomplete, so the
// operational stages are derived from each order's Striven LABELS instead. Every
// portal move is recorded, which is what makes "how long has this been sitting"
// a real measurement rather than a guess.
export function PiPipeline({ viewAs, kind = 'PI' }: { viewAs?: string | null; kind?: PipelineKind }) {
  const [data, setData] = useState<PiStages | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<PiStageName | null>(null);
  // Which pipeline is on screen. The PI entry opens on PI and can switch to
  // PIP; the VA entry has one board and opens on it.
  // 'REVIEW' is not a pipeline: it is the queue of orders carrying a label that
  // places them in no stage. It rides on the same switch because it is the same
  // book seen a different way, and because a tab is where someone will actually
  // look for it.
  const [board, setBoard] = useState<PiBoard | 'REVIEW'>(kind === 'VA' ? 'VA' : 'PI');
  // A stage name from one board means nothing on the other, so switching boards
  // closes any open stage rather than leaving a drawer that matches nothing.
  useEffect(() => { setOpen(null); }, [board]);
  // Per-stage table controls. Cleared whenever a different stage is opened, so
  // filters never silently carry over and make a stage look empty.
  const [query, setQuery] = useState('');
  const [pickAcct, setPickAcct] = useState<Set<string>>(new Set());
  const [pickDev, setPickDev] = useState<Set<string>>(new Set());
  const [pickLabel, setPickLabel] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'days', dir: 'asc' });
  useEffect(() => { setQuery(''); setPickAcct(new Set()); setPickDev(new Set()); setPickLabel(new Set()); }, [open]);

  async function load(silent = false) {
    if (!silent) { setLoading(true); setError(null); }
    try { setData(await fetchPiStages(viewAs)); }
    catch (e) { if (!silent) setError(e instanceof Error ? e.message : 'Failed to load the pipeline.'); }
    finally { if (!silent) setLoading(false); }
  }
  useEffect(() => { load(); }, [viewAs]);

  // WHICH BOARD. The three are separate pipelines with different stages: a PIP
  // order never reaches Lienstar, so it has no LOP and no settlement step, and a
  // VA order has neither of those nor an attorney but does have a terminal
  // 'Paid'. Selecting a board swaps both the stage cards and the orders behind
  // them.
  const pipCount = (data?.pipOrders ?? []).length;
  const vaCount = (data?.vaOrders ?? []).length;
  const stages = board === 'VA' ? (data?.vaStages ?? []) : board === 'PIP' ? (data?.pipStages ?? []) : (data?.stages ?? []);
  const boardOrders = board === 'VA' ? (data?.vaOrders ?? []) : board === 'PIP' ? (data?.pipOrders ?? []) : (data?.orders ?? []);
  // Every order this ENTRY is responsible for, across its boards. The review
  // queue and the empty-state counts are scoped to it, so the VA page never
  // reports a PI mapping gap as its own and vice versa.
  const myBoards = BOARDS_OF[kind];
  const myOrders = [...(data?.orders ?? []), ...(data?.pipOrders ?? []), ...(data?.vaOrders ?? [])]
    .filter((o) => myBoards.includes(o.pipeline ?? 'PI'));
  // Server-side and admin-only: a rep receives empty arrays, so the tab never
  // appears for them rather than appearing and reading zero.
  const reviewOrders = (data?.reviewOrders ?? []).filter((o) => myBoards.includes(o.pipeline ?? 'PI'));
  // REBUILT from the scoped orders rather than filtered from the server's list.
  // A label's server-side `count` spans every board it appears on — HOLD sits on
  // both PI and VA — so filtering would keep the row and its whole-book number,
  // and this page would claim orders it does not show.
  const reviewLabels = (() => {
    const m = new Map<string, { label: string; reason: 'flagged' | 'unknown'; count: number; boards: Set<PiBoard> }>();
    const add = (label: string, reason: 'flagged' | 'unknown', b: PiBoard) => {
      const k = label.trim().toLowerCase();
      const e = m.get(k) ?? { label, reason, count: 0, boards: new Set<PiBoard>() };
      e.count += 1; e.boards.add(b); m.set(k, e);
    };
    for (const o of reviewOrders) {
      const b = o.pipeline ?? 'PI';
      for (const l of o.flagged ?? []) add(l, 'flagged', b);
      for (const l of o.unknown ?? []) add(l, 'unknown', b);
    }
    return [...m.values()]
      .map((e) => ({ label: e.label, reason: e.reason, count: e.count, boards: [...e.boards].sort() }))
      // Unmapped labels first: those are a defect. A flagged one is working as
      // intended and is only a case to chase.
      .sort((a, b) => (a.reason === b.reason ? 0 : a.reason === 'unknown' ? -1 : 1)
        || b.count - a.count || a.label.localeCompare(b.label));
  })();
  const canReview = Boolean(data && data.scopedToRep === null);
  // An unmapped label is a defect; a stalled case is expected work. The counts
  // are kept apart so the tab can say which it is rather than alarming on both.
  const unknownCount = reviewLabels.filter((l) => l.reason === 'unknown').length;
  // The DISTINCT order count. Summing the stage counts would over-count now
  // that an order is listed at every stage its labels attest to.
  const total = boardOrders.length;
  // Orders listed at more than one stage — what makes the card counts overlap.
  const multi = boardOrders.filter((o) => (o.stages?.length ?? 1) > 1).length;
  const byLabel = boardOrders.filter((o) => o.source === 'labels').length;
  // Membership, not current position: an order tagged "Shipped, Waiting for
  // first payment" opens under BOTH stages, which is the point — whoever works
  // the dispatch stage needs to see that it shipped.
  const inStage = open ? boardOrders.filter((o) => (o.stages ?? [o.stage]).includes(open)) : [];

  // Options are built from the orders IN THIS STAGE, so the pickers only ever
  // offer values that can actually match.
  const acctOpts = (() => {
    const m = new Map<string, number>();
    for (const o of inStage) m.set(o.account, (m.get(o.account) ?? 0) + 1);
    return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  })();
  const devOpts = (() => {
    const m = new Map<string, number>();
    for (const o of inStage) for (const d of o.devices) m.set(d.item, (m.get(d.item) ?? 0) + d.qty);
    return [...m.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
  })();
  // Counted by ORDER, not by tag: an order carries a label once, so "Shipped 2"
  // means two orders — the same unit the stage count is in.
  const labelOpts = (() => {
    const m = new Map<string, number>();
    let bare = 0;
    for (const o of inStage) {
      const ls = o.labels ?? [];
      if (ls.length === 0) { bare += 1; continue; }
      for (const l of ls) m.set(l, (m.get(l) ?? 0) + 1);
    }
    const opts = [...m.entries()].map(([value, count]) => ({ value, count }))
      .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    // Untagged orders are the ones worth chasing, and no real label can select
    // them — so they get an entry of their own, pinned last.
    return bare > 0 ? [...opts, { value: NO_LABEL, count: bare }] : opts;
  })();

  const openOrders = (() => {
    const q = query.trim().toLowerCase();
    const rows = inStage.filter((o) =>
      (pickAcct.size === 0 || pickAcct.has(o.account))
      && (pickDev.size === 0 || o.devices.some((d) => pickDev.has(d.item)))
      // An order carries several labels at once, so this is ANY-of, like the
      // device filter — picking "Shipped" keeps an order tagged Shipped AND
      // Waiting on PIP Payment, which is the one you were looking for.
      && (pickLabel.size === 0
        || (o.labels ?? []).some((l) => pickLabel.has(l))
        || (pickLabel.has(NO_LABEL) && (o.labels ?? []).length === 0))
      && (!q
        || o.ref.toLowerCase().includes(q)
        || o.account.toLowerCase().includes(q)
        // Labels are searchable too: typing one and not finding it would be a
        // fair reason to think the filter was broken.
        || (o.labels ?? []).some((l) => l.toLowerCase().includes(q))
        // A pasted tracking number has to find its order: that is the lookup
        // someone does when a carrier or a patient quotes one at them.
        || (o.tracking ?? '').toLowerCase().includes(q)
        || o.devices.some((d) => d.item.toLowerCase().includes(q))));
    const { key, dir } = sort;
    const val = (o: PiStageOrder) =>
      key === 'account' ? o.account.toLowerCase()
        : key === 'ref' ? o.ref.toLowerCase()
          // TRACKED-OR-NOT, not the serial itself. Most rows are blank, and
          // sorting alphabetically on a carrier's serial orders nothing anyone
          // asks for; "which of these can I actually chase" does.
          : key === 'tracking' ? (o.tracking ? 1 : 0)
            : key === 'devices' ? o.devices.length
              : key === 'units' ? o.units
                : key === 'revenue' ? o.revenue
                  : (o.daysInStage ?? 0);
    return [...rows].sort((x, y) => {
      const A = val(x), B = val(y);
      const c = typeof A === 'string' ? A.localeCompare(String(B)) : (A as number) - (B as number);
      return dir === 'asc' ? c : -c;
    });
  })();
  const sortBy = (key: SortKey) =>
    setSort((s) => ({ key, dir: s.key === key ? (s.dir === 'asc' ? 'desc' : 'asc') : (key === 'account' || key === 'ref' ? 'asc' : 'desc') }));
  const filtersOn = Boolean(query) || pickAcct.size > 0 || pickDev.size > 0 || pickLabel.size > 0;
  const resetFilters = () => { setQuery(''); setPickAcct(new Set()); setPickDev(new Set()); setPickLabel(new Set()); };

  // ── download the open stage ────────────────────────────────────────────────
  // Scoped to the drill panel so "Save as PDF" prints the table on screen and
  // not the whole pipeline page behind it.
  const printRef = useRef<HTMLDivElement>(null);

  /**
   * The rows AS FILTERED AND SORTED on screen, not the whole stage. Exporting
   * the unfiltered set would silently disagree with the table the reader is
   * looking at, and the header row records the filters so a saved file can be
   * accounted for later.
   */
  function exportExcel() {
    if (!open) return;
    const money = (n: number) => (Number.isFinite(n) ? Number(n.toFixed(2)) : 0);
    const scope = [
      `${board} pipeline`,
      open,
      filtersOn ? `filtered: ${openOrders.length} of ${inStage.length}` : `all ${inStage.length}`,
      data?.scopedToRep ? `rep: ${data.scopedToRep}` : 'all reps',
    ].join(' · ');

    const sheet: Sheet = {
      name: 'Stage orders',
      rows: [
        [scope],
        [],
        // Units/revenue stay NUMERIC so Excel can total them; formatCurrency
        // would ship "$1,599" as text and break every sum in the file.
        ['Order', 'Patient (initial + surname)', 'Tracking #', 'Carrier', 'Striven labels', 'Current stage', 'Listed at stages', 'Account', 'Devices', 'Units', 'Revenue', 'Days in stage', 'Ageing', 'Stage set by'],
        ...openOrders.map((o) => [
          o.ref,
          o.patient || '',
          // Text, not a number: a 22-digit USPS number would otherwise land in
          // Excel as 9.33462E+21 and lose its last digits — unusable for the
          // one thing anyone does with it, which is paste it into a carrier site.
          o.tracking || '',
          // Striven's own Ship Via, not a carrier guessed from the number: the
          // file is read away from the portal, so a wrong carrier in it cannot
          // be checked against anything.
          o.shipVia || '',
          (o.labels ?? []).join(', '),
          // Both, because a row can appear in more than one stage's file: without
          // the current stage a reader cannot tell a live order from one that has
          // already moved past this stage.
          o.stage,
          (o.stages ?? [o.stage]).join(', '),
          o.account,
          o.devices.map((d) => `${d.item} ×${d.qty}`).join(', '),
          o.units,
          money(o.revenue),
          o.daysInStage ?? '',
          o.estimated ? 'estimated (from order date)' : 'measured (from the move)',
          sourceOf(o.source).label,
        ]),
        [],
        // Padded to the header's own column positions. Units and Revenue are
        // columns 10 and 11 since Tracking # and Carrier were inserted at 3-4;
        // this row must be re-counted whenever a column is added, or the totals
        // land under the wrong heading — a wrong number in a right-looking place.
        ['Total', '', '', '', '', '', '', '', '',
          openOrders.reduce((s, o) => s + o.units, 0),
          money(openOrders.reduce((s, o) => s + o.revenue, 0))],
      ],
    };
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    downloadXlsx([sheet], stamped(`smr-${slug(board)}-${slug(open)}`, 'xlsx'));
  }

  return (
    <div>
      <div className="section-head" style={{ marginBottom: 10, alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
        <div>
          <h2 className="section-title">
            {board === 'REVIEW' ? 'Labels to review'
              : board === 'VA' ? 'VA pipeline'
                : board === 'PIP' ? 'PIP pipeline' : 'Personal Injury pipeline'}
          </h2>
          <div className="section-sub">
            {board === 'VA' ? (
              <>
                {total} VA order{total === 1 ? '' : 's'}. Billed to the Department of Veterans Affairs and paid in full off the
                invoice — no attorney, no lien and no settlement, so this board has none of the PI board's chasing stages. It does
                have a terminal <b>Paid</b> stage, which PI does not: most of the VA book has already been paid, and a stage named
                for waiting would be the wrong place to put it.
              </>
            ) : board === 'REVIEW' ? (
              <>
                Orders whose labels place them in no stage. Two kinds: <b>exceptions</b> — HOLD, Attorney Denied, Case Dropped —
                which say an order has stopped rather than progressed and are cases to chase; and <b>unrecognised</b> labels,
                which nobody has mapped yet, so they count for nothing and their order silently falls back to stage 1.
              </>
            ) : board === 'PIP' ? (
              <>
                {total} PIP order{total === 1 ? '' : 's'}. A PIP order never goes to Lienstar: it is billed through the
                customer to the auto insurer at the full billed amount and paid in full — no advance, no settlement.
                {pipCount === 0 && <> Nothing here yet: the PIP order type is still being created in Striven, and orders will appear as soon as it exists.</>}
              </>
            ) : (
              <>
                {total} PI order{total === 1 ? '' : 's'}. Click a stage to see its orders. An order is listed at every stage its Striven labels attest to, so one can appear on more than one card.
                {data && data.trackedCount < total && (
                  <> Ageing is measured from the first time an order is moved: <b>{total - data.trackedCount}</b> {total - data.trackedCount === 1 ? 'order has' : 'orders have'} never
                  been moved, so {total - data.trackedCount === 1 ? 'its' : 'their'} age falls back to the order date and is marked <i>est.</i></>
                )}
              </>
            )}
          </div>
        </div>
        {/* Board switch. PIP shows its count even at zero, so the tab reads as
            "built and empty" rather than as missing. The VA entry owns one
            board, so it gets one tab — kept rather than dropped so the count and
            the Review tab beside it sit where they do on the PI page. */}
        <div className="ins-qtabs">
          {kind === 'VA' ? (
            <button className={`ins-qtab${board === 'VA' ? ' on' : ''}`} onClick={() => setBoard('VA')}>
              VA · {vaCount}
            </button>
          ) : (
            <>
              <button className={`ins-qtab${board === 'PI' ? ' on' : ''}`} onClick={() => setBoard('PI')}>
                PI · {(data?.orders ?? []).length}
              </button>
              <button className={`ins-qtab${board === 'PIP' ? ' on' : ''}`} onClick={() => setBoard('PIP')}>
                PIP · {pipCount}
              </button>
            </>
          )}
          {/* Shown at zero as well, deliberately: an empty queue is the useful
              answer ("nothing has drifted"), and a tab that only exists when
              something is wrong is a tab nobody knows to look for. Carries a
              dot when it is NOT empty, so it reads at a glance. */}
          {canReview && (
            <button className={`ins-qtab${board === 'REVIEW' ? ' on' : ''}`} onClick={() => setBoard('REVIEW')}
              title={reviewOrders.length === 0
                ? 'Nothing stalled and no unrecognised labels.'
                : `${reviewLabels.length} label${reviewLabels.length === 1 ? '' : 's'} carrying no stage, on ${reviewOrders.length} order${reviewOrders.length === 1 ? '' : 's'}`}>
              {/* Red only for an unmapped label — that is a defect. A stalled
                  case is expected work, so it gets the neutral warning colour
                  and does not cry wolf. */}
              {reviewOrders.length > 0 && (
                <span aria-hidden="true" style={{ display: 'inline-block', width: 7, height: 7, borderRadius: 999, background: unknownCount > 0 ? C.negative : '#D97706', marginRight: 6, verticalAlign: 'middle' }} />
              )}
              Review · {reviewOrders.length}
            </button>
          )}
        </div>
      </div>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}
      {loading && !data && <div className="page-sub" style={{ padding: 16 }}>Loading…</div>}

      {/* stage cards: count, ageing and revenue per stage */}
      {board !== 'REVIEW' && (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(178px, 1fr))', gap: 12, marginBottom: 14 }}>
        {stages.map((s, i) => {
          const active = open === s.stage;
          return (
            <button key={s.stage} onClick={() => setOpen(active ? null : s.stage)}
              title={`${s.count} order${s.count === 1 ? '' : 's'} listed here${(s.current ?? s.count) !== s.count ? `, ${s.current} sitting here now` : ''}: click to ${active ? 'hide' : 'list'} them`}
              style={{
                textAlign: 'left', cursor: 'pointer', background: 'var(--panel)', borderRadius: 12, padding: '14px 16px',
                border: `1px solid ${active ? stageColor(s.stage) : 'var(--panel-2)'}`,
                boxShadow: active ? `0 0 0 3px ${stageColor(s.stage)}22` : 'none', position: 'relative', overflow: 'hidden',
              }}>
              <span style={{ position: 'absolute', inset: '0 auto 0 0', width: 3, background: stageColor(s.stage) }} />
              <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: C.muted }}>
                Stage {i + 1}
              </div>
              <div style={{ fontSize: 13, fontWeight: 700, color: stageColor(s.stage), marginTop: 2 }}>{s.stage}</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: C.ink, marginTop: 4, letterSpacing: -0.5 }}>{s.count}</div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                {s.count === 0 ? 'nothing here' : <>avg {s.avgDays}d · oldest {s.oldestDays}d</>}
              </div>
              {/* The big number counts everything LISTED here, which includes
                  orders that have since moved on. Naming how many are actually
                  sitting here keeps the card from reading as a backlog. */}
              {s.count > 0 && (s.current ?? s.count) !== s.count && (
                <div style={{ fontSize: 11.5, color: C.muted, marginTop: 2 }}>
                  <b style={{ color: C.sub }}>{s.current}</b> here now · {s.count - (s.current ?? 0)} moved on
                </div>
              )}
              {s.revenue > 0 && <div style={{ fontSize: 12, color: C.sub, fontWeight: 600, marginTop: 3 }}>{formatCurrency(s.revenue)}</div>}
            </button>
          );
        })}
      </div>
      )}

      {/* Flow bar: share of the pipeline sitting at each stage.
          USES `current`, NOT `count`. The cards list an order at every stage its
          labels attest to, so those counts overlap; a bar built from them would
          run past 100% and each slice would misstate its share. `current` is an
          order's one position, so the slices still add up to the board. */}
      {board !== 'REVIEW' && total > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', height: 12, borderRadius: 999, overflow: 'hidden', background: 'var(--panel-2)' }}>
            {stages.filter((s) => (s.current ?? s.count) > 0).map((s) => (
              <div key={s.stage} title={`${s.stage}: ${s.current ?? s.count} here now`} onClick={() => setOpen(open === s.stage ? null : s.stage)}
                style={{ width: `${((s.current ?? s.count) / total) * 100}%`, background: stageColor(s.stage), cursor: 'pointer' }} />
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 8, fontSize: 12, color: C.sub }}>
            {stages.filter((s) => (s.current ?? s.count) > 0).map((s) => (
              <span key={s.stage} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: stageColor(s.stage) }} />
                {s.stage} {Math.round(((s.current ?? s.count) / total) * 100)}%
              </span>
            ))}
          </div>
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 6 }}>
            Where each order sits <b>now</b>, so these add up to {total}.
            {multi > 0 && <> The cards above count an order at every stage its labels attest to, so {multi} {multi === 1 ? 'order appears' : 'orders appear'} on more than one card and those counts overlap.</>}
          </div>
        </div>
      )}

      {/* ── REVIEW QUEUE ───────────────────────────────────────────────────
          The worklist is per LABEL, not per order: mapping a label once fixes
          every order carrying it, so the labels lead and the orders follow as
          evidence. */}
      {board === 'REVIEW' && (
        reviewOrders.length === 0 ? (
          <div className="section chart-card" style={{ padding: 22, textAlign: 'center' }}>
            <div style={{ fontSize: 30, marginBottom: 6 }}>✓</div>
            <div style={{ fontWeight: 700, color: C.ink }}>Nothing to review.</div>
            <div className="section-sub" style={{ marginTop: 4 }}>
              No order is on hold, denied or dropped, and all {new Set(myOrders.flatMap((o) => o.labels ?? [])).size} distinct
              Striven labels on {myBoards.join(' + ')} resolve to a stage. Anything new will appear here.
            </div>
          </div>
        ) : (
          <>
            <div className="section chart-card" style={{ marginBottom: 14 }}>
              <div className="section-head"><div>
                <h2 className="section-title">
                  {reviewLabels.length} label{reviewLabels.length === 1 ? '' : 's'} carrying no stage
                </h2>
                <div className="section-sub">
                  Unrecognised labels first — those are a mapping gap. Exceptions below them are working as intended and are cases to chase.
                </div>
              </div></div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr>
                    <th>Label</th><th>Why it is here</th><th>Board</th><th className="num">Orders</th><th>What it means</th>
                  </tr></thead>
                  <tbody>
                    {reviewLabels.map((l) => {
                      const bad = l.reason === 'unknown';
                      return (
                        <tr key={l.label}>
                          <td>
                            <span className="pi-label" title={l.label} style={{ ['--lc' as string]: bad ? C.negative : '#D97706' }}>{l.label}</span>
                          </td>
                          <td style={{ fontSize: 12.5, fontWeight: 600, color: bad ? C.negative : '#D97706', whiteSpace: 'nowrap' }}>
                            {bad ? 'Not mapped' : 'Exception'}
                          </td>
                          <td style={{ fontSize: 12.5 }}>{l.boards.join(' + ')}</td>
                          <td className="num" style={{ fontWeight: 700 }}>{l.count}</td>
                          <td style={{ fontSize: 12.5, color: C.muted }}>
                            {bad
                              ? 'Nobody has mapped this label, so it counts for nothing — map it to a stage.'
                              : 'The order has stopped rather than progressed, so it holds no stage by design.'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="section chart-card">
              <div className="section-head"><div>
                <h2 className="section-title">
                  {reviewOrders.length} order{reviewOrders.length === 1 ? '' : 's'} affected
                </h2>
                <div className="section-sub">Newest first. The label that put the order here is marked; the rest are shown for context.</div>
              </div></div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr>
                    <th>Order</th><th>Patient</th><th>Striven labels</th><th>Board</th>
                    <th>Sitting in</th><th>Account</th><th className="num">Revenue</th>
                  </tr></thead>
                  <tbody>
                    {reviewOrders.map((o) => {
                      const bad = new Set((o.unknown ?? []).map((l) => l.toLowerCase()));
                      const flag = new Set((o.flagged ?? []).map((l) => l.toLowerCase()));
                      // An order held ONLY by an exception has nothing else to
                      // place it, so it is parked at stage 1 rather than being
                      // anywhere real. Worth saying, because the stage column
                      // otherwise reads as genuine progress.
                      // Stage 1 of the order's OWN board — reading it off the PI
                      // stage list would be a coincidence on VA and a bug the
                      // day either list changes its first entry.
                      const firstStage = ((o.pipeline === 'VA' ? data?.vaStageNames
                        : o.pipeline === 'PIP' ? data?.pipStageNames
                          : data?.stageNames) ?? [])[0];
                      const parked = (o.stages ?? [o.stage]).length === 1 && o.stage === firstStage
                        && (o.labels ?? []).every((l) => bad.has(l.toLowerCase()) || flag.has(l.toLowerCase()));
                      return (
                        <tr key={`${o.pipeline}-${o.soId}`}>
                          {/* Was brand-blue at weight 600 and inert — the exact
                              "looks like a link, is not one" case SoLink was
                              written for. `scopedToRep === null` is the admin
                              view, the same test `canReview` uses: a rep has no
                              Striven login, so the jump is offered to nobody
                              else. */}
                          <td><SoLink soId={o.soId} label={o.ref} canOpenInStriven={data?.scopedToRep === null} /></td>
                          <td style={{ fontWeight: 600 }}>{o.patient || <span style={{ color: C.muted, fontWeight: 400 }}>-</span>}</td>
                          <td>
                            <span className="pi-labels">
                              {(o.labels ?? []).map((l) => {
                                const k = l.toLowerCase();
                                const isBad = bad.has(k);
                                const isFlag = flag.has(k);
                                return (
                                  <span key={l} className="pi-label"
                                    title={isBad ? `"${l}" is not mapped to any stage`
                                      : isFlag ? `"${l}" is an exception: the order has stopped, so it carries no stage`
                                        : l}
                                    style={{ ['--lc' as string]: isBad ? C.negative : isFlag ? '#D97706' : stageColor(o.stage), fontWeight: isBad || isFlag ? 800 : undefined }}>
                                    {isBad ? '⚠ ' : isFlag ? '● ' : ''}{l}
                                  </span>
                                );
                              })}
                            </span>
                          </td>
                          <td style={{ fontSize: 12.5 }}>{o.pipeline}</td>
                          <td style={{ fontSize: 12.5, color: stageColor(o.stage) }}>
                            {o.stage}
                            {parked && <div style={{ fontSize: 10.5, color: C.muted }}>parked: no other label</div>}
                          </td>
                          <td style={{ fontSize: 12.5 }}>{o.account}</td>
                          <td className="num" style={{ fontWeight: 700 }}>{formatCurrency(o.revenue)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: 11.5, color: C.muted, marginTop: 8 }}>
                🔒 Patient shown as first INITIAL + surname. An order still appears on its board wherever its other labels place it —
                only its exception label carries no stage. Exceptions are listed in <b>REVIEW_LABELS</b>, mappings in{' '}
                {kind === 'VA' ? <b>VA_LABEL_STAGE</b> : <><b>PI_LABEL_STAGE</b> / <b>PIP_LABEL_STAGE</b></>};
                a backend restart is needed after either changes.
              </div>
            </div>
          </>
        )
      )}

      {/* the orders in the clicked stage */}
      {board !== 'REVIEW' && open && (
        <div className="section chart-card" ref={printRef}>
          <div className="section-head"><div>
            <h2 className="section-title" style={{ color: stageColor(open) }}>
              {open} · {openOrders.length === inStage.length ? `${inStage.length}` : `${openOrders.length} of ${inStage.length}`} order{inStage.length === 1 ? '' : 's'}
            </h2>
            <div className="section-sub">
              Newest first: the most recent arrivals at the top, then in ascending order of time in stage.
              Anything past {STALE_DAYS} days is still flagged in red wherever it sits.
            </div>
          </div>
          {/* Search and the export/close buttons are controls, not content:
              `no-print` keeps them off the PDF. */}
          <div className="no-print" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginLeft: 'auto' }}>
            <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
              <span aria-hidden="true" style={{ position: 'absolute', left: 9, fontSize: 12, color: C.muted, pointerEvents: 'none' }}>⌕</span>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search order, tracking #, label, account, device" aria-label="Search this stage"
                style={{ padding: '6px 26px 6px 24px', borderRadius: 8, border: `1px solid ${C.muted}44`, background: 'var(--panel-2)', color: C.ink, fontSize: 12.5, width: 230 }} />
              {query && (
                <button onClick={() => setQuery('')} aria-label="Clear search" title="Clear"
                  style={{ position: 'absolute', right: 6, border: 'none', background: 'transparent', color: C.muted, cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>×</button>
              )}
            </div>
            {filtersOn && <button className="btn ghost" style={{ fontSize: 12.5 }} onClick={resetFilters}>Reset</button>}
            {/* Downloads what is ON SCREEN — the filters and sort are carried
                into the file, so it can never disagree with the table above. */}
            <button className="btn ghost" style={{ fontSize: 12.5 }} onClick={exportExcel} disabled={openOrders.length === 0}
              title="Download these orders as an Excel workbook. Units and revenue stay numeric so they total in Excel.">
              ⤓ Excel
            </button>
            <button className="btn ghost" style={{ fontSize: 12.5 }} onClick={() => printToPdf(printRef.current)} disabled={openOrders.length === 0}
              title="Open the print dialog: choose “Save as PDF” for a PDF of this table, label chips included">
              ⎙ PDF
            </button>
            <button className="btn ghost" onClick={() => setOpen(null)}>Close</button>
          </div>
          </div>
          <div className="table-wrap">
            <table className="data-table pi-stage-table">
              <thead><tr>
                <SortHead label="Order" col="ref" sort={sort} onSort={sortBy} />
                <th>Patient</th>
                {/* Sortable, and the sort deliberately puts the orders that
                    HAVE a number first — most rows are blank, so the useful
                    operation is "show me the ones I can chase", not alphabetical
                    order on a carrier's serial.
                    THE COUNT IS NOT DECORATION. The default sort is newest in
                    stage first, and the newest orders are the least likely to
                    have shipped — so the first screenful is usually all dashes
                    and reads as a broken feed. Saying "6 of 64" states that the
                    column is working and the numbers are simply not in Striven
                    yet, and it doubles as a prompt to sort by this column. */}
                <SortHead label="Tracking #" col="tracking" sort={sort} onSort={sortBy}>
                  {(() => {
                    const n = openOrders.filter((o) => (o.shipments ?? []).length > 0).length;
                    return (
                      <span title={n === 0
                        ? 'No order shown here carries a tracking number in Striven'
                        : `${n} of these ${openOrders.length} orders carry a tracking number. Click to bring them to the top.`}
                        style={{ marginLeft: 6, fontSize: 10, fontWeight: 600, color: C.muted, fontVariantNumeric: 'tabular-nums' }}>
                        {n}/{openOrders.length}
                      </span>
                    );
                  })()}
                </SortHead>
                {/* Not sortable — an order carries a SET of labels, so there is
                    no single value to order rows by. Filtering is the operation
                    that makes sense on it. */}
                <th style={{ whiteSpace: 'nowrap' }}>
                  Striven labels
                  <ColumnFilter label="Label" options={labelOpts} picked={pickLabel} onChange={setPickLabel} />
                </th>
                <SortHead label="Account" col="account" sort={sort} onSort={sortBy}>
                  <ColumnFilter label="Account" options={acctOpts} picked={pickAcct} onChange={setPickAcct} />
                </SortHead>
                <SortHead label="Devices" col="devices" sort={sort} onSort={sortBy}>
                  <ColumnFilter label="Device" options={devOpts} picked={pickDev} onChange={setPickDev} />
                </SortHead>
                <SortHead label="Units" col="units" sort={sort} onSort={sortBy} num />
                <SortHead label="Revenue" col="revenue" sort={sort} onSort={sortBy} num />
                <SortHead label="In stage" col="days" sort={sort} onSort={sortBy} num />
                {/* Was "Move to", when it held a dropdown. It states a fact
                    about the row now, so it is named for what it shows. */}
                <th style={{ whiteSpace: 'nowrap' }}>Stage set by</th>
              </tr></thead>
              <tbody>
                {openOrders.length === 0 && <tr><td colSpan={10} style={{ color: C.muted }}>No orders at this stage.</td></tr>}
                {openOrders.map((o) => {
                  const stale = (o.daysInStage ?? 0) >= STALE_DAYS;
                  return (
                    <tr key={o.soId}>
                      <td style={{ fontWeight: 600, color: C.brand }}>
                        <SoLink soId={o.soId} label={o.ref} canOpenInStriven={data?.scopedToRep === null} />
                        {/* This stage is in the order's past: it is listed here
                            because a label attests to it, but it has since moved
                            on. Saying where prevents the row reading as stuck. */}
                        {o.stage !== open && (
                          <div title={`Listed here from its labels; its current stage is ${o.stage}.`}
                            style={{ fontSize: 10.5, fontWeight: 600, color: stageColor(o.stage), marginTop: 2, whiteSpace: 'nowrap' }}>
                            → now {o.stage}
                          </div>
                        )}
                      </td>
                      {/* First INITIAL + surname — how a rep recognises the
                          order, since "SO-476" tells them nothing, and enough to
                          tell two patients with the same surname apart. Never a
                          full first name. */}
                      <td style={{ fontWeight: 600 }}>{o.patient || <span style={{ color: C.muted, fontWeight: 400 }}>-</span>}</td>
                      {/* Straight from Striven's own field on the sales order.
                          Blank on most rows — see TrackingCell. */}
                      <td><TrackingCell shipments={o.shipments} /></td>
                      {/* The EXACT labels Striven carries on this order, in its
                          own wording — this is what put the order in its stage,
                          so the reader can see the reasoning rather than trust
                          it. Colour follows the stage the label maps to; the
                          report returns no colour of its own, so Striven's own
                          palette cannot be reproduced until it is supplied. */}
                      <td>
                        {(o.labels ?? []).length === 0
                          ? <span style={{ color: C.muted, fontSize: 12 }}>-</span>
                          : <span className="pi-labels">
                              {(o.labels ?? []).map((l) => (
                                <span key={l} className="pi-label" title={l}
                                  style={{ ['--lc' as string]: stageColor(o.stage) }}>{l}</span>
                              ))}
                            </span>}
                      </td>
                      <td style={{ fontSize: 12.5 }}>{o.account}</td>
                      {/* Every order here is PI, so the dot would say the same
                          thing on every chip: the name alone is enough. */}
                      <td><DeviceChips devices={o.devices} /></td>
                      <td className="num">{o.units || '-'}</td>
                      <td className="num" style={{ fontWeight: 700 }}>{formatCurrency(o.revenue)}</td>
                      <td className="num" style={{ color: stale ? C.negative : C.sub, fontWeight: stale ? 700 : 400 }}>
                        {o.daysInStage == null ? '-' : `${o.daysInStage}d`}
                        {o.estimated && <span title="Never moved: measured from the order date" style={{ fontSize: 10.5, color: C.muted, marginLeft: 4 }}>est.</span>}
                      </td>
                      {/* NO DROPDOWN, ON ANY ROW. Stages are read from Striven
                          on every load, so a manual pick would save and then be
                          overwritten on the next refresh — a control that
                          appears to work and does not. The cell states where
                          the stage came from; to change it, change the label in
                          Striven. */}
                      <td>
                        <span title={sourceOf(o.source).title}
                          style={{ fontSize: 11.5, color: C.muted, fontWeight: 600, whiteSpace: 'nowrap' }}>
                          {sourceOf(o.source).label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11.5, color: C.muted, marginTop: 8 }}>
            {/* This used to read "no patient names", which stopped being true
                when the Patient column was added — and a downloaded file makes
                the claim worse, not academic. It now says what actually leaves
                the portal. */}
            🔒 Patient shown as first INITIAL + surname — no full first name, date of birth or address. A download carries the same, so treat the file as PHI.
            Stages are read from Striven and cannot be set here; “in stage” is measured from the order date, so it is marked est.
            {/* Stated outright, because a column of dashes otherwise reads as a
                broken feed. It is not: Striven simply holds a number for a small
                share of the book. */}
            {' '}Tracking # is Striven's own field on the sales order — a dash means none has been entered there, not that the order has not shipped.
          </div>
        </div>
      )}

      {/* This used to say the stages were set by hand. They are not any more —
          Striven's labels decide them — so the note now says where a stage
          comes from and how to change it. */}
      {data && board !== 'REVIEW' && (
        <div className="qb-flash warn" style={{ marginTop: 14 }}>
          ⚠️ Stages are read from each order's <b>Striven labels</b>, so they cannot be moved here — change the label in Striven and it
          follows on the next refresh. An order is listed at <b>every stage its labels attest to</b>; the furthest of them is where it counts as sitting now.
          {byLabel > 0 && <> {byLabel} of {boardOrders.length} order{boardOrders.length === 1 ? '' : 's'} on this board {byLabel === 1 ? 'is' : 'are'} set this way; the rest carry no label yet and sit in stage 1 until one is added in Striven.</>}
          {canReview && reviewOrders.length > 0 && (
            <> {reviewOrders.length} order{reviewOrders.length === 1 ? '' : 's'} carry a label that holds no
            stage{unknownCount > 0 ? `, including ${unknownCount} unrecognised label${unknownCount === 1 ? '' : 's'}` : ''} — see{' '}
            <button onClick={() => setBoard('REVIEW')} style={{ border: 'none', background: 'none', padding: 0, color: C.brand, fontWeight: 700, cursor: 'pointer', font: 'inherit' }}>Review</button>.</>
          )}
        </div>
      )}
    </div>
  );
}
