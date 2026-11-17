// Fleet components: campaign tiles + maker × diameter matrix (Overview), and the tool comparison
// block (bars, table, KO signatures) used by the Group tab for any set of tools.
import {
  esc, fmt, pct, day, diam, colors, plot, outcomeBar, outcomeLegend, tiles, table, info,
  signatureHtml, rollingMedian, MAKERS, DIAMETERS,
} from "./ui.js";
import { go, toolHref } from "./app.js";

export function fleetTiles(fleet) {
  const T = fleet.tools, nOk = fleet.totals.n_ok, n = fleet.totals.n;
  const days = Math.round((new Date(fleet.totals.end) - new Date(fleet.totals.start)) / 864e5) + 1;
  const allKo = T.filter((t) => t.n_ok === 0);
  return tiles([
    ["Tools", String(T.length), `${MAKERS.length} makers · ${DIAMETERS.length} diameters`],
    ["Cycles", fmt(n, 0), `${fmt(nOk, 0)} OK · ${fmt(n - nOk, 0)} KO`],
    ["OK rate", pct(nOk / n, 1), "all tools"],
    ["Tools without OK cycle", String(allKo.length), allKo.map((t) => esc(t.tool_ref)).join(", ") || "none"],
    ["Test window", `${days}<small>days</small>`, `${day(fleet.totals.start)} → ${day(fleet.totals.end)} ${new Date(fleet.totals.end).getFullYear()}`],
  ]);
}

export function matrixHtml(fleet) {
  const byKey = new Map(fleet.tools.map((t) => [`${t.maker}|${t.diameter}`, t]));
  return `<div class="matrix">
    <div class="corner"></div>
    ${DIAMETERS.map((d) => `<div class="colhead">${diam(d)} mm</div>`).join("")}
    ${MAKERS.map((m) => `
      <div class="rowhead"><span class="sw" style="background:var(--${m.toLowerCase()})"></span>${m}</div>
      ${DIAMETERS.map((d) => cell(byKey.get(`${m}|${d}`))).join("")}`).join("")}
  </div>
  <div style="margin-top:10px">${outcomeLegend()}</div>`;
}

// ---- comparison block for a set of tools ----
export function comparisonHtml(T, normalEnd) {
  const ko = T.some((t) => t.n_ko > 0);
  return `
    <div class="grid cols-3">
      ${chartCard("c-energy", "Specific energy", "Median J per mm drilled, OK cycles.",
        "Spindle energy (∫ spindle power dt) divided by the depth reached. Lower means easier cutting. Only compare tools of the same diameter: a bigger drill needs more energy per mm.")}
      ${chartCard("c-dtorque", "Torque drift", "Change in P95 torque from first to last cycles.",
        "Mean P95 torque current of the last 10 % of OK cycles compared with the first 10 %. A rising value at constant set-points is a wear signature.")}
      ${chartCard("c-denergy", "Specific-energy drift", "Change in J/mm from first to last cycles.",
        "Same rule as torque drift, applied to specific energy (last 10 % of OK cycles vs first 10 %).")}
    </div>
    <div class="card" style="margin-top:12px"><div class="card-head"><h3>Tools<span class="sub">Click a row to open the tool.</span></h3></div><div class="table-wrap" id="rank"></div></div>
    ${ko ? `<div class="card" style="margin-top:12px"><div class="card-head"><h3>How KO cycles end<span class="sub">Stop code of each step that ran; the highlighted code is where the cycle ended abnormally.</span></h3>
      ${info(`Every OK cycle ends its last step on code ${normalEnd}. Codes are shown as recorded by the controller; combined codes are not decoded.`)}</div><div class="table-wrap" id="sigs"></div></div>` : ""}`;
}

export function drawComparison(app, T) {
  drawBars(app, T);
  table(app.querySelector("#rank"), T, rankCols(), { sortKey: "tool_ref", sortDir: 1, onRow: (t) => go(toolHref(t.tool_ref)) });
  const ko = T.filter((t) => t.n_ko > 0);
  const sigs = app.querySelector("#sigs");
  if (sigs) table(sigs, ko, [
    { key: "tool_ref", label: "Tool", html: toolCell },
    { key: "n_ko", label: "KO cycles", num: true },
    { key: "sig", label: "Step codes (count ×)", nosort: true, html: (t) =>
      Object.entries(t.ko_signatures).map(([s, c]) => `<span style="margin-right:18px;white-space:nowrap"><b>${c}</b> × ${signatureHtml(s === "none" ? null : s, false)}</span>`).join("") },
  ], { sortKey: "n_ko", onRow: (t) => go(toolHref(t.tool_ref)) });
  app.querySelectorAll("[data-table-toggle]").forEach((b) => b.addEventListener("click", () => {
    const card = b.closest(".card");
    const showTable = card.querySelector(".chart").classList.toggle("hidden");
    card.querySelector(".alt-table").classList.toggle("hidden", !showTable);
    b.textContent = showTable ? "Chart" : "Table";
  }));
}

function toolCell(t) {
  return `<span class="mono">${esc(t.tool_ref)}</span> <span class="muted">${esc(t.maker)} ${diam(t.diameter)}</span>`;
}

function cell(t) {
  if (!t) return `<div class="cell empty">No tool</div>`;
  const sp = t.spark;
  return `<a class="cell" href="${toolHref(t.tool_ref)}" aria-label="${esc(t.label)}, ${t.n_ok} OK cycles out of ${t.n}">
    <div class="top-line"><span class="ref">${esc(t.tool_ref)}</span><span class="muted">${t.n} cycles</span></div>
    <div class="stats"><span><b>${pct(t.ok_rate)}</b> OK</span></div>
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

function chartCard(id, title, sub, how) {
  return `<div class="card">
    <div class="card-head"><h3>${esc(title)}<span class="sub">${esc(sub)}</span></h3>
      ${info(esc(how))}<button class="link-btn" data-table-toggle>Table</button></div>
    <div class="chart" id="${id}" style="height:240px"></div>
    <div class="alt-table hidden table-wrap" id="${id}-t"></div>
  </div>`;
}

function drawBars(app, T) {
  const c = colors();
  const ds = [...new Set(T.map((t) => t.diameter))].sort((a, b) => a - b);
  const specs = [
    { id: "c-energy", key: "energy_mm_med", fmtv: (v) => `${fmt(v, 0)} J/mm` },
    { id: "c-dtorque", key: "drift_torque", fmtv: (v) => pct(v, 0, true), pctAxis: true },
    { id: "c-denergy", key: "drift_energy", fmtv: (v) => pct(v, 0, true), pctAxis: true },
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
    }).filter((tr) => tr.x.length);
    plot(app.querySelector(`#${s.id}`), traces, {
      barmode: "group", height: 240, margin: { l: 4, r: 8, t: 6, b: 4 },
      xaxis: { categoryorder: "array", categoryarray: ds.map(diam), showgrid: false, ticks: "" },
      yaxis: { tickformat: s.pctAxis ? "+.0%" : ",.0f", zeroline: s.pctAxis, zerolinecolor: c.axis, zerolinewidth: 1, title: { text: "" }, rangemode: "tozero" },
    });
    const rows = [...T].sort((a, b) => a.diameter - b.diameter || a.maker.localeCompare(b.maker));
    app.querySelector(`#${s.id}-t`).innerHTML = `<table class="t"><thead><tr><th>Tool</th><th>Ø</th><th class="num">Value</th></tr></thead><tbody>${
      rows.map((t) => `<tr><td>${toolCell(t)}</td><td>${diam(t.diameter)}</td><td class="num">${s.fmtv(t[s.key])}</td></tr>`).join("")}</tbody></table>`;
  }
}

function rankCols() {
  const drift = (k) => (t) => `<span class="${t[k] > 0 ? "pos" : "neg"}">${pct(t[k], 0, true)}</span>`;
  return [
    { key: "tool_ref", label: "Tool", html: toolCell },
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
