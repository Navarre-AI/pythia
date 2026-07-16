// report.js — render a { report, columns, rows } result into one self-contained
// HTML document: title, description, KPI strip, optional inline-SVG chart, and
// the full data table. No external assets, no JS in the output, print-to-PDF
// friendly. Numbers exact from the query; the renderer only formats them.

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const MONEY = /amount|revenue|cost|margin|due|billed|total|price|value|retail|deal|outstanding/i;
const isNum = (v) => typeof v === "number" || (v !== "" && v != null && !isNaN(Number(v)) && /^-?[\d.]+$/.test(String(v)));

function fmt(col, v) {
  if (v == null || v === "") return "";
  if (isNum(v)) {
    const n = Number(v);
    if (MONEY.test(col) && !/pct|percent|rank|count|units|invoices|customers/i.test(col))
      return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (/pct|percent/i.test(col)) return n.toLocaleString() + "%";
    return n.toLocaleString();
  }
  return esc(v);
}

// Minimal inline-SVG bar/line chart from {x,y} over rows (first ~24 points).
function chartSVG(chart, columns, rows) {
  if (!chart || !rows.length) return "";
  const { type, x, y } = chart;
  if (!columns.includes(x) || !columns.includes(y)) return "";
  const pts = rows.slice(0, 24).map((r) => ({ label: String(r[x] ?? ""), val: Number(r[y]) || 0 }));
  const W = 720, H = 260, padL = 56, padB = 54, padT = 12, padR = 12;
  const iw = W - padL - padR, ih = H - padT - padB;
  const max = Math.max(...pts.map((p) => p.val), 0), min = Math.min(...pts.map((p) => p.val), 0);
  const span = max - min || 1;
  const yOf = (v) => padT + ih - ((v - min) / span) * ih;
  const zero = yOf(0);
  let body = "";
  // y-axis gridlines + labels
  for (let i = 0; i <= 4; i++) {
    const v = min + (span * i) / 4, yy = yOf(v);
    body += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="#eee"/>` +
      `<text x="${padL - 6}" y="${yy + 3}" text-anchor="end" font-size="10" fill="#888">${Math.round(v).toLocaleString()}</text>`;
  }
  if (type === "line") {
    const step = pts.length > 1 ? iw / (pts.length - 1) : 0;
    const d = pts.map((p, i) => `${i ? "L" : "M"}${padL + i * step},${yOf(p.val)}`).join(" ");
    body += `<path d="${d}" fill="none" stroke="#6d5bb8" stroke-width="2.5"/>`;
    pts.forEach((p, i) => { body += `<circle cx="${padL + i * step}" cy="${yOf(p.val)}" r="2.5" fill="#6d5bb8"/>`; });
    pts.forEach((p, i) => { if (i % Math.ceil(pts.length / 8) === 0) body += tick(padL + i * step, p.label); });
  } else {
    const bw = iw / pts.length;
    pts.forEach((p, i) => {
      const cx = padL + i * bw, top = yOf(p.val), h = Math.abs(top - zero);
      body += `<rect x="${cx + bw * 0.14}" y="${Math.min(top, zero)}" width="${bw * 0.72}" height="${h || 1}" fill="#6d5bb8" rx="2"/>`;
      body += tick(cx + bw / 2, p.label);
    });
  }
  function tick(cx, label) {
    const t = label.length > 12 ? label.slice(0, 11) + "…" : label;
    return `<text x="${cx}" y="${H - padB + 14}" text-anchor="end" font-size="9.5" fill="#666" transform="rotate(-35 ${cx} ${H - padB + 14})">${esc(t)}</text>`;
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px" role="img">${body}</svg>`;
}

// KPI strip: totals of the additive numeric columns (revenue, counts, units…).
// Skip columns where a sum is meaningless (averages, running totals, ranks,
// percentages, per-unit prices). One row -> show the values as-is.
function kpiStrip(columns, rows) {
  const skip = /rank|running|\bavg|average|pct|percent|_value$|price|retail|\bid$/i;
  const numCols = columns.filter((c) => rows.some((r) => isNum(r[c])) && (rows.length === 1 || !skip.test(c)));
  if (!numCols.length) return "";
  const items = numCols.slice(0, 4).map((c) => {
    const vals = rows.map((r) => Number(r[c])).filter((n) => !isNaN(n));
    const val = rows.length === 1 ? vals[0] : vals.reduce((a, b) => a + b, 0);
    const label = (rows.length === 1 ? "" : "total ") + c.replace(/_/g, " ");
    return `<div class="kpi"><div class="kpi-v">${fmt(c, Math.round(val * 100) / 100)}</div><div class="kpi-l">${esc(label)}</div></div>`;
  });
  return `<div class="kpis">${items.join("")}</div>`;
}

const REPORT_CSS = `
  :root { --ink:#241d36; --muted:#6f6690; --line:#e3dff0; --accent:#6d5bb8; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif;
         color: var(--ink); margin: 0; padding: 32px 40px; background: #fff; }
  h1 { font-size: 1.5rem; margin: 0 0 2px; }
  .desc { color: var(--muted); margin: 0 0 18px; max-width: 60ch; }
  .kpis { display: flex; gap: 14px; flex-wrap: wrap; margin: 0 0 20px; }
  .kpi { border: 1px solid var(--line); border-radius: 10px; padding: 10px 16px; min-width: 130px; }
  .kpi-v { font-size: 1.35rem; font-weight: 700; }
  .kpi-l { font-size: 0.72rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .chart { margin: 6px 0 22px; }
  table { border-collapse: collapse; width: 100%; font-size: 0.86rem; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; }
  td.num, th:has(+ td.num) { text-align: right; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  tbody tr:nth-child(even) { background: #faf9fe; }
  footer { margin-top: 22px; color: var(--muted); font-size: 0.72rem; border-top: 1px solid var(--line); padding-top: 10px; }
  @media print { body { padding: 0; } thead { display: table-header-group; } tr { page-break-inside: avoid; }
    @page { margin: 14mm; } }
`;

// Multi-part report: one document, several sections, each with its own query
// result (title, optional note, optional chart, table). Same styling + footer.
export function renderReportParts({ report, parts, meta }) {
  const title = report.name || "Report";
  const asOf = meta?.syncedAt ? new Date(meta.syncedAt).toLocaleString() : "unknown";
  const totalRows = parts.reduce((a, p) => a + p.rows.length, 0);
  const sections = parts.map((p) => {
    const chart = chartSVG(p.chart, p.columns, p.rows);
    const thead = `<tr>${p.columns.map((c) => `<th>${esc(c.replace(/_/g, " "))}</th>`).join("")}</tr>`;
    const tbody = p.rows.map((r) =>
      `<tr>${p.columns.map((c) => `<td class="${isNum(r[c]) ? "num" : ""}">${fmt(c, r[c])}</td>`).join("")}</tr>`
    ).join("");
    return `<section>
  <h2>${esc(p.title || "")}</h2>
  ${p.note ? `<p class="desc">${esc(p.note)}</p>` : ""}
  ${chart ? `<div class="chart">${chart}</div>` : ""}
  <table><thead>${thead}</thead><tbody>${tbody}</tbody></table>
</section>`;
  }).join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>${REPORT_CSS}
  h2 { font-size: 1.08rem; margin: 26px 0 4px; padding-top: 14px; border-top: 1px solid var(--line); }
  section:first-of-type h2 { border-top: none; margin-top: 10px; }
  @media print { section { page-break-inside: avoid; } }
</style></head>
<body>
  <h1>${esc(title)}</h1>
  <p class="desc">${esc(report.description || "")}</p>
  ${sections}
  <footer>
    Pythia · ${parts.length} sections · ${totalRows.toLocaleString()} rows · as of ${esc(asOf)}
  </footer>
</body></html>`;
}

export function renderReport({ report, columns, rows, meta }) {
  const title = report.name || "Report";
  const chart = chartSVG(report.chart, columns, rows);
  const thead = `<tr>${columns.map((c) => `<th>${esc(c.replace(/_/g, " "))}</th>`).join("")}</tr>`;
  const tbody = rows.map((r) =>
    `<tr>${columns.map((c) => `<td class="${isNum(r[c]) ? "num" : ""}">${fmt(c, r[c])}</td>`).join("")}</tr>`
  ).join("");
  const asOf = meta?.syncedAt ? new Date(meta.syncedAt).toLocaleString() : "unknown";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>${REPORT_CSS}</style></head>
<body>
  <h1>${esc(title)}</h1>
  <p class="desc">${esc(report.description || "")}</p>
  ${kpiStrip(columns, rows)}
  ${chart ? `<div class="chart">${chart}</div>` : ""}
  <table><thead>${thead}</thead><tbody>${tbody}</tbody></table>
  <footer>
    Pythia · ${rows.length === 1 ? "1 row" : rows.length + " rows"} · as of ${esc(asOf)}
  </footer>
</body></html>`;
}
