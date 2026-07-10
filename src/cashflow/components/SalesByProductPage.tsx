import { useEffect, useMemo, useState } from 'react';
import { fetchSalesByProduct, type SalesByProductResult, type ProductRow } from '../api';
import { formatCurrency } from '../format';

const POLL_MS = 5 * 60_000;

function ymLabel(ym: string): string {
 const [y, m] = ym.split('-');
 const date = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
 return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

export function SalesByProductPage() {
 const [data, setData] = useState<SalesByProductResult | null>(null);
 const [loading, setLoading] = useState(true);
 const [error, setError] = useState<string | null>(null);
 const [expanded, setExpanded] = useState<string | null>(null);
 const [search, setSearch] = useState('');

 async function load(refresh = false) {
 setLoading(true);
 setError(null);
 try {
 const d = await fetchSalesByProduct({ refresh });
 setData(d);
 } catch (e) {
 setError(e instanceof Error ? e.message : 'Failed to load');
 } finally {
 setLoading(false);
 }
 }

 useEffect(() => {
 load();
 const poll = window.setInterval(() => load(false), POLL_MS);
 return () => window.clearInterval(poll);
 }, []);

 const filtered = useMemo(() => {
 if (!data) return [];
 const q = search.trim().toLowerCase();
 if (!q) return data.products;
 return data.products.filter((p) => p.product.toLowerCase().includes(q));
 }, [data, search]);

 if (loading && !data) {
 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">Sales by Product</h1>
 <div className="page-sub">Aggregating line items from QB invoices...</div>
 </div>
 </div>
 </>
 );
 }
 if (error) return <div className="error">{error}</div>;
 if (!data) return null;

 const { totals, products, windowStart, windowEnd, status, cogsMapping, warnings } = data;
 const top5Revenue = products.slice(0, 5).reduce((s, p) => s + p.totalRevenue, 0);
 const top5Share = totals.totalRevenue > 0 ? (top5Revenue / totals.totalRevenue) * 100 : 0;
 const topProduct = products[0];

 return (
 <>
 <div className="page-head">
 <div>
 <h1 className="page-title">Sales by Product</h1>
 <div className="page-sub">
 Scraped from Intuit share pages (customer invoices) ·
 window <strong>{windowStart}</strong> → <strong>{windowEnd}</strong> ·
 {' '}<strong>{totals.invoiceCount}</strong> invoices scraped ·
 {' '}<strong>{totals.lineItemCount}</strong> product lines ·
 {' '}<strong>{totals.uniqueProducts}</strong> distinct products
 </div>
 </div>
 <button className="btn ghost" onClick={() => load(true)} disabled={loading}>
 {loading ? 'Refreshing...' : 'Refresh'}
 </button>
 </div>

 {/* Scraping status banner - shows the user how many invoices in the sheet
  * have Link populated, how many were scraped vs missing. */}
 <div className="section" style={{ padding: '12px 16px', background: status.missingLinks > 0 ? 'var(--warn-soft)' : 'var(--accent-soft)', border: '1px solid var(--border)' }}>
 <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>SCRAPE STATUS</div>
 <div className="page-sub" style={{ fontSize: 12 }}>
 Sheet rows in window with a Link: <strong>{status.inWindowWithLink}</strong> ·
 successfully scraped: <strong>{status.scraped}</strong> ·
 sheet rows with empty Link column: <strong>{status.missingLinks}</strong> ·
 scrape failures: <strong>{status.failed}</strong>
 </div>
 {status.missingLinks > 0 && (
 <div className="page-sub" style={{ fontSize: 12, marginTop: 4 }}>
 To see more products, populate the Link column in the Invoice Tracker sheet for these invoices.
 The scraper picks them up on the next refresh.
 </div>
 )}
 {status.failures.length > 0 && (
 <details style={{ marginTop: 6 }}>
 <summary className="vendor-note" style={{ cursor: 'pointer', fontSize: 12 }}>Show {status.failures.length} failure{status.failures.length === 1 ? '' : 's'}</summary>
 <div style={{ marginTop: 4, fontSize: 11, fontFamily: 'monospace' }}>
 {status.failures.slice(0, 10).map((f) => (
 <div key={f.token}>{f.token.slice(0, 32)}... · {f.error}</div>
 ))}
 </div>
 </details>
 )}
 </div>

 {/* COGS catalog mapping status - shows whether scraped product lines
  * resolve to a name in the COGS catalog (so revenue and costs line up). */}
 <div className="section" style={{ padding: '12px 16px', background: cogsMapping.unmappedLines > 0 ? 'var(--warn-soft)' : 'var(--accent-soft)', border: '1px solid var(--border)' }}>
 <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 4 }}>COGS CATALOG MAPPING</div>
 <div className="page-sub" style={{ fontSize: 12 }}>
 Line items mapped to COGS catalog: <strong>{cogsMapping.mappedLines}</strong> ·
 fallback (no match): <strong>{cogsMapping.unmappedLines}</strong>
 {cogsMapping.unmappedLines > 0 && cogsMapping.mappedLines > 0 && (
 <> ({((cogsMapping.mappedLines / (cogsMapping.mappedLines + cogsMapping.unmappedLines)) * 100).toFixed(0)}% mapped)</>
 )}
 </div>
 {cogsMapping.unmappedLabels.length > 0 && (
 <details style={{ marginTop: 6 }}>
 <summary className="vendor-note" style={{ cursor: 'pointer', fontSize: 12 }}>
 Show {cogsMapping.unmappedLabels.length} unmapped product label{cogsMapping.unmappedLabels.length === 1 ? '' : 's'} (add aliases to catalog to fix)
 </summary>
 <div style={{ marginTop: 4, fontSize: 11 }}>
 {cogsMapping.unmappedLabels.map((l) => (<div key={l}>· {l}</div>))}
 </div>
 </details>
 )}
 </div>

 {warnings.length > 0 && (
 <div className="section" style={{ padding: '8px 16px', background: 'var(--warn-soft)', border: '1px solid var(--warn)' }}>
 {warnings.map((w, i) => <div key={i} className="page-sub" style={{ fontSize: 12 }}>· {w}</div>)}
 </div>
 )}

 <div className="kpis">
 <div className="kpi highlight">
 <div className="kpi-label">Total revenue (line items)</div>
 <div className="kpi-period">Since {windowStart}</div>
 <div className="kpi-value">{formatCurrency(totals.totalRevenue)}</div>
 <div className="kpi-sub">Across {totals.uniqueProducts} products · {totals.uniqueCustomers} customers</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Top product</div>
 <div className="kpi-period">{topProduct ? topProduct.product : '-'}</div>
 <div className="kpi-value">{topProduct ? formatCurrency(topProduct.totalRevenue) : '-'}</div>
 <div className="kpi-sub">
 {topProduct && totals.totalRevenue > 0
 ? `${((topProduct.totalRevenue / totals.totalRevenue) * 100).toFixed(1)}% of total revenue`
 : '-'}
 </div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Top 5 concentration</div>
 <div className="kpi-period">Revenue share of top 5 products</div>
 <div className="kpi-value">{top5Share.toFixed(1)}%</div>
 <div className="kpi-sub">{formatCurrency(top5Revenue)} of {formatCurrency(totals.totalRevenue)}</div>
 </div>
 <div className="kpi">
 <div className="kpi-label">Avg per product</div>
 <div className="kpi-period">Revenue / SKU</div>
 <div className="kpi-value">
 {totals.uniqueProducts > 0 ? formatCurrency(totals.totalRevenue / totals.uniqueProducts) : '-'}
 </div>
 <div className="kpi-sub">{totals.uniqueProducts} active SKUs in window</div>
 </div>
 </div>

 <div className="section">
 <div className="section-head">
 <div>
 <div className="section-title">Product ranking</div>
 <div className="section-sub">Sorted by total revenue. Click a row to expand customer breakdown + monthly trend.</div>
 </div>
 <input
 type="text"
 placeholder="Filter products..."
 value={search}
 onChange={(e) => setSearch(e.target.value)}
 style={{ padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--panel)', color: 'var(--text)', fontSize: 12, minWidth: 200 }}
 />
 </div>
 <div className="table-wrap">
 <table className="data-table">
 <thead>
 <tr>
 <th>#</th>
 <th>Product</th>
 <th className="num">Total revenue</th>
 <th className="num">Units sold</th>
 <th className="num">Avg unit price</th>
 <th className="num">Invoices</th>
 <th className="num">Customers</th>
 <th>Top customer</th>
 <th>Last sold</th>
 <th className="num">Share</th>
 </tr>
 </thead>
 <tbody>
 {filtered.map((p, i) => (
 <ProductRowRender
 key={p.product}
 row={p}
 rank={i + 1}
 totalRevenue={totals.totalRevenue}
 expanded={expanded === p.product}
 onToggle={() => setExpanded(expanded === p.product ? null : p.product)}
 />
 ))}
 {filtered.length === 0 && (
 <tr><td colSpan={10} className="vendor-note" style={{ padding: 16 }}>No products match the filter.</td></tr>
 )}
 </tbody>
 </table>
 </div>
 </div>
 </>
 );
}

function ProductRowRender({
 row, rank, totalRevenue, expanded, onToggle,
}: {
 row: ProductRow;
 rank: number;
 totalRevenue: number;
 expanded: boolean;
 onToggle: () => void;
}) {
 const share = totalRevenue > 0 ? (row.totalRevenue / totalRevenue) * 100 : 0;
 return (
 <>
 <tr style={{ cursor: 'pointer' }} onClick={onToggle}>
 <td>{rank}</td>
 <td><strong>{row.product}</strong></td>
 <td className="num"><strong>{formatCurrency(row.totalRevenue)}</strong></td>
 <td className="num">{row.totalQty.toLocaleString()}</td>
 <td className="num">{formatCurrency(row.avgUnitPrice, true)}</td>
 <td className="num">{row.invoiceCount}</td>
 <td className="num">{row.uniqueCustomers}</td>
 <td>
 {row.topCustomer ? (
 <>
 <strong>{row.topCustomer.au || row.topCustomer.name}</strong>
 {row.topCustomer.au && row.topCustomer.name && (
 <div className="vendor-note" style={{ fontSize: 10 }}>{row.topCustomer.name} · {(row.topCustomer.share * 100).toFixed(0)}% of SKU</div>
 )}
 </>
 ) : <span className="vendor-note">-</span>}
 </td>
 <td className="vendor-note">{row.lastSold}</td>
 <td className="num">{share.toFixed(1)}%</td>
 </tr>
 {expanded && (
 <tr>
 <td colSpan={10} style={{ background: 'var(--panel-soft)', padding: 16 }}>
 <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 16 }}>
 <div>
 <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>CUSTOMER BREAKDOWN ({row.customers.length})</div>
 <div className="table-wrap">
 <table className="data-table" style={{ fontSize: 12 }}>
 <thead>
 <tr>
 <th>Customer / brand</th>
 <th className="num">Units</th>
 <th className="num">Revenue</th>
 <th className="num">Share</th>
 </tr>
 </thead>
 <tbody>
 {row.customers.slice(0, 15).map((c) => (
 <tr key={c.customer}>
 <td>
 <strong>{c.customerAu || c.customer}</strong>
 {c.customerName && <div className="vendor-note" style={{ fontSize: 10 }}>{c.customerName}</div>}
 </td>
 <td className="num">{c.qty.toLocaleString()}</td>
 <td className="num">{formatCurrency(c.revenue)}</td>
 <td className="num">{row.totalRevenue > 0 ? `${((c.revenue / row.totalRevenue) * 100).toFixed(1)}%` : '-'}</td>
 </tr>
 ))}
 {row.customers.length > 15 && (
 <tr><td colSpan={4} className="vendor-note">+{row.customers.length - 15} more customers</td></tr>
 )}
 </tbody>
 </table>
 </div>
 </div>
 <div>
 <div style={{ fontWeight: 700, fontSize: 12, marginBottom: 6 }}>MONTHLY TREND</div>
 <div className="table-wrap" style={{ overflowX: 'auto' }}>
 <table className="data-table" style={{ fontSize: 12 }}>
 <thead>
 <tr>{row.monthly.map((m) => <th key={m.ym} className="num" style={{ fontSize: 11 }}>{ymLabel(m.ym)}</th>)}</tr>
 </thead>
 <tbody>
 <tr>
 {row.monthly.map((m) => (
 <td key={m.ym} className="num">
 <div><strong>{formatCurrency(m.revenue)}</strong></div>
 <div className="vendor-note" style={{ fontSize: 10 }}>{m.qty.toLocaleString()} u</div>
 </td>
 ))}
 </tr>
 </tbody>
 </table>
 </div>
 <div className="vendor-note" style={{ marginTop: 4 }}>
 First sold {row.firstSold} · last sold {row.lastSold}
 </div>
 </div>
 </div>
 </td>
 </tr>
 )}
 </>
 );
}
