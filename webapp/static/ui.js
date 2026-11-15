// Shared helpers: data access, formatting, theme tokens, Plotly defaults, small DOM components.

// ---------- data ----------
const cache = new Map();
export async function get(path) {
  if (!cache.has(path)) {
    cache.set(path, fetch(path).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${path}`);
      return r.json();
    }));
  }
  try { return await cache.get(path); } catch (e) { cache.delete(path); throw e; }
}

// ---------- vocabulary ----------
export const KPIS = {
  torque_mean: { label: "Mean torque current", unit: "A" },
  torque_p95: { label: "P95 torque current", unit: "A" },
  thrust_mean: { label: "Mean thrust current", unit: "A" },
  thrust_p95: { label: "P95 thrust current", unit: "A" },
  power_mean: { label: "Mean spindle power", unit: "W" },
  energy_J: { label: "Spindle energy", unit: "J" },
  energy_J_per_mm: { label: "Specific energy", unit: "J/mm" },
  duration_s: { label: "Duration", unit: "s" },
  feed_eff_mm_s: { label: "Effective feed", unit: "mm/s" },
  torque_empty: { label: "No-load torque current", unit: "A" },
  gap_max: { label: "Max peck gap", unit: "mm" },
};
export const SIGNALS = {
  torque: { label: "Torque current", unit: "A", hint: "Spindle motor (M1) current, net of no-load" },
  thrust: { label: "Thrust current", unit: "A", hint: "Feed motor (M2) current" },
  power: { label: "Spindle power", unit: "W", hint: "Spindle torque power" },
  gap: { label: "Peck gap", unit: "mm", hint: "Retract distance used to clear chips" },
};
export const OUTCOMES = {
  ok: { label: "OK", cls: "ok" },
  ko_end: { label: "KO · abnormal end code", cls: "ko_end" },
  ko_stop: { label: "KO · stopped before last step", cls: "ko_stop" },
};
export const MAKERS = ["GUHRING", "KLENK", "MAPAL"];
export const DIAMETERS = [9.5, 11.1, 12.7, 14.3];

// ---------- formatting ----------
const MINUS = "−";
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export function fmt(v, d = 1) {
  if (v == null || !Number.isFinite(v)) return "–";
  return v.toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d }).replace("-", MINUS);
}
export function pct(v, d = 0, signed = false) {
  if (v == null || !Number.isFinite(v)) return "–";
  const s = (Math.abs(v) * 100).toFixed(d) + "%";
  if (!signed) return s;
  return (v > 0 ? "+" : v < 0 ? MINUS : "±") + s;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function date(iso, withYear = false) {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0"), mm = String(d.getMinutes()).padStart(2, "0");
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${withYear ? " " + d.getFullYear() : ""}, ${hh}:${mm}`;
}
export function day(iso) {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
export const diam = (d) => `Ø${d.toFixed(1)}`;
export const stepName = (s) => `Step ${s}`;
export function signatureHtml(sig, ok) {
  if (!sig) return '<span class="muted">no step data</span>';
  const parts = sig.split("-");
  return `<span class="sig">${parts.map((p, i) => (i === parts.length - 1 && !ok ? `<span class="last-bad">${esc(p)}</span>` : esc(p))).join(" → ")}</span>`;
}

// ---------- theme tokens ----------
export function tok(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
}
export function colors() {
  const t = (n) => tok(n);
  return {
    ink: t("ink"), ink2: t("ink-2"), muted: t("muted"), grid: t("grid"), axis: t("axis"), surface: t("surface"),
    surface2: t("surface-2"), border: t("border"),
    maker: { GUHRING: t("guhring"), KLENK: t("klenk"), MAPAL: t("mapal") },
    seq0: t("seq-0"), seq1: t("seq-1"), seqMid: t("seq-mid"),
    heat: t("heat").split(",").map((s) => s.trim()),
    divNeg: t("div-neg"), divMid: t("div-mid"), divPos: t("div-pos"),
    good: t("good"), warning: t("warning"), serious: t("serious"), critical: t("critical"),
  };
}
export const isDark = () => getComputedStyle(document.documentElement).colorScheme.includes("dark");

// Interpolate between two hex colours (sequential ramp for hole order)
export function mix(a, b, f) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * Math.max(0, Math.min(1, f))).toString(16).padStart(2, "0")).join("");
}
export function rgba(hex, a) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgba(${r},${g},${b},${a})`;
}
export function scaleColors(stops) {
  return stops.map((c, i) => [i / (stops.length - 1), c]);
}

// ---------- Plotly ----------
function axisStyle(c) {
  return {
    gridcolor: c.grid, linecolor: c.axis, tickcolor: c.axis, zerolinecolor: c.axis, zeroline: false,
    showline: true, ticks: "outside", ticklen: 4, automargin: true,
    tickfont: { size: 11, color: c.ink2 }, title: { font: { size: 12, color: c.ink2 }, standoff: 8 },
  };
}
function merge(a, b) {
  if (b === undefined) return a;
  if (Array.isArray(b) || typeof b !== "object" || b === null) return b;
  const out = { ...(typeof a === "object" && a && !Array.isArray(a) ? a : {}) };
  for (const k of Object.keys(b)) out[k] = merge(out[k], b[k]);
  return out;
}
export function plot(el, traces, layout = {}, opts = {}) {
  if (!el) return;
  const c = colors();
  let base = {
    font: { family: tok("sans"), size: 12, color: c.ink2 },
    paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
    margin: { l: 8, r: 12, t: 8, b: 8 },
    showlegend: false,
    hoverlabel: { bgcolor: c.surface, bordercolor: c.axis, font: { color: c.ink, family: tok("sans"), size: 12 }, align: "left" },
    xaxis: axisStyle(c), yaxis: axisStyle(c),
    bargap: 0.35, bargroupgap: 0.12,
  };
  const L = merge(base, layout);
  for (const k of Object.keys(L)) if (/^[xy]axis\d+$/.test(k)) L[k] = merge(axisStyle(c), L[k]);
  Plotly.react(el, traces, L, { displayModeBar: false, responsive: true, ...opts });
}
export function purge(root) {
  root.querySelectorAll(".js-plotly-plot").forEach((el) => Plotly.purge(el));
}

// Vertical step bands (alternating light shading) + labels on top
export function stepBands(spans, { xref = "x", yref = "paper", label = true } = {}) {
  const c = colors();
  const shapes = [], annotations = [];
  spans.forEach((s, i) => {
    if (s.x0 == null || s.x1 == null) return;
    shapes.push({ type: "rect", xref, yref: "paper", x0: s.x0, x1: s.x1, y0: 0, y1: 1, layer: "below", line: { width: 0 },
      fillcolor: i % 2 ? "rgba(0,0,0,0)" : rgba(c.muted.startsWith("#") ? c.muted : "#898781", isDark() ? 0.10 : 0.07) });
    if (label) annotations.push({ xref, yref: "paper", x: (s.x0 + s.x1) / 2, y: 1, yanchor: "bottom", showarrow: false,
      text: s.text, font: { size: 11, color: c.ink2 } });
  });
  return { shapes, annotations };
}

// ---------- statistics ----------
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
export const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
// Same definition as helper.trend(): mean of last 10 % vs first 10 % of the points, relative
export function relChange(xs, ys) {
  const pts = xs.map((x, i) => [x, ys[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y)).sort((a, b) => a[0] - b[0]);
  if (pts.length < 3) return null;
  const k = Math.max(1, Math.floor(pts.length / 10));
  const first = mean(pts.slice(0, k).map((p) => p[1])), last = mean(pts.slice(-k).map((p) => p[1]));
  return first ? (last - first) / Math.abs(first) : null;
}
export function rollingMedian(ys, win) {
  const h = Math.floor(win / 2);
  return ys.map((_, i) => {
    const w = ys.slice(Math.max(0, i - h), i + h + 1).filter(Number.isFinite).sort((a, b) => a - b);
    return quantile(w, 0.5);
  });
}
export function pearson(a, b) {
  const pts = a.map((x, i) => [x, b[i]]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pts.length < 3) return null;
  const mx = mean(pts.map((p) => p[0])), my = mean(pts.map((p) => p[1]));
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}
// Column-wise quantiles of a matrix (rows = holes), restricted to a row subset
export function envelope(matrix, rowIdx, qs = [0.1, 0.5, 0.9], minN = 3) {
  const nCol = matrix[0]?.length ?? 0;
  const out = qs.map(() => new Array(nCol).fill(null));
  for (let j = 0; j < nCol; j++) {
    const col = [];
    for (const i of rowIdx) { const v = matrix[i][j]; if (v != null) col.push(v); }
    if (col.length < minN) continue;
    col.sort((a, b) => a - b);
    qs.forEach((q, k) => (out[k][j] = quantile(col, q)));
  }
  return out;
}
export function colMean(matrix, rowIdx) {
  const nCol = matrix[0]?.length ?? 0;
  return Array.from({ length: nCol }, (_, j) => {
    const v = rowIdx.map((i) => matrix[i][j]).filter((x) => x != null);
    return v.length ? mean(v) : null;
  });
}

// ---------- components ----------
const ICONS = {
  stable: (c) => `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="6" fill="${c}"/><path d="M3.3 6.2l1.8 1.8 3.6-3.8" stroke="#fff" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  watch: (c) => `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M6 .6l5.6 10.2H.4z" fill="${c}"/><path d="M6 4.3v3" stroke="#0b0b0b" stroke-width="1.4" stroke-linecap="round"/><circle cx="6" cy="9" r=".75" fill="#0b0b0b"/></svg>`,
  alert: (c) => `<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 0h5L12 3.5v5L8.5 12h-5L0 8.5v-5z" fill="${c}"/><path d="M4 4l4 4M8 4l-4 4" stroke="#fff" stroke-width="1.5" stroke-linecap="round"/></svg>`,
};
const STATUS_LABEL = { stable: "Stable", watch: "Watch", alert: "Alert" };
export function statusBadge(status, pill = false) {
  const c = colors();
  const col = { stable: c.good, watch: c.warning, alert: c.critical }[status];
  return `<span class="status${pill ? " pill" : ""}">${ICONS[status](col)}${STATUS_LABEL[status]}</span>`;
}
export function outcomeBadge(outcome, pill = false) {
  const c = colors();
  const cls = `status${pill ? " pill" : ""}`;
  if (outcome === "ok") return `<span class="${cls}">${ICONS.stable(c.good)}OK</span>`;
  const icon = outcome === "ko_end" ? ICONS.alert(c.critical) : ICONS.watch(c.serious);
  return `<span class="${cls}">${icon}${outcome === "ko_end" ? "KO" : "KO · stopped"}</span>`;
}
export function outcomeBar(o, total) {
  const seg = (k) => (o[k] ? `<span class="${k}" style="flex:${o[k]}" title="${esc(OUTCOMES[k].label)}: ${o[k]} of ${total}"></span>` : "");
  return `<div class="obar" role="img" aria-label="${o.ok} OK, ${o.ko_end} KO with abnormal end code, ${o.ko_stop} KO stopped early">${seg("ok")}${seg("ko_end")}${seg("ko_stop")}</div>`;
}
export function outcomeLegend() {
  return `<div class="legend"><span><i style="background:var(--good)"></i>OK</span><span><i style="background:var(--critical)"></i>KO · all steps run, abnormal end code</span><span><i style="background:var(--serious)"></i>KO · stopped before last step</span></div>`;
}
export function tiles(items) {
  return `<div class="tiles">${items.map(([k, v, d]) => `<div class="tile"><div class="k">${esc(k)}</div><div class="v">${v}</div>${d ? `<div class="d">${d}</div>` : ""}</div>`).join("")}</div>`;
}
export function seg(name, options, value) {
  return `<div class="seg" role="group" data-seg="${name}">${options.map(([v, l]) => `<button type="button" data-value="${esc(v)}" aria-pressed="${String(v) === String(value)}">${esc(l)}</button>`).join("")}</div>`;
}
export function onSeg(root, name, fn) {
  root.querySelector(`[data-seg="${name}"]`)?.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-value]");
    if (b) fn(b.dataset.value);
  });
}

// Sortable table. cols: [{key, label, num, html(row) -> string, sort(row) -> value}]
export function table(el, rows, cols, { onRow, sortKey, sortDir = -1, rowAttr } = {}) {
  let key = sortKey, dir = sortDir;
  const render = () => {
    const col = cols.find((c) => c.key === key);
    const data = col ? [...rows].sort((a, b) => {
      const va = col.sort ? col.sort(a) : a[key], vb = col.sort ? col.sort(b) : b[key];
      if (va == null) return 1; if (vb == null) return -1;
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    }) : rows;
    el.innerHTML = `<table class="t${onRow ? " click" : ""}"><thead><tr>${cols.map((c) =>
      `<th class="${c.num ? "num " : ""}${c.nosort ? "" : "sortable"}" data-k="${c.key}"${c.key === key ? ` aria-sort="${dir > 0 ? "ascending" : "descending"}"` : ""}${c.title ? ` title="${esc(c.title)}"` : ""}>${esc(c.label)}</th>`).join("")}</tr></thead>
      <tbody>${data.map((r, i) => `<tr data-i="${rows.indexOf(r)}" ${rowAttr ? rowAttr(r) : ""}${onRow ? ' tabindex="0"' : ""}>${cols.map((c) =>
        `<td class="${c.num ? "num" : ""}${c.cls ? " " + c.cls : ""}"${c.style ? ` style="${c.style(r)}"` : ""}>${c.html ? c.html(r) : esc(r[c.key])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  };
  el.addEventListener("click", (e) => {
    const th = e.target.closest("th.sortable");
    if (th) {
      if (key === th.dataset.k) dir = -dir; else { key = th.dataset.k; dir = cols.find((c) => c.key === key).num ? -1 : 1; }
      return render();
    }
    const tr = e.target.closest("tbody tr");
    if (tr && onRow) onRow(rows[+tr.dataset.i]);
  });
  el.addEventListener("keydown", (e) => {
    const tr = e.target.closest("tbody tr");
    if (tr && onRow && e.key === "Enter") onRow(rows[+tr.dataset.i]);
  });
  render();
}

// Diverging cell background for a relative change (−cap … +cap)
export function divergingBg(v, cap = 0.6) {
  if (v == null || !Number.isFinite(v)) return "";
  const c = colors();
  const f = Math.min(1, Math.abs(v) / cap);
  const col = mix(c.divMid, v > 0 ? c.divPos : c.divNeg, f * 0.85);
  const ink = f > 0.55 ? "#fff" : "";
  return `background:${col};${ink ? `color:${ink};` : ""}`;
}

export function emptyState(msg) {
  return `<div class="empty-state">${esc(msg)}</div>`;
}
