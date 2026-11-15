// Cycle view: one drilled hole at full 100 Hz resolution, set against its tool's envelope.
import {
  get, esc, fmt, pct, date, diam, stepName, colors, plot, rgba, outcomeBadge, tiles, seg, onSeg,
  signatureHtml, envelope, emptyState, SIGNALS, OUTCOMES,
} from "./ui.js";
import { state, setState, go } from "./app.js";

let nav = { prev: null, next: null };
document.addEventListener("keydown", (e) => {
  if (!location.hash.startsWith("#/cycle/") || e.target.closest?.("input, select, textarea")) return;
  if (e.key === "ArrowLeft" && nav.prev) go(`#/cycle/${nav.prev}`);
  if (e.key === "ArrowRight" && nav.next) go(`#/cycle/${nav.next}`);
});

const ROWS = [
  { key: "depth", label: "Depth", unit: "mm" },
  { key: "torque", label: "Torque current", unit: "A" },
  { key: "thrust", label: "Thrust current", unit: "A" },
  { key: "power", label: "Spindle power", unit: "W" },
  { key: "gap", label: "Peck gap", unit: "mm" },
];

export async function renderCycle(root, fleet, fileId) {
  const C = await get(`/api/cycle/${fileId}`);
  const T = await get(`/api/tool/${C.tool_ref}`);
  const S = T.summary;
  nav = { prev: C.prev, next: C.next };
  setState({ cycle: fileId, tool: C.tool_ref }, false);
  const k = C.kpi;
  const sig = SIGNALS[state.signal];

  root.innerHTML = `
  <div class="page-head">
    <div class="titles">
      <div class="crumbs"><a href="#/fleet">Fleet</a> / <a href="#/tool/${esc(C.tool_ref)}">${esc(C.tool_ref)}</a> / Cycle ${C.hole_idx}</div>
      <div class="title-row">
        <h1>Cycle ${C.hole_idx} <span class="ink-2" style="font-weight:400">of ${C.n_holes} · <span class="mono" style="font-size:18px">${esc(C.tool_ref)}</span> ${esc(S.maker)} ${diam(S.diameter)}</span></h1>
        ${outcomeBadge(C.outcome, true)}
      </div>
      <div class="meta">
        <span>${date(C.date, true)}</span>
        <span>Step codes ${signatureHtml(C.signature, C.cycle_ok)}</span>
        <span class="mono muted">${esc(C.source_file)}</span>
      </div>
    </div>
    <div class="cycle-nav">
      <a class="btn" href="#/cycle/${C.prev ?? ""}" aria-disabled="${!C.prev}">‹ Previous</a>
      <a class="btn" href="#/cycle/${C.next ?? ""}" aria-disabled="${!C.next}">Next ›</a>
      <span class="muted" style="font-size:12px"><kbd>←</kbd> <kbd>→</kbd></span>
    </div>
  </div>

  ${C.cycle_ok ? "" : `<div class="notice" style="border-left-color:var(--${C.outcome === "ko_end" ? "critical" : "serious"})"><span>${esc(OUTCOMES[C.outcome].label)}. ${
    C.outcome === "ko_end" ? `All programmed steps ran, but the last one ended on code <b>${k.final_code}</b> instead of ${fleet.normal_end_code}.`
      : `The cycle stopped at step ${C.step_results.length ? C.step_results[C.step_results.length - 1].step : "?"} (code <b>${k.final_code ?? "–"}</b>) before the last programmed step.`}</span></div>`}

  <section style="margin-top:16px">
  ${tiles([
    ["Cycle time", `${fmt(k.cycle_time_s, 1)}<small>s</small>`, `tool median ${fmt(S.cycle_time_med, 0)} s`],
    ["Depth reached", `${fmt(k.depth_max ?? k.distance_mm, 2)}<small>mm</small>`, `tool median ${fmt(S.depth_med, 1)} mm`],
    ["Spindle energy", `${fmt((k.energy_J ?? NaN) / 1000, 1)}<small>kJ</small>`, "∫ spindle power dt"],
    ["Specific energy", `${fmt(k.energy_J_per_mm, 0)}<small>J/mm</small>`, `tool median ${fmt(S.energy_mm_med, 0)}`],
    ["Torque P95", `${fmt(k.torque_p95, 2)}<small>A</small>`, `tool median ${fmt(S.torque_p95_med, 2)} A`],
    ["Thrust P95", `${fmt(k.thrust_p95, 2)}<small>A</small>`, ""],
    ["Final stop code", k.final_code == null ? "–" : String(k.final_code), k.final_code === fleet.normal_end_code ? "normal end" : "abnormal end"],
  ])}
  </section>

  <section>
    <div class="section-head"><h2>Time trace</h2><p>Raw signals at ${C.series.t.length > 1 ? "100 Hz" : "–"}. Shaded bands = program steps; × on the depth trace = stop-code events (hover for the code). Drag to zoom, double-click to reset.</p></div>
    <div class="card">${C.valid ? `<div class="chart" id="trace" style="height:760px"></div>` : emptyState("This cycle has no usable recording (fewer than 50 samples).")}</div>
  </section>

  <section>
    <div class="section-head"><h2>Against the tool envelope</h2><p>This cycle compared with the ${S.n_ok ? "OK" : "other"} cycles of ${esc(C.tool_ref)}, by depth.</p>
      <div class="controls">${seg("signal", Object.entries(SIGNALS).map(([key, v]) => [key, v.label]), state.signal)}</div></div>
    <div class="card">
      <div class="legend"><span><i style="background:${rgba("#898781", 0.35)}"></i>${S.n_ok ? "OK" : "Other"} cycles, 10–90 %</span><span><i class="line" style="background:var(--ink-2)"></i>Median</span><span><i class="line" style="background:var(--${C.cycle_ok ? "seq-mid" : "critical"})"></i>Cycle ${C.hole_idx}</span></div>
      <div class="chart" id="env" style="height:340px"></div>
    </div>
  </section>

  <section>
    <div class="grid cols-2">
      <div class="card"><div class="card-head"><h3>Program set-points<span class="sub">as recorded in this cycle's file</span></h3></div><div class="table-wrap">${programTable(C.program)}</div></div>
      <div class="card"><div class="card-head"><h3>Step results<span class="sub">reported by the controller</span></h3></div><div class="table-wrap">${resultsTable(C.step_results, fleet.normal_end_code)}</div></div>
    </div>
  </section>`;

  return (app) => {
    onSeg(app, "signal", (v) => setState({ signal: v }));
    if (C.valid) drawTrace(app, C);
    drawEnvelope(app, C, T);
  };
}

function drawTrace(app, C) {
  const c = colors();
  const s = C.series, n = ROWS.length;
  const gap = 0.025, h = (1 - gap * (n - 1)) / n;
  const layout = { height: 760, margin: { l: 4, r: 12, t: 22, b: 4 }, hovermode: "x unified", xaxis: { title: { text: "Time since cycle start (s)" }, anchor: `y${n}`, hoverformat: ".2f" } };
  const traces = ROWS.map((r, i) => {
    const ax = i === 0 ? "" : String(i + 1);
    const y1 = 1 - i * (h + gap);
    layout[`yaxis${ax}`] = { domain: [y1 - h, y1], anchor: "x", title: { text: `${r.label} (${r.unit})`, font: { size: 11 } }, ...(r.key === "depth" ? { autorange: "reversed" } : {}) };
    return { type: "scatter", mode: "lines", x: s.t, y: s[r.key], yaxis: `y${ax}`, name: r.label,
      line: { color: r.key === "depth" ? c.ink2 : c.seqMid, width: 1.3 }, hovertemplate: `%{y:.3~f} ${r.unit}` };
  });
  if (C.stops.t.length) traces.push({ type: "scatter", mode: "markers", x: C.stops.t, y: C.stops.depth, yaxis: "y", name: "Stop code",
    customdata: C.stops.code, marker: { symbol: "x-thin", size: 9, color: c.critical, line: { width: 2, color: c.critical } },
    hovertemplate: "code %{customdata}" });

  // step spans in time
  const spans = [];
  let start = 0;
  for (let i = 1; i <= s.step.length; i++) {
    if (i === s.step.length || s.step[i] !== s.step[start]) { spans.push({ step: s.step[start], x0: s.t[start], x1: s.t[i - 1] }); start = i; }
  }
  layout.shapes = spans.map((b, i) => ({ type: "rect", xref: "x", yref: "paper", x0: b.x0, x1: b.x1, y0: 0, y1: 1, layer: "below", line: { width: 0 },
    fillcolor: i % 2 ? "rgba(0,0,0,0)" : rgba("#898781", 0.08) }));
  layout.annotations = spans.filter((b) => b.x1 - b.x0 > 0.5).map((b) => ({ xref: "x", yref: "paper", x: (b.x0 + b.x1) / 2, y: 1, yanchor: "bottom", showarrow: false,
    text: stepName(b.step), font: { size: 11, color: c.ink2 } }));
  plot(app.querySelector("#trace"), traces, layout);
}

function drawEnvelope(app, C, T) {
  const c = colors();
  const key = state.signal, sig = SIGNALS[key];
  const P = T.profiles, M = P[key], X = P.depth;
  const okByIdx = new Map(T.holes.hole_idx.map((h, i) => [h, T.holes.cycle_ok[i]]));
  const anyOk = T.summary.n_ok > 0;
  const me = P.hole_idx.indexOf(C.hole_idx);
  const ref = P.hole_idx.map((h, i) => [h, i]).filter(([h, i]) => i !== me && (!anyOk || okByIdx.get(h))).map(([, i]) => i);
  const el = app.querySelector("#env");
  if (me < 0 || ref.length < 3) { el.innerHTML = emptyState("No depth profile for this cycle."); return; }
  const [p10, p50, p90] = envelope(M, ref);
  const bands = T.program.filter((p) => p.depth_start != null);
  plot(el, [
    { type: "scatter", mode: "lines", x: X, y: p90, line: { width: 0 }, hoverinfo: "skip" },
    { type: "scatter", mode: "lines", x: X, y: p10, line: { width: 0 }, fill: "tonexty", fillcolor: rgba("#898781", 0.22), hoverinfo: "skip" },
    { type: "scatter", mode: "lines", x: X, y: p50, line: { color: c.ink2, width: 1.5 }, name: "Median", hovertemplate: "Median <b>%{y:.3~f}</b><extra></extra>" },
    { type: "scatter", mode: "lines", x: X, y: M[me], line: { color: C.cycle_ok ? c.seqMid : c.critical, width: 2 }, name: `Cycle ${C.hole_idx}`,
      hovertemplate: `Cycle ${C.hole_idx} <b>%{y:.3~f} ${sig.unit}</b><extra></extra>` },
  ], {
    height: 340, margin: { l: 4, r: 12, t: 22, b: 4 }, hovermode: "x unified",
    shapes: bands.map((b, i) => ({ type: "rect", xref: "x", yref: "paper", x0: b.depth_start, x1: b.depth_end, y0: 0, y1: 1, layer: "below", line: { width: 0 }, fillcolor: i % 2 ? "rgba(0,0,0,0)" : rgba("#898781", 0.08) })),
    annotations: bands.map((b) => ({ xref: "x", yref: "paper", x: (b.depth_start + b.depth_end) / 2, y: 1, yanchor: "bottom", showarrow: false, text: stepName(b.step), font: { size: 11, color: c.ink2 } })),
    xaxis: { title: { text: "Depth (mm)" }, hoverformat: ".1f" }, yaxis: { title: { text: `${sig.label} (${sig.unit})` } },
  });
}

function programTable(prog) {
  if (!prog.length) return emptyState("No program recorded.");
  return `<table class="t"><thead><tr><th>Step</th><th>Regime</th><th class="num">rpm</th><th class="num">mm/rev</th><th class="num">mm/s</th><th class="num">Peck gap (mm)</th></tr></thead>
  <tbody>${prog.map((p) => `<tr${p.regime === "approach" ? ' class="muted"' : ""}><td>${stepName(p.step)}</td><td>${p.regime}</td><td class="num">${fmt(p.rpm, 0)}</td>
  <td class="num">${fmt(p.feed_rev, 3)}</td><td class="num">${fmt(p.feed_s, 2)}</td><td class="num">${fmt(p.gap, 1)}</td></tr>`).join("")}</tbody></table>`;
}

function resultsTable(sr, normal) {
  if (!sr.length) return emptyState("No step results.");
  return `<table class="t"><thead><tr><th>Step</th><th class="num">Stop code</th><th class="num">Duration (s)</th><th class="num">Feed travel (mm)</th>
    <th class="num" title="Spindle motor peak current">M1 max (A)</th><th class="num" title="Spindle motor no-load current">M1 no-load (A)</th><th class="num" title="Feed motor peak current">M2 max (A)</th><th class="num">Gap max (mm)</th></tr></thead>
  <tbody>${sr.map((r, i) => `<tr><td>${stepName(r.step)}</td><td class="num${i === sr.length - 1 && r.code !== normal ? " pos" : ""}">${r.code}</td>
    <td class="num">${fmt(r.duration, 2)}</td><td class="num">${fmt(r.dist_m2, 2)}</td><td class="num">${fmt(r.m1_max, 2)}</td><td class="num">${fmt(r.m1_noload, 2)}</td>
    <td class="num">${fmt(r.m2_max, 2)}</td><td class="num">${fmt(r.gap_max, 2)}</td></tr>`).join("")}</tbody></table>`;
}
