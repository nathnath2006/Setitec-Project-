// Tool view: one drill — program, wear trend, depth signature, failures, cycle log.
import {
  get, esc, fmt, pct, date, day, diam, stepName, colors, plot, mix, rgba, scaleColors, outcomeBadge,
  outcomeLegend, tiles, seg, onSeg, table, divergingBg, emptyState, signatureHtml, envelope, colMean, quantile,
  relChange, rollingMedian, pearson, info, toolSelect, groupUrl, reasonText, KPIS, SIGNALS,
} from "./ui.js";
import { state, setState, go, toolHref, cycleHref, tabHref } from "./app.js";

const ROLL = 7; // rolling-median window (cycles) on the wear chart

export async function renderTool(root, fleet, ref) {
  const d = await get(`/api/tool/${ref}`);
  const S = d.summary;
  const hasOk = S.n_ok > 0;
  const includeKo = state.includeKo || !hasOk;
  const sig = SIGNALS[state.signal];
  const H = rows(d.holes);
  const byIdx = new Map(H.map((h) => [h.hole_idx, h]));
  const order = [...fleet.tools].sort((a, b) => a.diameter - b.diameter || a.maker.localeCompare(b.maker)).map((t) => t.tool_ref); // same order as the picker
  const i = order.indexOf(ref);
  const prev = order[(i - 1 + order.length) % order.length], next = order[(i + 1) % order.length];
  const cuttingSteps = d.program.filter((p) => p.regime !== "approach" && d.step_feat.step.includes(p.step));
  // Group outliers: this tool scored against every tool of the same diameter (Group tab, default features)
  const peers = fleet.tools.filter((t) => t.diameter === S.diameter).map((t) => t.tool_ref);
  const G = await get(groupUrl(peers)).catch(() => null);
  const outliers = new Map();
  if (G) G.points.file_id.forEach((f, i) => { if (G.points.outlier[i] && G.points.tool_ref[i] === ref) outliers.set(f, G.points.reasons[i]); });
  H.forEach((h) => { h.outlier = outliers.get(h.file_id) || null; });

  root.innerHTML = `
  <div class="filters">
    <div class="filter"><span class="lbl">Tool</span>${toolSelect(fleet, ref)}
      <a class="btn btn-icon" href="${toolHref(prev)}" title="Previous tool (${prev})" aria-label="Previous tool">‹</a><a class="btn btn-icon" href="${toolHref(next)}" title="Next tool (${next})" aria-label="Next tool">›</a></div>
    <div class="filter"><span class="lbl">Signal</span>${seg("signal", Object.entries(SIGNALS).map(([k, v]) => [k, v.label]), state.signal)}</div>
    <div class="filter"><span class="lbl">Cycles</span>${seg("cycles", [["all", "All"], ["ok", "OK only"]], includeKo ? "all" : "ok")}</div>
  </div>
  <div class="tool-head">
    <h2><span class="mono">${esc(ref)}</span> <span class="ink-2">${esc(S.maker)} ${diam(S.diameter)} mm</span></h2>
    <div class="meta"><span>Head <b class="mono">${esc(S.head)}</b></span><span>${date(S.start, true)} → ${date(S.end)} <span class="muted">(${fmt(S.span_h, 1)} h)</span></span></div>
  </div>
  ${hasOk ? "" : `<div class="notice"><span class="notice-mark">!</span><span>${esc(ref)} has no OK cycle: envelopes, drift and correlations use all ${S.n} cycles.</span></div>`}

  <section style="margin-top:16px">
  ${tiles([
    ["Cycles", String(S.n), `${S.n_ok} OK · ${S.n_ko} KO`],
    ["OK rate", pct(S.ok_rate, 1), "controller outcome"],
    ["Cycle time", `${fmt(S.cycle_time_med, 0)}<small>s</small>`, "median"],
    ["Depth reached", `${fmt(S.depth_med, 1)}<small>mm</small>`, "median"],
    ["Specific energy", `${fmt(S.energy_mm_med, 0)}<small>J/mm</small>`, "median"],
    ["Energy drift", pct(S.drift_energy, 0, true), "first → last 10 % of cycles"],
    ["Torque P95 drift", pct(S.drift_torque, 0, true), "first → last 10 % of cycles"],
    ["Group outliers", G ? String(outliers.size) : "–", G ? `${H.filter((h) => h.outlier && h.cycle_ok).length} OK · ${H.filter((h) => h.outlier && !h.cycle_ok).length} KO · <a href="${tabHref("group")}">${diam(S.diameter)} group</a>` : "unavailable"],
  ])}
  </section>

  <section>
    <div class="section-head"><h2>Drilling program</h2>
      <p>Set-points of each step.</p>${info("Several values in a cell mean the program changed during the test. Step numbers do not mean the same thing on every tool: compare steps by speed and feed.")}</div>
    <div class="grid cols-2-1">
      <div class="card"><div class="table-wrap">${programTable(d.program)}</div></div>
      <div class="card"><div class="card-head"><h3>Stop codes per step<span class="sub">Cycles ending each step on each code.</span></h3></div>
        <div class="table-wrap">${codesTable(d.stop_codes, fleet.normal_end_code)}</div></div>
    </div>
  </section>

  <section>
    <div class="section-head"><h2>Wear trend</h2>
      <p>The chosen indicator for each cycle, in drilling order.</p>${info(`Line = rolling median of ${ROLL} ${hasOk ? "OK " : ""}cycles. Torque or energy rising at constant set-points is the wear signature. A ring marks a group outlier: a cycle far from the other ${diam(S.diameter)} tools on at least one feature (see Group tab).`)}
      <div class="controls filter"><label for="kpi">Indicator</label>
        <select class="sel" id="kpi">${Object.entries(KPIS).map(([k, v]) => `<option value="${k}"${k === state.kpi ? " selected" : ""}>${esc(v.label)} (${v.unit})</option>`).join("")}</select></div>
    </div>
    <div class="card">
      <div class="legend" style="margin-bottom:4px">${hasOk ? `<span><i class="dot" style="background:var(--seq-mid)"></i>OK cycle</span>` : ""}${includeKo ? `<span><i class="dot" style="background:var(--critical)"></i>KO cycle (×)</span>` : ""}<span><i class="line" style="background:var(--ink-2)"></i>Rolling median</span>${outliers.size ? `<span><i class="ring"></i>Group outlier</span>` : ""}</div>
      <div class="chart" id="wear"></div>
    </div>
    <div class="card" style="margin-top:12px">
      <div class="card-head"><h3>Drift by step<span class="sub">Change from the first to the last 10 % of ${hasOk ? "OK " : ""}cycles. Red = increases with use.</span></h3></div>
      <div class="table-wrap" id="drift"></div>
    </div>
  </section>

  <section>
    <div class="section-head"><h2>Depth signature · ${esc(sig.label)}</h2>
      <p>${esc(sig.hint)} against depth, one row per cycle.</p>${info("Signals are resampled every 0.1 mm of advance with peck retracts removed, so cycles line up by depth. First cycle at the top; × marks a KO cycle.")}
      <div class="controls">${seg("heat", [["heatmap", "Heatmap"], ["curves", "Curves"]], state.heatMode)}</div>
    </div>
    <div class="card"><div class="chart" id="sig" style="height:460px"></div></div>
    <div class="card" style="margin-top:12px">
      <div class="card-head"><h3>Early life vs late life<span class="sub">Mean of the first and last 10 % of cycles over the 10–90 % band.</span></h3></div>
      <div class="legend" id="env-legend"></div>
      <div class="chart" id="env" style="height:340px"></div>
    </div>
  </section>

  <section>
    <div class="section-head"><h2>Failures</h2>
      <p>KO cycles over the ${hasOk ? "OK-cycle" : "all-cycle"} 10–90 % band. Click a cycle to open it.</p></div>
    ${S.n_ko ? `<div class="grid cols-2-1">
      <div class="card"><div class="legend"><span><i style="background:${rgba("#898781", 0.35)}"></i>${hasOk ? "OK" : "All"} cycles 10–90 %</span><span><i class="line" style="background:var(--ink-2)"></i>Median</span><span><i class="line" style="background:var(--critical)"></i>KO cycle</span></div>
        <div class="chart" id="ko" style="height:360px"></div></div>
      <div class="card"><div class="card-head"><h3>${S.n_ko} KO cycles</h3></div><div class="t-scroll" id="ko-list" style="max-height:330px"></div>
        <div style="margin-top:8px">${outcomeLegend()}</div></div>
    </div>` : `<div class="card">${emptyState("No KO cycle.")}</div>`}
  </section>

  <section>
    <div class="section-head"><h2>Cycle log</h2><p>Click a row to open the cycle.</p>
      <div class="controls">${seg("log", [["all", "All"], ["ok", "OK"], ["ko", "KO"]], state.logFilter)}</div></div>
    <div class="card"><div class="t-scroll" id="log"></div></div>
  </section>

  <section>
    <details class="card" id="corr-box">
      <summary>Feature correlations<span class="sub">Pearson r between indicators of one step. “Cycle #” = accumulated use.</span></summary>
      <div style="margin:10px 0 4px">${seg("corr", cuttingSteps.map((p) => [p.step, stepTitle(p)]), cuttingSteps[0]?.step)}</div>
      <div class="chart" id="corr" style="height:520px"></div>
    </details>
  </section>`;

  return (app) => {
    app.querySelector("#tool-select").addEventListener("change", (e) => go(toolHref(e.target.value)));
    onSeg(app, "signal", (v) => setState({ signal: v }));
    onSeg(app, "cycles", (v) => setState({ includeKo: v === "all" }));
    app.querySelector("#kpi").addEventListener("change", (e) => { setState({ kpi: e.target.value }, false); drawWear(app, d, H, cuttingSteps, includeKo, hasOk, outliers); });
    onSeg(app, "heat", (v) => { setState({ heatMode: v }, false); pressSeg(app, "heat", v); drawSignature(app, d, byIdx, includeKo); });
    onSeg(app, "log", (v) => { state.logFilter = v; pressSeg(app, "log", v); drawLog(app, H, d); });
    let corrStep = cuttingSteps[0]?.step;
    onSeg(app, "corr", (v) => { corrStep = +v; pressSeg(app, "corr", v); drawCorr(app, d, corrStep, hasOk); });
    app.querySelector("#corr-box").addEventListener("toggle", (e) => e.target.open && drawCorr(app, d, corrStep, hasOk));

    drawWear(app, d, H, cuttingSteps, includeKo, hasOk, outliers);
    app.querySelector("#drift").innerHTML = driftTable(d, cuttingSteps, hasOk);
    drawSignature(app, d, byIdx, includeKo);
    drawEnvelope(app, d, byIdx, includeKo, hasOk);
    if (S.n_ko) drawFailures(app, d, H, byIdx, hasOk);
    drawLog(app, H, d);
  };
}

// ---------------------------------------------------------------------------------------------
function rows(cols) {
  const keys = Object.keys(cols);
  return cols[keys[0]].map((_, i) => Object.fromEntries(keys.map((k) => [k, cols[k][i]])));
}
function pressSeg(app, name, v) {
  app.querySelectorAll(`[data-seg="${name}"] button`).forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === String(v))));
}
const list = (a, d = null) => (a?.length ? a.map((v) => (d == null ? v : fmt(v, d))).join(" / ") : "–");
const stepTitle = (p) => `${stepName(p.step)} · ${list(p.rpm, 0)} rpm · ${p.regime}`;

function programTable(prog) {
  return `<table class="t"><thead><tr><th>Step</th><th>Regime</th><th class="num">Spindle (rpm)</th><th class="num">Feed (mm/rev)</th><th class="num">Feed (mm/s)</th><th class="num">Peck gap (mm)</th><th class="num">Depth window (mm)</th><th class="num">Cycles</th></tr></thead>
  <tbody>${prog.map((p) => `<tr${p.regime === "approach" ? ' class="muted"' : ""}>
    <td>${stepName(p.step)}</td><td>${p.regime}</td><td class="num">${list(p.rpm, 0)}</td><td class="num">${list(p.feed_rev, 3)}</td>
    <td class="num">${list(p.feed_s, 2)}</td><td class="num">${list(p.gap, 1)}</td>
    <td class="num">${p.depth_start != null ? `${fmt(p.depth_start, 1)} → ${fmt(p.depth_end, 1)}` : "–"}</td><td class="num">${p.n}</td></tr>`).join("")}</tbody></table>`;
}

function codesTable(sc, normal) {
  return `<table class="t"><thead><tr><th>Step</th>${sc.codes.map((c) => `<th class="num">${c}${c === normal ? '<span class="muted"> ·end</span>' : ""}</th>`).join("")}</tr></thead>
  <tbody>${sc.steps.map((s, i) => `<tr><td>${stepName(s)}</td>${sc.counts[i].map((n) => `<td class="num${n ? "" : " muted"}">${n || "·"}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

// ---------------------------------------------------------------------------------------------
function drawWear(app, d, H, steps, includeKo, hasOk, outliers) {
  const c = colors();
  const kpi = state.kpi, meta = KPIS[kpi];
  const F = rows(d.step_feat);
  const n = steps.length;
  if (!n) { app.querySelector("#wear").innerHTML = emptyState("No cutting step data."); return; }
  const rowH = 170, gap = 34, top = 26, bottom = 40;
  const height = n * rowH + (n - 1) * gap + top + bottom;
  const traces = [], annotations = [], layout = { height, margin: { l: 4, r: 12, t: top, b: bottom }, hovermode: "closest" };
  const plotH = height - top - bottom;
  steps.forEach((p, k) => {
    const ax = k === 0 ? "" : String(k + 1);
    const g = F.filter((r) => r.step === p.step).sort((a, b) => a.hole_idx - b.hole_idx);
    const ref = hasOk ? g.filter((r) => r.cycle_ok) : g;
    const ko = g.filter((r) => !r.cycle_ok);
    const rel = relChange(ref.map((r) => r.hole_idx), ref.map((r) => r[kpi]));
    const y1 = 1 - (k * (rowH + gap)) / plotH, y0 = y1 - rowH / plotH;
    layout[`yaxis${ax}`] = { domain: [Math.max(0, y0), Math.min(1, y1)], title: { text: meta.unit }, anchor: "x", rangemode: "normal" };
    annotations.push({ xref: "paper", yref: "paper", x: 0, y: y1, yanchor: "bottom", xanchor: "left", showarrow: false,
      text: `<b>${stepTitle(p)}</b>   <span style="color:${c.ink2}">first → last ${rel == null ? "–" : pct(rel, 0, true)}</span>`, font: { size: 12, color: c.ink } });
    const ok = g.filter((r) => r.cycle_ok);
    traces.push({ type: "scatter", mode: "markers", x: ok.map((r) => r.hole_idx), y: ok.map((r) => r[kpi]), yaxis: `y${ax}`,
      marker: { size: 6, color: c.seqMid, opacity: 0.75, line: { width: 1, color: c.surface } },
      hovertemplate: `Cycle %{x} · OK<br><b>%{y:.3~f} ${meta.unit}</b><extra></extra>` });
    if (includeKo && ko.length) traces.push({ type: "scatter", mode: "markers", x: ko.map((r) => r.hole_idx), y: ko.map((r) => r[kpi]), yaxis: `y${ax}`,
      marker: { size: 8, symbol: "x-thin", color: c.critical, line: { width: 2, color: c.critical } },
      hovertemplate: `Cycle %{x} · KO<br><b>%{y:.3~f} ${meta.unit}</b><extra></extra>` });
    traces.push({ type: "scatter", mode: "lines", x: ref.map((r) => r.hole_idx), y: rollingMedian(ref.map((r) => r[kpi]), ROLL), yaxis: `y${ax}`,
      line: { color: c.ink2, width: 2 }, hoverinfo: "skip" });
    const out = g.filter((r) => outliers.has(r.file_id) && (includeKo || r.cycle_ok));
    if (out.length) traces.push({ type: "scatter", mode: "markers", x: out.map((r) => r.hole_idx), y: out.map((r) => r[kpi]), yaxis: `y${ax}`,
      marker: { size: 15, symbol: "circle-open", color: c.ink, line: { width: 1.5, color: c.ink } },
      customdata: out.map((r) => reasonText(outliers.get(r.file_id))),
      hovertemplate: `Cycle %{x} · group outlier<br>%{customdata}<extra></extra>` });
  });
  layout.annotations = annotations;
  layout.xaxis = { title: { text: "Cycle # (drilling order)" }, anchor: n > 1 ? `y${n}` : "y", range: [0, Math.max(...H.map((h) => h.hole_idx)) + 1] };
  const el = app.querySelector("#wear");
  el.style.height = `${height}px`;
  plot(el, traces, layout);
}

function driftTable(d, steps, hasOk) {
  const F = rows(d.step_feat);
  const cols = steps.map((p) => {
    const g = F.filter((r) => r.step === p.step && (hasOk ? r.cycle_ok : true));
    return { p, g };
  });
  return `<table class="t"><thead><tr><th>Indicator</th>${cols.map(({ p }) => `<th class="num">${esc(stepTitle(p))}</th>`).join("")}</tr></thead>
  <tbody>${Object.entries(KPIS).map(([k, m]) => `<tr><td>${esc(m.label)} <span class="muted">${m.unit}</span></td>${cols.map(({ g }) => {
    const v = relChange(g.map((r) => r.hole_idx), g.map((r) => r[k]));
    return `<td class="heat" style="${divergingBg(v)}">${pct(v, 0, true)}</td>`;
  }).join("")}</tr>`).join("")}</tbody></table>`;
}

// ---------------------------------------------------------------------------------------------
function profileRows(d, byIdx, includeKo) {
  // indices into the profile matrix (rows ordered by hole_idx)
  return d.profiles.hole_idx.map((h, i) => [h, i]).filter(([h]) => includeKo || byIdx.get(h)?.cycle_ok).map(([, i]) => i);
}
function depthBands(d) {
  return d.program.filter((p) => p.depth_start != null).map((p) => ({ x0: p.depth_start, x1: p.depth_end, text: stepName(p.step) }));
}
function bandShapes(d, c, labels = true) {
  const shapes = [], annotations = [];
  depthBands(d).forEach((b, i) => {
    shapes.push({ type: "rect", xref: "x", yref: "paper", x0: b.x0, x1: b.x1, y0: 0, y1: 1, layer: "below", line: { width: 0 },
      fillcolor: i % 2 ? "rgba(0,0,0,0)" : rgba("#898781", 0.08) });
    if (labels) annotations.push({ xref: "x", yref: "paper", x: (b.x0 + b.x1) / 2, y: 1, yanchor: "bottom", showarrow: false, text: b.text, font: { size: 11, color: c.ink2 } });
  });
  return { shapes, annotations };
}

function drawSignature(app, d, byIdx, includeKo) {
  const c = colors();
  const key = state.signal, sig = SIGNALS[key];
  const M = d.profiles[key], X = d.profiles.depth;
  const idx = profileRows(d, byIdx, includeKo);
  const el = app.querySelector("#sig");
  if (!idx.length) { el.innerHTML = emptyState("No cycle to show."); return; }
  const holes = idx.map((i) => d.profiles.hole_idx[i]);
  const nMax = Math.max(...d.profiles.hole_idx);

  if (state.heatMode === "heatmap") {
    const vals = idx.flatMap((i) => M[i]).filter((v) => v != null).sort((a, b) => a - b);
    const zmin = quantile(vals, 0.01), zmax = quantile(vals, 0.99);
    const ko = holes.filter((h) => !byIdx.get(h).cycle_ok);
    const bounds = depthBands(d).slice(1).map((b) => ({ type: "line", xref: "x", yref: "paper", x0: b.x0, x1: b.x0, y0: 0, y1: 1, line: { color: c.ink2, width: 1 }, opacity: 0.5 }));
    const labels = depthBands(d).map((b) => ({ xref: "x", yref: "paper", x: (b.x0 + b.x1) / 2, y: 1, yanchor: "bottom", showarrow: false, text: b.text, font: { size: 11, color: c.ink2 } }));
    const traces = [{
      type: "heatmap", x: X, y: holes, z: idx.map((i) => M[i]), zmin, zmax, colorscale: scaleColors(c.heat), hoverongaps: false,
      colorbar: { thickness: 10, len: 0.9, outlinewidth: 0, tickfont: { size: 11, color: c.ink2 }, title: { text: sig.unit, font: { size: 11, color: c.ink2 } } },
      hovertemplate: `Cycle %{y} · %{x:.1f} mm<br><b>%{z:.3~f} ${sig.unit}</b><extra></extra>`,
    }];
    if (ko.length) traces.push({ type: "scatter", mode: "markers", x: ko.map(() => X[0] - 0.9), y: ko, cliponaxis: false,
      marker: { symbol: "x-thin", size: 7, color: c.critical, line: { width: 2, color: c.critical } }, hovertemplate: "Cycle %{y} · KO<extra></extra>" });
    plot(el, traces, {
      height: 460, margin: { l: 4, r: 4, t: 22, b: 4 }, shapes: bounds, annotations: labels,
      xaxis: { title: { text: "Depth (mm)" }, showgrid: false, range: [X[0] - 1.5, X[X.length - 1]] },
      yaxis: { title: { text: "Cycle #" }, autorange: "reversed", showgrid: false },
    });
  } else {
    const traces = idx.map((i) => {
      const h = d.profiles.hole_idx[i], ok = byIdx.get(h).cycle_ok;
      return { type: "scatter", mode: "lines", x: X, y: M[i], connectgaps: false,
        line: { color: mix(c.seq0, c.seq1, (h - 1) / Math.max(1, nMax - 1)), width: 1 },
        hovertemplate: `Cycle ${h}${ok ? "" : " · KO"}<br>%{x:.1f} mm · <b>%{y:.3~f} ${sig.unit}</b><extra></extra>` };
    });
    traces.push({ type: "scatter", mode: "markers", x: [null], y: [null], hoverinfo: "skip",
      marker: { colorscale: [[0, c.seq0], [1, c.seq1]], cmin: 1, cmax: nMax, color: [1], showscale: true,
        colorbar: { thickness: 10, len: 0.9, outlinewidth: 0, tickfont: { size: 11, color: c.ink2 }, title: { text: "Cycle #", font: { size: 11, color: c.ink2 } } } } });
    const { shapes, annotations } = bandShapes(d, c);
    plot(el, traces, {
      height: 460, margin: { l: 4, r: 4, t: 22, b: 4 }, shapes, annotations, hovermode: "closest",
      xaxis: { title: { text: "Depth (mm)" } }, yaxis: { title: { text: `${sig.label} (${sig.unit})` } },
    });
  }
}

function drawEnvelope(app, d, byIdx, includeKo, hasOk) {
  const c = colors();
  const key = state.signal, sig = SIGNALS[key];
  const M = d.profiles[key], X = d.profiles.depth;
  const idx = profileRows(d, byIdx, includeKo);
  const el = app.querySelector("#env");
  if (idx.length < 3) { el.innerHTML = emptyState("Not enough cycles."); return; }
  const k = Math.max(3, Math.round(idx.length * 0.1));
  const [p10, p50, p90] = envelope(M, idx);
  const early = colMean(M, idx.slice(0, k)), late = colMean(M, idx.slice(-k));
  const what = includeKo ? "cycles" : "OK cycles";
  app.querySelector("#env-legend").innerHTML = `
    <span><i style="background:${rgba("#898781", 0.35)}"></i>All ${what}, 10–90 %</span>
    <span><i class="line" style="background:var(--ink-2)"></i>Median</span>
    <span><i class="line" style="background:var(--seq-0)"></i>First ${k} ${what} (mean)</span>
    <span><i class="line" style="background:var(--seq-1)"></i>Last ${k} ${what} (mean)</span>`;
  const { shapes, annotations } = bandShapes(d, c);
  plot(el, [
    { type: "scatter", mode: "lines", x: X, y: p90, line: { width: 0 }, hoverinfo: "skip" },
    { type: "scatter", mode: "lines", x: X, y: p10, line: { width: 0 }, fill: "tonexty", fillcolor: rgba("#898781", 0.22), hoverinfo: "skip" },
    { type: "scatter", mode: "lines", x: X, y: p50, line: { color: c.ink2, width: 1.5 }, name: "Median", hovertemplate: `Median<br><b>%{y:.3~f}</b><extra></extra>` },
    { type: "scatter", mode: "lines", x: X, y: early, line: { color: c.seq0, width: 2 }, name: `First ${k}`, hovertemplate: `First ${k}<br><b>%{y:.3~f}</b><extra></extra>` },
    { type: "scatter", mode: "lines", x: X, y: late, line: { color: c.seq1, width: 2 }, name: `Last ${k}`, hovertemplate: `Last ${k}<br><b>%{y:.3~f}</b><extra></extra>` },
  ], {
    height: 340, margin: { l: 4, r: 12, t: 22, b: 4 }, shapes, annotations, hovermode: "x unified",
    xaxis: { title: { text: "Depth (mm)" }, hoverformat: ".1f" }, yaxis: { title: { text: sig.unit } },
  });
}

function drawFailures(app, d, H, byIdx, hasOk) {
  const c = colors();
  const key = state.signal, sig = SIGNALS[key];
  const M = d.profiles[key], X = d.profiles.depth;
  const all = d.profiles.hole_idx.map((_, i) => i);
  const refIdx = hasOk ? all.filter((i) => byIdx.get(d.profiles.hole_idx[i]).cycle_ok) : all;
  const koIdx = all.filter((i) => !byIdx.get(d.profiles.hole_idx[i]).cycle_ok);
  const [p10, p50, p90] = envelope(M, refIdx);
  const { shapes, annotations } = bandShapes(d, c);
  plot(app.querySelector("#ko"), [
    { type: "scatter", mode: "lines", x: X, y: p90, line: { width: 0 }, hoverinfo: "skip" },
    { type: "scatter", mode: "lines", x: X, y: p10, line: { width: 0 }, fill: "tonexty", fillcolor: rgba("#898781", 0.22), hoverinfo: "skip" },
    { type: "scatter", mode: "lines", x: X, y: p50, line: { color: c.ink2, width: 1.5 }, hoverinfo: "skip" },
    ...koIdx.map((i) => {
      const h = byIdx.get(d.profiles.hole_idx[i]);
      return { type: "scatter", mode: "lines", x: X, y: M[i], line: { color: c.critical, width: 1.2 }, opacity: 0.85,
        hovertemplate: `Cycle ${h.hole_idx} · KO · ${esc(h.signature ?? "")}<br>%{x:.1f} mm · <b>%{y:.3~f} ${sig.unit}</b><extra></extra>` };
    }),
  ], {
    height: 360, margin: { l: 4, r: 12, t: 22, b: 4 }, shapes, annotations, hovermode: "closest",
    xaxis: { title: { text: "Depth (mm)" } }, yaxis: { title: { text: `${sig.label} (${sig.unit})` } },
  });
  const ko = H.filter((h) => !h.cycle_ok);
  table(app.querySelector("#ko-list"), ko, [
    { key: "hole_idx", label: "#", num: true },
    { key: "date", label: "Time", html: (h) => date(h.date) },
    { key: "outcome", label: "Outcome", html: (h) => outcomeBadge(h.outcome) },
    { key: "signature", label: "Step codes", html: (h) => signatureHtml(h.signature, false) },
  ], { sortKey: "hole_idx", sortDir: 1, onRow: (h) => go(cycleHref(d.summary.tool_ref, h.file_id)) });
}

function drawLog(app, H, d) {
  const f = state.logFilter;
  const data = H.filter((h) => f === "all" || (f === "ok") === h.cycle_ok);
  const el = app.querySelector("#log");
  el.replaceWith(el.cloneNode(false)); // drop old listeners
  table(app.querySelector("#log"), data, [
    { key: "hole_idx", label: "#", num: true },
    { key: "date", label: "Time", html: (h) => date(h.date) },
    { key: "outcome", label: "Outcome", html: (h) => outcomeBadge(h.outcome) },
    { key: "signature", label: "Step codes", html: (h) => signatureHtml(h.signature, h.cycle_ok) },
    { key: "cycle_time_s", label: "Cycle time (s)", num: true, html: (h) => fmt(h.cycle_time_s, 1) },
    { key: "distance_mm", label: "Depth (mm)", num: true, html: (h) => fmt(h.distance_mm, 2) },
    { key: "energy_J_per_mm", label: "Spec. energy (J/mm)", num: true, html: (h) => fmt(h.energy_J_per_mm, 0) },
    { key: "torque_p95", label: "Torque P95 (A)", num: true, html: (h) => fmt(h.torque_p95, 2) },
    { key: "thrust_p95", label: "Thrust P95 (A)", num: true, html: (h) => fmt(h.thrust_p95, 2) },
    { key: "outlier", label: "Group outlier", sort: (h) => (h.outlier ? Math.max(...h.outlier.map((r) => Math.abs(r.z))) : null), html: (h) => (h.outlier ? `<span class="outlier-tag">${esc(reasonText(h.outlier))}</span>` : "") },
    { key: "source_file", label: "File", html: (h) => `<span class="mono muted">${esc(h.source_file)}</span>` },
  ], { sortKey: "hole_idx", sortDir: 1, onRow: (h) => go(cycleHref(d.summary.tool_ref, h.file_id)) });
}

function drawCorr(app, d, step, hasOk) {
  const c = colors();
  const F = rows(d.step_feat).filter((r) => r.step === step && (hasOk ? r.cycle_ok : true));
  const keys = ["hole_idx", ...Object.keys(KPIS)];
  const labels = ["Cycle #", ...Object.values(KPIS).map((k) => k.label)];
  const z = keys.map((a) => keys.map((b) => pearson(F.map((r) => r[a]), F.map((r) => r[b]))));
  plot(app.querySelector("#corr"), [{
    type: "heatmap", x: labels, y: labels, z, zmin: -1, zmax: 1, xgap: 2, ygap: 2,
    colorscale: [[0, c.divNeg], [0.5, c.divMid], [1, c.divPos]],
    text: z.map((r) => r.map((v) => (v == null ? "" : v.toFixed(2)))), texttemplate: "%{text}", textfont: { size: 10 },
    colorbar: { thickness: 10, outlinewidth: 0, title: { text: "r", font: { size: 11, color: c.ink2 } }, tickfont: { size: 11, color: c.ink2 } },
    hovertemplate: "%{y} × %{x}<br><b>r = %{z:.2f}</b><extra></extra>",
  }], {
    height: 520, margin: { l: 4, r: 4, t: 8, b: 4 },
    xaxis: { showgrid: false, showline: false, tickangle: -35, ticks: "" },
    yaxis: { showgrid: false, showline: false, autorange: "reversed", ticks: "" },
  });
}
