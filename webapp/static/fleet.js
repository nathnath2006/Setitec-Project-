// Fleet view: every tool of the campaign side by side (reliability + wear).
import {
  esc, fmt, pct, day, diam, colors, plot, statusBadge, outcomeBar, outcomeLegend, tiles, table,
  signatureHtml, rollingMedian, MAKERS, DIAMETERS,
} from "./ui.js";
import { go } from "./app.js";

export async function renderFleet(root, fleet) {
  const T = fleet.tools;
  const rule = fleet.status_rule;
  const nOk = fleet.totals.n_ok, n = fleet.totals.n;
  const alerts = T.filter((t) => t.status === "alert"), watch = T.filter((t) => t.status === "watch");
  const days = Math.round((new Date(fleet.totals.end) - new Date(fleet.totals.start)) / 864e5) + 1;
  const byKey = new Map(T.map((t) => [`${t.maker}|${t.diameter}`, t]));

  root.innerHTML = `
  <div class="page-head"><div class="titles">
    <h1>Fleet overview</h1>
    <p class="subtitle">${T.length} drills from ${MAKERS.length} manufacturers, qualified on ${DIAMETERS.length} diameters. One cycle = one drilled hole, recorded at 100&nbsp;Hz.
    Tools are compared on <b>reliability</b> (cycle outcome) and <b>wear</b> (how cutting effort drifts over the tool's life).</p>
  </div></div>

  ${tiles([
    ["Cycles recorded", fmt(n, 0), `${fmt(nOk, 0)} OK · ${fmt(n - nOk, 0)} KO`],
    ["Fleet OK rate", pct(nOk / n, 1), "share of cycles completed normally"],
    ["Tools on alert", String(alerts.length), alerts.map((t) => esc(t.tool_ref)).join(", ") || "none"],
    ["Tools on watch", String(watch.length), watch.map((t) => esc(t.tool_ref)).join(", ") || "none"],
    ["Test window", `${days}<small>days</small>`, `${day(fleet.totals.start)} → ${day(fleet.totals.end)} ${new Date(fleet.totals.end).getFullYear()}`],
  ])}

  <section>
    <div class="section-head">
      <h2>Qualification matrix</h2>
      <p>Manufacturer × diameter. Status is set by the OK rate: Stable ≥ ${pct(rule.watch_below)}, Watch ${pct(rule.alert_below)}–${pct(rule.watch_below)}, Alert &lt; ${pct(rule.alert_below)}.
      The trace is specific energy per cycle over the tool's life (thin: each cycle, bold: 9-cycle median).</p>
    </div>
    <div class="matrix">
      <div class="corner"></div>
      ${DIAMETERS.map((d) => `<div class="colhead">${diam(d)} mm</div>`).join("")}
      ${MAKERS.map((m) => `
        <div class="rowhead"><span class="sw" style="background:var(--${m.toLowerCase()})"></span>${m}</div>
        ${DIAMETERS.map((d) => cell(byKey.get(`${m}|${d}`))).join("")}`).join("")}
    </div>
    <div style="margin-top:10px">${outcomeLegend()}</div>
  </section>

  <section>
    <div class="section-head">
      <h2>Cutting effort and wear, by diameter</h2>
      <p>Compare manufacturers within a diameter group only: a larger drill needs more energy per mm. Drift = mean of the last 10&nbsp;% of OK cycles vs the first 10&nbsp;%.</p>
      <div class="legend controls">${MAKERS.map((m) => `<span><i style="background:var(--${m.toLowerCase()})"></i>${m}</span>`).join("")}</div>
    </div>
    <div class="grid cols-3">
      ${chartCard("c-energy", "Specific energy", "Median of OK cycles · J per mm drilled")}
      ${chartCard("c-dtorque", "Torque drift", "P95 torque current · first → last 10 % of cycles")}
      ${chartCard("c-denergy", "Specific-energy drift", "J/mm · first → last 10 % of cycles")}
    </div>
  </section>

  <section>
    <div class="section-head">
      <h2>Tool ranking</h2>
      <p>Click a column to sort, a row to open the tool.</p>
    </div>
    <div class="card"><div class="table-wrap" id="rank"></div></div>
  </section>

  <section>
    <div class="section-head">
      <h2>How KO cycles end</h2>
      <p>Every OK cycle ends its last step on stop code ${fleet.normal_end_code}. A signature lists the stop code of each step actually run; the highlighted code is where the cycle departed from normal.</p>
    </div>
    <div class="card"><div class="table-wrap" id="sigs"></div></div>
  </section>

  <footer class="foot">
    <p><b>Specific energy</b> = spindle energy (∫ spindle power dt) ÷ depth reached. <b>P95 torque</b> = 95th percentile of the spindle current over the cycle.
    Drift is computed on OK cycles only${T.some((t) => t.drift_basis === "all") ? ` (on all cycles for ${T.filter((t) => t.drift_basis === "all").map((t) => t.tool_ref).join(", ")}, which has no OK cycle)` : ""}.</p>
    <p>Stop-code meanings are not documented in the source files; they are reported as raw codes.</p>
  </footer>`;

  return (app) => {
    drawComparisons(app, T);
    table(app.querySelector("#rank"), T, rankCols(), {
      sortKey: "ok_rate", sortDir: 1, onRow: (t) => go(`#/tool/${t.tool_ref}`),
    });
    const ko = T.filter((t) => t.n_ko > 0);
    table(app.querySelector("#sigs"), ko, [
      { key: "tool_ref", label: "Tool", html: toolCell },
      { key: "n_ko", label: "KO cycles", num: true },
      { key: "ok_rate", label: "OK rate", num: true, html: (t) => pct(t.ok_rate) },
      { key: "sig", label: "Signatures (count × step codes)", nosort: true, html: (t) =>
        Object.entries(t.ko_signatures).map(([s, c]) => `<span style="margin-right:18px;white-space:nowrap"><b>${c}</b> × ${signatureHtml(s === "none" ? null : s, false)}</span>`).join("") },
    ], { sortKey: "n_ko", onRow: (t) => go(`#/tool/${t.tool_ref}`) });
    app.querySelectorAll("[data-table-toggle]").forEach((b) => b.addEventListener("click", () => {
      const card = b.closest(".card");
      const showTable = card.querySelector(".chart").classList.toggle("hidden");
      card.querySelector(".alt-table").classList.toggle("hidden", !showTable);
      b.textContent = showTable ? "Chart" : "Table";
    }));
  };
}

function toolCell(t) {
  return `<span class="mono">${esc(t.tool_ref)}</span> <span class="muted">${esc(t.maker)} ${diam(t.diameter)}</span>`;
}

function cell(t) {
  if (!t) return `<div class="cell empty">Not in campaign</div>`;
  const sp = t.spark;
  return `<a class="cell" href="#/tool/${esc(t.tool_ref)}" aria-label="${esc(t.label)}, ${t.status}, ${pct(t.ok_rate)} OK">
    <div class="top-line"><span class="ref">${esc(t.tool_ref)}</span>${statusBadge(t.status)}</div>
    <div class="stats"><span><b>${pct(t.ok_rate)}</b> OK</span><span>${t.n} cycles</span></div>
    ${outcomeBar(t.outcomes, t.n)}
    ${sparkline(sp.hole_idx, sp.energy, `var(--${t.maker.toLowerCase()})`)}
    <div class="spark-cap"><span>${fmt(t.energy_mm_med, 0)} J/mm</span><span>drift ${pct(t.drift_energy, 0, true)}</span></div>
  </a>`;
}

function sparkline(xs, ys, color) {
  const pts = xs.map((x, i) => [x, ys[i]]).filter(([, y]) => y != null);
  if (pts.length < 2) return `<svg class="spark"></svg>`;
  const W = 200, H = 34, pad = 3;
  const sorted = pts.map((p) => p[1]).sort((a, b) => a - b);
  // clip to P2–P98 so a single outlier does not flatten the trace
  const lo = sorted[Math.floor(sorted.length * 0.02)], hi = sorted[Math.ceil(sorted.length * 0.98) - 1];
  const x0 = pts[0][0], x1 = pts[pts.length - 1][0];
  const sx = (x) => pad + ((x - x0) / (x1 - x0 || 1)) * (W - 2 * pad);
  const sy = (y) => H - pad - ((Math.min(hi, Math.max(lo, y)) - lo) / (hi - lo || 1)) * (H - 2 * pad);
  const path = (arr) => arr.map(([x, y], i) => `${i ? "L" : "M"}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join("");
  const med = rollingMedian(pts.map((p) => p[1]), 9);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${path(pts)}" fill="none" stroke="var(--axis)" stroke-width="1" vector-effect="non-scaling-stroke"/>
    <path d="${path(pts.map((p, i) => [p[0], med[i]]))}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function chartCard(id, title, sub) {
  return `<div class="card">
    <div class="card-head"><h3>${esc(title)}<span class="sub">${esc(sub)}</span></h3>
      <button class="link-btn" data-table-toggle>Table</button></div>
    <div class="chart" id="${id}" style="height:260px"></div>
    <div class="alt-table hidden table-wrap" id="${id}-t"></div>
  </div>`;
}

function drawComparisons(app, T) {
  const c = colors();
  const specs = [
    { id: "c-energy", key: "energy_mm_med", fmtv: (v) => `${fmt(v, 0)} J/mm`, axis: "J/mm" },
    { id: "c-dtorque", key: "drift_torque", fmtv: (v) => pct(v, 0, true), axis: "change", pctAxis: true },
    { id: "c-denergy", key: "drift_energy", fmtv: (v) => pct(v, 0, true), axis: "change", pctAxis: true },
  ];
  for (const s of specs) {
    const traces = MAKERS.map((m) => {
      const rows = T.filter((t) => t.maker === m);
      return {
        type: "bar", name: m, x: rows.map((t) => diam(t.diameter)), y: rows.map((t) => t[s.key]),
        marker: { color: c.maker[m], cornerradius: 3 }, width: 0.22,
        customdata: rows.map((t) => [t.tool_ref, s.fmtv(t[s.key])]),
        hovertemplate: `%{customdata[0]} · ${m} %{x}<br><b>%{customdata[1]}</b><extra></extra>`,
      };
    });
    plot(app.querySelector(`#${s.id}`), traces, {
      barmode: "group", height: 260, margin: { l: 4, r: 8, t: 6, b: 4 },
      xaxis: { categoryorder: "array", categoryarray: DIAMETERS.map(diam), showgrid: false, ticks: "" },
      yaxis: { tickformat: s.pctAxis ? "+.0%" : ",.0f", zeroline: s.pctAxis, zerolinecolor: c.axis, zerolinewidth: 1, title: { text: "" }, rangemode: "tozero" },
    });
    // table twin
    const rows = [...T].sort((a, b) => a.diameter - b.diameter || a.maker.localeCompare(b.maker));
    app.querySelector(`#${s.id}-t`).innerHTML = `<table class="t"><thead><tr><th>Tool</th><th>Ø</th><th class="num">Value</th></tr></thead><tbody>${
      rows.map((t) => `<tr><td>${toolCell(t)}</td><td>${diam(t.diameter)}</td><td class="num">${s.fmtv(t[s.key])}</td></tr>`).join("")}</tbody></table>`;
  }
}

function rankCols() {
  const drift = (k) => (t) => `<span class="${t[k] > 0 ? "pos" : "neg"}">${pct(t[k], 0, true)}</span>`;
  return [
    { key: "tool_ref", label: "Tool", html: toolCell },
    { key: "status", label: "Status", html: (t) => statusBadge(t.status), sort: (t) => t.ok_rate },
    { key: "n", label: "Cycles", num: true },
    { key: "ok_rate", label: "OK rate", num: true, html: (t) => pct(t.ok_rate, 1) },
    { key: "outcomes", label: "Outcomes", nosort: true, html: (t) => `<div style="width:120px">${outcomeBar(t.outcomes, t.n)}</div>` },
    { key: "cycle_time_med", label: "Cycle time (s)", num: true, html: (t) => fmt(t.cycle_time_med, 0), title: "Median, OK cycles" },
    { key: "depth_med", label: "Depth (mm)", num: true, html: (t) => fmt(t.depth_med, 1), title: "Median depth reached, OK cycles" },
    { key: "energy_mm_med", label: "Spec. energy (J/mm)", num: true, html: (t) => fmt(t.energy_mm_med, 0), title: "Median, OK cycles" },
    { key: "drift_energy", label: "Energy drift", num: true, html: drift("drift_energy") },
    { key: "drift_torque", label: "Torque P95 drift", num: true, html: drift("drift_torque") },
    { key: "start", label: "Tested", html: (t) => `${day(t.start)} <span class="muted">· ${fmt(t.span_h, 1)} h</span>` },
  ];
}
