// Group tab: compare a set of tools (one diameter, one maker or a custom pick), then cluster their
// cycles and flag outliers. Computation: /api/group (webapp/analysis.py).
import {
  get, esc, fmt, pct, diam, colors, plot, seg, onSeg, table, info, emptyState, outcomeBadge, settings,
  groupUrl, FEATURES, DEFAULT_FEATURES, tok,
} from "./ui.js";
import { comparisonHtml, drawComparison } from "./fleet.js";
import { state, setState, go, cycleHref, toolHref } from "./app.js";

const catColor = (i) => tok(`cat-${(i % 8) + 1}`);
const lc = (s = "") => s.replace(/^[A-Z][a-z]/, (m) => m.toLowerCase()); // "Torque P95" -> "torque P95"
const lifeText = (v) => (v == null ? "–" : `${Math.round(v * 100)} %`);

function resolveGroup(fleet) {
  const T = fleet.tools;
  const anchor = T.find((t) => t.tool_ref === state.tool) || T[0];
  const by = ["diameter", "maker", "custom"].includes(state.groupBy) ? state.groupBy : settings().groupBy;
  if (by === "custom") {
    const pick = (state.groupCustom || []).filter((r) => T.some((t) => t.tool_ref === r));
    const refs = pick.length ? pick : T.filter((t) => t.diameter === anchor.diameter).map((t) => t.tool_ref);
    return { by, key: null, refs, title: `Custom group · ${refs.length} tool${refs.length === 1 ? "" : "s"}` };
  }
  if (by === "maker") {
    const key = T.some((t) => t.maker === state.groupKey) ? state.groupKey : anchor.maker;
    return { by, key, refs: T.filter((t) => t.maker === key).map((t) => t.tool_ref), title: key };
  }
  const key = T.some((t) => String(t.diameter) === String(state.groupKey)) ? +state.groupKey : anchor.diameter;
  return { by, key, refs: T.filter((t) => t.diameter === key).map((t) => t.tool_ref), title: `${diam(key)} mm` };
}

export async function renderGroup(root, fleet) {
  const g = resolveGroup(fleet);
  const T = fleet.tools.filter((t) => g.refs.includes(t.tool_ref));
  const features = (state.groupFeatures || DEFAULT_FEATURES).filter((f) => FEATURES[f]);
  const feats = features.length >= 2 ? features : DEFAULT_FEATURES;
  let G = null, err = null;
  try { G = await get(groupUrl(g.refs, feats)); } catch (e) { err = e.message; }
  const s = settings();
  const colorBy = state.colorBy === "tool" ? "tool" : "cluster";

  const groupOptions = g.by === "diameter"
    ? [...new Set(fleet.tools.map((t) => t.diameter))].sort((a, b) => a - b).map((d) => [String(d), `${diam(d)} mm · ${fleet.tools.filter((t) => t.diameter === d).length} tools`])
    : [...new Set(fleet.tools.map((t) => t.maker))].sort().map((m) => [m, `${m} · ${fleet.tools.filter((t) => t.maker === m).length} tools`]);

  root.innerHTML = `
  <div class="filters">
    <div class="filter"><span class="lbl">Group by</span>${seg("groupby", [["diameter", "Diameter"], ["maker", "Maker"], ["custom", "Custom"]], g.by)}</div>
    ${g.by === "custom"
      ? `<div class="filter"><span class="lbl">Tools</span><div class="tool-chips">${[...fleet.tools].sort((a, b) => a.diameter - b.diameter || a.maker.localeCompare(b.maker)).map((t) =>
          `<button type="button" class="chip" data-tool="${esc(t.tool_ref)}" aria-pressed="${g.refs.includes(t.tool_ref)}" title="${esc(t.maker)} ${diam(t.diameter)}"><span class="sw" style="background:var(--${t.maker.toLowerCase()})"></span>${esc(t.tool_ref.replace("DT000", ""))} <span class="muted">${diam(t.diameter)}</span></button>`).join("")}</div></div>`
      : `<div class="filter"><span class="lbl">Group</span><select class="sel" id="group-key">${groupOptions.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(g.key) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></div>`}
  </div>
  <div class="tool-head"><h2>${esc(g.title)}</h2>
    <div class="meta">${T.map((t) => `<a class="tool-link" href="${toolHref(t.tool_ref)}"><span class="sw" style="background:var(--${t.maker.toLowerCase()})"></span><span class="mono">${esc(t.tool_ref)}</span> ${esc(t.maker)} ${diam(t.diameter)}</a>`).join("")}</div></div>

  <section>
    <div class="section-head"><h2>Comparison</h2><p>The tools of this group side by side.</p></div>
    ${comparisonHtml(T, fleet.normal_end_code)}
  </section>

  <section>
    <div class="section-head"><h2>Cycle map</h2><p>Each dot is one cycle; cycles that behave alike sit close together.</p>
      ${info(methodHtml(G, s))}</div>
    <div class="feature-bar"><span class="lbl">Features</span>${Object.entries(FEATURES).map(([k, f]) =>
      `<button type="button" class="chip feature-chip" data-feature="${k}" aria-pressed="${feats.includes(k)}"${feats.includes(k) && feats.length <= 2 ? " disabled title=\"At least two features\"" : ""}>${esc(f.label)}</button>`).join("")}</div>
    ${err ? `<div class="card">${emptyState(err)}</div>` : `
    <div class="method-line">${methodLine(G, s)}</div>
    <div class="grid cols-2-1">
      <div class="card"><div class="card-head"><h3>Cycles by similarity<span class="sub">Click a cycle to open it.</span></h3>${seg("colorby", [["cluster", "Colour by cluster"], ["tool", "Colour by tool"]], colorBy)}</div>
        <div class="legend" id="map-legend"></div><div class="chart" id="map" style="height:440px"></div></div>
      <div class="card"><div class="card-head"><h3>Clusters<span class="sub">Groups of cycles found by k-means.</span></h3></div><div id="cluster-cards" class="cluster-cards"></div></div>
    </div>`}
  </section>

  ${G ? `<section>
    <div class="section-head"><h2>Outliers</h2><p>${G.points.outlier.filter(Boolean).length} cycles with at least one feature beyond ${G.z_threshold}σ of the group.</p>
      ${info(`Robust z = (value − group median) ÷ spread, where spread is the median absolute deviation (scaled to match a standard deviation, and never smaller than the mean absolute deviation, so a feature where most cycles share one value cannot explode). Both are taken on the ${G.basis === "ok" ? "OK" : ""} cycles of the group. Robust statistics are not pulled by the outliers themselves. KO cycles are scored against the same baseline, so an aborted cycle usually shows a short cycle time. Change the threshold in Settings.`)}
      <div class="controls">${seg("outf", [["all", "All"], ["ok", "OK cycles"], ["ko", "KO cycles"]], state.outlierFilter)}</div></div>
    <div class="card"><div class="t-scroll" id="outliers" style="max-height:380px"></div></div>
  </section>

  <section>
    <div class="section-head"><h2>Cluster profiles</h2><p>How far each cluster sits from the group median, per feature.</p>
      ${info("Cell = median robust z of the cluster's cycles. Red: higher than the group, blue: lower. |z| ≥ 0.75 is listed as a trait. Life position = median place of the cluster's cycles in their tool's life (0 % first cycle, 100 % last).")}</div>
    <div class="card"><div class="chart" id="profiles" style="height:${90 + G.clusters.length * 46}px"></div></div>
    <div class="card" style="margin-top:12px"><div class="table-wrap" id="cluster-table"></div></div>
  </section>` : ""}`;

  return (app) => {
    onSeg(app, "groupby", (v) => setState({ groupBy: v, groupKey: null }));
    app.querySelector("#group-key")?.addEventListener("change", (e) => setState({ groupKey: e.target.value }));
    app.querySelectorAll("[data-tool]").forEach((b) => b.addEventListener("click", () => {
      const r = b.dataset.tool;
      const next = g.refs.includes(r) ? g.refs.filter((x) => x !== r) : [...g.refs, r];
      if (next.length) setState({ groupCustom: next });
    }));
    app.querySelectorAll("[data-feature]").forEach((b) => b.addEventListener("click", () => {
      const f = b.dataset.feature;
      const next = feats.includes(f) ? feats.filter((x) => x !== f) : [...feats, f];
      if (next.length >= 2) setState({ groupFeatures: Object.keys(FEATURES).filter((k) => next.includes(k)) });
    }));
    drawComparison(app, T);
    if (!G) return;
    onSeg(app, "colorby", (v) => setState({ colorBy: v }));
    onSeg(app, "outf", (v) => { state.outlierFilter = v; app.querySelectorAll('[data-seg="outf"] button').forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === v))); drawOutliers(app, G); });
    drawMap(app, G, colorBy, fleet);
    clusterCards(app, G);
    drawOutliers(app, G);
    drawProfiles(app, G);
  };
}

// ---------------------------------------------------------------------------------------------
function methodLine(G, s) {
  const bits = [
    `<b>${G.k}</b> cluster${G.k === 1 ? "" : "s"}${G.silhouette != null ? ` <span class="muted">(silhouette ${fmt(G.silhouette, 2)})</span>` : ""}`,
    `baseline <b>${G.n_fit}</b> ${G.basis === "ok" ? "OK" : "cycles (no OK cycles: all cycles used)"} of ${G.n}`,
    `outlier threshold <b>${G.z_threshold}σ</b> <a href="#/settings">change</a>`,
  ];
  if (G.normalised) bits.push("values divided by the median of their diameter");
  if (G.n_excluded) bits.push(`${G.n_excluded} cycles without features excluded`);
  return bits.join('<span class="dot-sep">·</span>');
}
function methodHtml(G, s) {
  const pcs = G ? G.loadings.map((l, i) => `<b>Axis ${i + 1}</b> (${pct(G.explained[i], 0)} of the spread): mostly ${l.slice(0, 3).map((x) => `${x.weight > 0 ? "+" : "−"}${FEATURES[x.feature]?.label}`).join(", ")}.`).join("<br>") : "";
  return `Each cycle is described by the selected features, scaled as robust z-scores. The map projects them on the two directions where cycles differ most (PCA), so distance on the map ≈ difference in behaviour.<br><br>
    ${pcs}<br><br>Clusters: k-means on the same scores, k between ${s.kmin} and ${s.kmax} chosen by silhouette (higher = better separated). Fitted on OK cycles; KO cycles are placed afterwards (hollow dots). ● OK · ○ KO · × outlier.`;
}

function rows(G) {
  const P = G.points;
  return P.file_id.map((f, i) => ({
    i, file_id: f, tool_ref: P.tool_ref[i], hole_idx: P.hole_idx[i], cycle_ok: P.cycle_ok[i], outcome: P.outcome[i],
    pc1: P.pc1[i], pc2: P.pc2[i], cluster: P.cluster[i], outlier: P.outlier[i], reasons: P.reasons[i],
  }));
}

function drawMap(app, G, colorBy, fleet) {
  const c = colors();
  const R = rows(G);
  const tools = G.tools;
  const makerOf = new Map(fleet.tools.map((t) => [t.tool_ref, t.maker]));
  const oneEach = new Set(tools.map((r) => makerOf.get(r))).size === tools.length;
  const toolColor = (r, i) => (oneEach ? c.maker[makerOf.get(r)] : catColor(i));
  const groups = colorBy === "cluster"
    ? G.clusters.map((cl) => ({ key: cl.id, label: `Cluster ${cl.name}`, color: catColor(cl.id), pts: R.filter((p) => p.cluster === cl.id) }))
    : tools.map((r, i) => ({ key: r, label: r, color: toolColor(r, i), pts: R.filter((p) => p.tool_ref === r) }));
  const featLine = (p) => G.features.map((f) => `${f.label}: ${fmt(G.points.values[f.key][p.i], 2)} ${f.unit}`).join("<br>");
  const traces = groups.map((gr) => ({
    type: "scatter", mode: "markers", x: gr.pts.map((p) => p.pc1), y: gr.pts.map((p) => p.pc2), name: gr.label,
    marker: {
      size: gr.pts.map((p) => (p.outlier ? 10 : 8)), color: gr.color,
      symbol: gr.pts.map((p) => (p.outlier ? "x-thin" : p.cycle_ok ? "circle" : "circle-open")),
      line: { width: gr.pts.map((p) => (p.outlier ? 2.2 : p.cycle_ok ? 1 : 1.6)), color: gr.pts.map((p) => (p.outlier || !p.cycle_ok ? gr.color : c.surface)) },
      opacity: 0.9,
    },
    customdata: gr.pts.map((p) => [p.file_id, p.tool_ref]),
    text: gr.pts.map((p) => `<b>${p.tool_ref} · cycle ${p.hole_idx}</b> · ${p.cycle_ok ? "OK" : "KO"} · cluster ${G.clusters[p.cluster]?.name ?? "–"}${p.outlier ? `<br><b>Outlier:</b> ${p.reasons.map((r) => `${FEATURES[r.feature]?.label} ${r.z > 0 ? "+" : "−"}${Math.abs(r.z).toFixed(1)}σ`).join(", ")}` : ""}<br>${featLine(p)}`),
    hovertemplate: "%{text}<extra></extra>",
  }));
  // direct labels: cluster letter at its median position
  const annotations = colorBy === "cluster" ? G.clusters.map((cl) => {
    const members = R.filter((p) => p.cluster === cl.id);
    const fitted = members.filter((p) => G.basis === "all" || p.cycle_ok);
    const src = fitted.length ? fitted : members;
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    return { x: med(src.map((p) => p.pc1)), y: med(src.map((p) => p.pc2)), text: `<b>${cl.name}</b>`, showarrow: false,
      font: { size: 14, color: c.ink }, bgcolor: c.surface, bordercolor: catColor(cl.id), borderwidth: 1.5, borderpad: 3, opacity: 0.95 };
  }) : [];
  const el = app.querySelector("#map");
  plot(el, traces, {
    height: 440, margin: { l: 4, r: 8, t: 8, b: 4 }, hovermode: "closest", annotations,
    xaxis: { title: { text: `Axis 1 · ${pct(G.explained[0], 0)} of the spread` }, zeroline: true, zerolinecolor: c.grid },
    yaxis: { title: { text: `Axis 2 · ${pct(G.explained[1] ?? 0, 0)}` }, zeroline: true, zerolinecolor: c.grid },
  });
  el.on?.("plotly_click", (e) => { const [f, ref] = e.points[0].customdata; go(cycleHref(ref, f)); });
  app.querySelector("#map-legend").innerHTML = groups.map((gr) => `<span><i class="dot" style="background:${gr.color}"></i>${esc(gr.label)} <span class="muted">${gr.pts.length}</span></span>`).join("")
    + `<span class="legend-sep"></span><span>● OK</span><span>○ KO</span><span>× outlier</span>`;
}

function traitText(cl) {
  if (!cl.traits.length) return "Close to the group median";
  return cl.traits.slice(0, 3).map((t) => `${t.z > 0 ? "higher" : "lower"} ${lc(FEATURES[t.feature]?.label)}`).join(", ").replace(/^./, (m) => m.toUpperCase());
}

function clusterCards(app, G) {
  app.querySelector("#cluster-cards").innerHTML = G.clusters.map((cl) => {
    const tools = Object.entries(cl.tools).sort((a, b) => b[1] - a[1]);
    return `<div class="cluster-card" style="border-left-color:${catColor(cl.id)}">
      <div class="cluster-title"><b>Cluster ${cl.name}</b><span class="muted">${cl.n} cycles</span></div>
      <div class="cluster-trait">${esc(traitText(cl))}</div>
      <div class="cluster-meta"><span>${cl.n_ok} OK · ${cl.n_ko} KO</span><span>${cl.n_outliers} outliers</span><span>life ${lifeText(cl.life_median)}</span></div>
      <div class="cluster-tools">${tools.map(([r, n]) => `<span class="mono">${esc(r)}</span> <b>${n}</b>`).join('<span class="dot-sep">·</span>')}</div>
    </div>`;
  }).join("");
}

function drawOutliers(app, G) {
  const f = state.outlierFilter;
  const R = rows(G).filter((p) => p.outlier && (f === "all" || (f === "ok") === p.cycle_ok));
  const el = app.querySelector("#outliers");
  const fresh = el.cloneNode(false); el.replaceWith(fresh);
  if (!R.length) { fresh.innerHTML = emptyState("No outlier for this filter."); return; }
  const unit = Object.fromEntries(G.features.map((x) => [x.key, x.unit]));
  table(fresh, R, [
    { key: "tool_ref", label: "Tool", html: (p) => `<span class="mono">${esc(p.tool_ref)}</span>` },
    { key: "hole_idx", label: "Cycle #", num: true },
    { key: "outcome", label: "Outcome", html: (p) => outcomeBadge(p.outcome) },
    { key: "cluster", label: "Cluster", html: (p) => `<span class="cluster-pill" style="border-color:${catColor(p.cluster)}">${G.clusters[p.cluster]?.name ?? "–"}</span>` },
    { key: "score", label: "Why", sort: (p) => Math.max(...p.reasons.map((r) => Math.abs(r.z))), html: (p) => p.reasons.map((r) =>
      `<span class="reason"><b>${esc(FEATURES[r.feature]?.label)}</b> ${r.z > 0 ? "+" : "−"}${Math.abs(r.z).toFixed(1)}σ <span class="muted">(${fmt(r.value, 2)} ${unit[r.feature]})</span></span>`).join("") },
  ], { sortKey: "score", sortDir: -1, onRow: (p) => go(cycleHref(p.tool_ref, p.file_id)) });
}

function drawProfiles(app, G) {
  const c = colors();
  const z = G.clusters.map((cl) => G.features.map((f) => cl.median_z[f.key]));
  plot(app.querySelector("#profiles"), [{
    type: "heatmap", x: G.features.map((f) => f.label), y: G.clusters.map((cl) => `Cluster ${cl.name}`), z, zmin: -3, zmax: 3, xgap: 2, ygap: 2,
    colorscale: [[0, c.divNeg], [0.5, c.divMid], [1, c.divPos]],
    text: z.map((r) => r.map((v) => (v == null ? "" : `${v > 0 ? "+" : ""}${v.toFixed(1)}`))), texttemplate: "%{text}", textfont: { size: 12 },
    colorbar: { thickness: 10, outlinewidth: 0, title: { text: "z", font: { size: 11, color: c.ink2 } }, tickfont: { size: 11, color: c.ink2 } },
    hovertemplate: "%{y} · %{x}<br><b>median z %{z:.2f}</b><extra></extra>",
  }], {
    height: 90 + G.clusters.length * 46, margin: { l: 4, r: 4, t: 8, b: 4 },
    xaxis: { showgrid: false, showline: false, ticks: "", side: "top" }, yaxis: { showgrid: false, showline: false, ticks: "", autorange: "reversed" },
  });
  const unit = Object.fromEntries(G.features.map((x) => [x.key, x.unit]));
  app.querySelector("#cluster-table").innerHTML = `<table class="t"><thead><tr><th>Cluster</th><th class="num">Cycles</th><th class="num">OK</th><th class="num">KO</th><th class="num">Outliers</th><th class="num">Life position</th>${
    G.features.map((f) => `<th class="num">${esc(f.label)} (${f.unit})</th>`).join("")}<th>Tools</th></tr></thead><tbody>${G.clusters.map((cl) => `<tr>
      <td><span class="cluster-pill" style="border-color:${catColor(cl.id)}">${cl.name}</span> ${esc(traitText(cl))}</td><td class="num">${cl.n}</td><td class="num">${cl.n_ok}</td><td class="num">${cl.n_ko}</td><td class="num">${cl.n_outliers}</td><td class="num">${lifeText(cl.life_median)}</td>
      ${G.features.map((f) => `<td class="num">${fmt(cl.raw_median[f.key], 2)}</td>`).join("")}
      <td>${Object.entries(cl.tools).sort((a, b) => b[1] - a[1]).map(([r, n]) => `<span class="mono">${esc(r)}</span> ${n}`).join(", ")}</td></tr>`).join("")}</tbody></table>
    <p class="note">Feature columns: median raw value of the cluster${G.normalised ? " (before diameter scaling)" : ""}.</p>`;
}
