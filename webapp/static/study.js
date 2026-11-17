// Study workspace: studies list, study shell (sidebar + tabs) and the Overview / Data review /
// Validation tabs. Individual and Group tabs are delegated to tool.js / cycle.js / group.js.
import { esc, fmt, day, info } from "./ui.js";
import { fleetTiles, matrixHtml } from "./fleet.js";
import { renderTool } from "./tool.js";
import { renderCycle } from "./cycle.js";
import { renderGroup } from "./group.js";
import { state, go, toolHref } from "./app.js";
import { activeServer, serverStatusHtml } from "./settings.js";

const STORE = "setitec.studies";
const DEFAULT_ID = "showcase-study";
const TABS = [
  ["overview", "Overview", "⌂"], ["ingest", "Data review", "⇧"], ["individual", "Individual", "◎"],
  ["group", "Group", "⊞"], ["validate", "Validation", "✓"],
];
const lastReports = new Map();

function studies() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || "null");
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {}
  const initial = [{
    id: DEFAULT_ID, name: "Setitec tool performance review", source: "Local dataset",
    folder: "Data/04 Qualification Outils Coupants", dataValidated: false, created: new Date().toISOString(),
  }];
  saveStudies(initial);
  return initial;
}
function saveStudies(items) { try { localStorage.setItem(STORE, JSON.stringify(items)); } catch {} }
function studyById(id) { return studies().find((s) => s.id === id) || studies()[0]; }
const setStudy = (id, patch) => saveStudies(studies().map((s) => s.id === id ? { ...s, ...patch } : s));
const safeDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(+d) ? "—" : `${d.getDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()]} ${d.getFullYear()}`;
};
const short = (value, n = 48) => value.length > n ? `${value.slice(0, n - 1)}…` : value;
function metricTiles(items) {
  return `<div class="tiles">${items.map(([label, value, detail]) => `<div class="tile"><div class="k">${esc(label)}</div><div class="v">${value}</div>${detail ? `<div class="d">${detail}</div>` : ""}</div>`).join("")}</div>`;
}

export function sidebar(active, study = null) {
  const sid = study && encodeURIComponent(study.id);
  return `<aside class="side-nav">
    <div class="side-kicker">WORKSPACE</div>
    <a class="side-link ${active === "studies" ? "active" : ""}" href="#/studies"><span class="side-icon">▦</span>Studies</a>
    ${study ? `<div class="side-study"><span class="study-dot"></span><span title="${esc(study.name)}">${esc(short(study.name, 26))}</span></div>
      ${TABS.map(([key, label, icon]) => `<a class="side-link ${active === key ? "active" : ""}" href="#/study/${sid}/${key}"><span class="side-icon">${icon}</span>${label}${key === "ingest" && study.dataValidated ? '<span class="side-check">✓</span>' : ""}</a>`).join("")}` : ""}
    <div class="side-spacer"></div>
    <a class="side-link ${active === "settings" ? "active" : ""}" href="#/settings"><span class="side-icon">⚙</span>Settings</a>
    <div class="side-user"><span class="avatar">N</span><span><b>Nathan</b><small>${serverStatusHtml(activeServer(), true)}</small></span></div>
  </aside>`;
}
export function lastStudy() {
  const all = studies();
  return all.find((s) => s.id === state.study) || null;
}
export function frame(active, study, content) {
  return `<div class="workbench">${sidebar(active, study)}<div class="work-area">${content}</div></div>`;
}

export function renderStudyHome(root, fleet) {
  const all = studies();
  const cards = all.map((s) => `<a class="study-card" href="#/study/${encodeURIComponent(s.id)}/overview">
    <div class="study-card-head"><span class="study-type">STUDY</span><span class="study-open">Open →</span></div>
    <h2>${esc(s.name)}</h2><p>${esc(s.source)}</p>
    <div class="study-card-foot"><span class="review-chip ${s.dataValidated ? "reviewed" : ""}">${s.dataValidated ? "Data reviewed" : "Data not reviewed"}</span><span>${esc(safeDate(s.created))}</span></div>
  </a>`).join("");
  root.innerHTML = frame("studies", null, `
    <div class="home-head"><div><h1>Studies</h1><p>${fmt(fleet.tools.length, 0)} tools · ${fmt(fleet.totals.n, 0)} cycles in the current dataset.</p></div>
      <button class="primary-btn" id="new-study">＋ New study</button></div>
    <div class="study-grid">${cards}<button class="study-card study-create" id="new-study-card"><span class="create-plus">＋</span><b>New study</b><span>Start from a folder or the local dataset.</span></button></div>`);
  const create = () => {
    const name = window.prompt("Name this study");
    if (!name?.trim()) return;
    const id = `study-${Date.now().toString(36)}`;
    saveStudies([{ id, name: name.trim(), source: "Local dataset", folder: "", dataValidated: false, created: new Date().toISOString() }, ...studies()]);
    location.hash = `#/study/${encodeURIComponent(id)}/overview`;
  };
  root.querySelector("#new-study").addEventListener("click", create);
  root.querySelector("#new-study-card").addEventListener("click", create);
}

// Returns the draw callback of the tab, or false when it redirected.
export async function renderStudy(root, fleet, id, tab = "overview", a, b) {
  const study = studyById(id);
  if (study.id !== id) { go(`#/study/${encodeURIComponent(study.id)}/${tab}`); return false; }
  if (!TABS.some(([key]) => key === tab)) tab = "overview";
  if (tab === "individual" && !a) {
    const ref = fleet.tools.some((t) => t.tool_ref === state.tool) ? state.tool : fleet.tools[0].tool_ref;
    go(toolHref(ref)); return false;
  }
  const sid = encodeURIComponent(study.id);
  const tabs = TABS.map(([key, label]) => `<a href="#/study/${sid}/${key}" class="study-tab ${tab === key ? "active" : ""}">${label}${key === "ingest" && study.dataValidated ? '<span class="tab-check">✓</span>' : ""}</a>`).join("");
  root.innerHTML = frame(tab, study, `
    <div class="study-heading"><div><a class="study-crumb" href="#/studies">Studies</a><h1>${esc(study.name)}</h1></div><button class="quiet-btn" id="rename-study">Rename</button></div>
    <nav class="study-tabs" aria-label="Study sections">${tabs}</nav><div id="study-tab-body"></div>`);
  root.querySelector("#rename-study").addEventListener("click", () => {
    const name = window.prompt("Rename this study", study.name);
    if (name?.trim()) { setStudy(study.id, { name: name.trim() }); dispatchEvent(new HashChangeEvent("hashchange")); }
  });
  const body = root.querySelector("#study-tab-body");
  if (tab === "overview") overview(body, fleet, study);
  if (tab === "ingest") return ingestion(body, study);
  if (tab === "individual") {
    if (!fleet.tools.some((t) => t.tool_ref === a)) { go(toolHref(fleet.tools[0].tool_ref)); return false; }
    state.tool = a;
    if (b != null && /^\d+$/.test(b)) { state.cycle = +b; return renderCycle(body, fleet, +b); }
    return renderTool(body, fleet, a);
  }
  if (tab === "group") return renderGroup(body, fleet);
  if (tab === "validate") validation(body, fleet, study);
  return null;
}

function overview(body, fleet, study) {
  const recent = reviewRecords(study.id);
  const sid = encodeURIComponent(study.id);
  body.innerHTML = `
    ${fleetTiles(fleet)}
    <section>
      <div class="section-head"><h2>Tools by maker and diameter</h2><p>Click a tool to open its individual analysis.</p>
        ${info("Bar = share of OK and KO cycles. Trace = specific energy over the tool's life (thin: each cycle, bold: 9-cycle median). Drift = last 10 % of OK cycles vs first 10 %.")}</div>
      ${matrixHtml(fleet)}
    </section>
    <section>
      <div class="journey-grid">
        <a class="journey-card" href="#/study/${sid}/ingest"><span class="journey-num">01</span><div><h3>Review the data</h3><p>Scan a folder and check files, signals and stop codes.${study.dataValidated ? " <b>Done ✓</b>" : ""}</p></div><span class="journey-arrow">→</span></a>
        <a class="journey-card" href="#/study/${sid}/individual"><span class="journey-num">02</span><div><h3>Analyse one tool</h3><p>Wear trend, depth signature, failures and every cycle.</p></div><span class="journey-arrow">→</span></a>
        <a class="journey-card" href="#/study/${sid}/group"><span class="journey-num">03</span><div><h3>Compare a group</h3><p>Tools of one diameter or maker side by side, clusters and outliers.</p></div><span class="journey-arrow">→</span></a>
        <a class="journey-card" href="#/study/${sid}/validate"><span class="journey-num">04</span><div><h3>Record your validation</h3><p>Your conclusion and rationale, per tool or for the study.${recent.length ? ` <b>${recent.length} saved</b>` : ""}</p></div><span class="journey-arrow">→</span></a>
      </div>
    </section>
    ${recent.length ? `<section><div class="section-head home-section-head"><h2>Latest validations</h2><a href="#/study/${sid}/validate">View all →</a></div><div class="review-list">${recent.slice(0, 3).map(reviewRow).join("")}</div></section>` : ""}`;
}

function ingestion(body, study) {
  const report = lastReports.get(study.id);
  const server = activeServer();
  body.innerHTML = `<div class="ingest-layout"><div class="ingest-main">
      <div class="source-options"><label class="source-card selected"><input type="radio" name="source-type" value="folder" checked><span class="source-glyph">▤</span><span><b>Folder</b><small>Setitec XLS exports or CSV files</small></span><span class="source-check">●</span></label>
        <label class="source-card"><input type="radio" name="source-type" value="server"><span class="source-glyph">⌁</span><span><b>Setitec server</b><small>${esc(server.name)}</small></span><span class="source-check">●</span></label></div>
      <form class="folder-form" id="scan-form"><label for="folder-path">Folder</label><div class="folder-input-row"><input id="folder-path" name="folder" value="${esc(study.folder || "")}" placeholder="Data/04 Qualification Outils Coupants" autocomplete="off"><button class="primary-btn" type="submit">Scan folder <span>→</span></button></div><p class="field-hint">Read-only: files are inspected, not modified or imported.</p><div id="scan-error" class="inline-error hidden"></div></form>
      <div class="server-form hidden" id="server-form"><div class="server-line">${serverStatusHtml(server)}<span class="muted">${esc(server.kind === "demo" ? "Local dataset" : `${server.host}:${server.port}`)}</span></div><a class="quiet-btn" href="#/settings">Manage connections</a></div>
      <div id="scan-result">${report ? reportHtml(report, study) : placeholderReview()}</div>
    </div><aside class="ingest-aside"><div class="side-card"><h3>What the scan checks</h3><ul><li>Readable files and formats</li><li>Export sections and data rows</li><li>Signal columns found</li><li>Missing values and ranges</li><li>Stop-code counts</li><li>Duplicate file names</li></ul></div></aside></div>`;
  body.querySelector("#scan-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const folder = body.querySelector("#folder-path").value.trim();
    const button = body.querySelector("#scan-form button[type=submit]");
    const error = body.querySelector("#scan-error");
    error.classList.add("hidden"); button.disabled = true; button.textContent = "Scanning…";
    try {
      const response = await fetch("/api/ingest/scan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Could not scan that folder");
      lastReports.set(study.id, payload);
      setStudy(study.id, { folder, source: `Folder · ${folder}`, dataValidated: false });
      study.dataValidated = false;
      body.querySelector("#scan-result").innerHTML = reportHtml(payload, study);
      bindReportActions(body, payload, study);
    } catch (err) { error.textContent = err.message; error.classList.remove("hidden"); }
    finally { button.disabled = false; button.innerHTML = 'Scan folder <span>→</span>'; }
  });
  body.querySelectorAll(".source-card input").forEach((input) => input.addEventListener("change", () => {
    body.querySelectorAll(".source-card").forEach((card) => card.classList.toggle("selected", card.contains(input) && input.checked));
    const server = input.value === "server";
    body.querySelector("#scan-form").classList.toggle("hidden", server);
    body.querySelector("#server-form").classList.toggle("hidden", !server);
  }));
  if (report) bindReportActions(body, report, study);
  return null;
}

function placeholderReview() {
  return `<div class="review-empty"><div class="empty-icon">⌕</div><b>No folder scanned yet</b><p>The scan lists files, signals and stop codes so you can judge whether the data is usable.</p></div>`;
}
function reportHtml(report, study) {
  const codeRows = report.stop_codes.length ? report.stop_codes.slice(0, 12).map((r) => `<tr><td class="mono">${r.code}</td><td class="num">${fmt(r.count, 0)}</td></tr>`).join("") : `<tr><td colspan="2" class="muted">No stop-code column</td></tr>`;
  const signalRows = ["Position (mm)", "Torque current (A)", "Thrust current (A)", "Spindle power (W)", "Peck gap (mm)", "Step", "Stop code"].map((name) => {
    const count = report.signal_files[name] || 0;
    return `<div class="signal-row"><span>${esc(name)}</span><b>${fmt(count, 0)} files</b><span class="signal-track"><i style="width:${report.files_found ? Math.round(count / report.files_found * 100) : 0}%"></i></span></div>`;
  }).join("");
  const qualityRows = Object.entries(report.signal_quality || {}).filter(([name]) => !["Step", "Stop code"].includes(name)).map(([name, q]) => {
    const missingPct = q.rows ? `${(q.missing / q.rows * 100).toFixed(1)}%` : "—";
    return `<tr><td>${esc(name)}</td><td class="num">${fmt(q.rows, 0)}</td><td class="num">${missingPct}${q.non_numeric ? ` <span class="muted">· ${fmt(q.non_numeric, 0)} non-numeric</span>` : ""}</td><td class="num">${fmt(q.p50, 3)}</td><td class="num">${fmt(q.p95, 3)}</td><td class="num">${fmt(q.min, 3)} – ${fmt(q.max, 3)}</td></tr>`;
  }).join("");
  const files = report.files.map((f) => `<tr><td title="${esc(f.name)}"><span class="mono file-name">${esc(f.name)}</span></td><td>${esc(f.format.toUpperCase())}</td><td class="num">${fmt(f.rows, 0)}</td><td><span class="file-state ${f.status === "error" ? "error" : f.notes.length ? "note" : ""}">${f.status === "error" ? "Read error" : f.notes.length ? "Check" : "Read"}</span></td><td class="muted">${esc(f.notes.join(" · ") || (f.sections.length ? f.sections.join(", ") : f.signals.join(", ")))}</td></tr>`).join("");
  return `<div class="scan-report"><div class="report-head"><div><span class="report-eyebrow">SCAN COMPLETE</span><h3>${esc(report.folder)}</h3></div><span class="scan-badge">${report.files_with_errors ? `${report.files_with_errors} read issues` : "No read issues"}</span></div>
    ${metricTiles([["Files", fmt(report.files_found, 0), `${report.by_format.xls || 0} XLS · ${report.by_format.csv || 0} CSV`], ["Files read", fmt(report.files_read, 0), `${fmt(report.files_with_errors, 0)} errors`], ["Data rows", fmt(report.data_rows, 0), ""], ["Duplicate names", fmt(report.duplicates, 0), ""]])}
    <div class="grid cols-2 report-grids"><div class="card"><div class="card-head"><h3>Signal coverage<span class="sub">Files containing each signal.</span></h3></div><div class="signal-list">${signalRows}</div></div>
      <div class="card"><div class="card-head"><h3>Stop codes<span class="sub">Occurrences of each recorded code.</span></h3>${info("Counted from step results (XLS) or rows (CSV). Combined codes are shown as recorded, not decoded.")}</div><div class="table-wrap"><table class="t"><thead><tr><th>Code</th><th class="num">Count</th></tr></thead><tbody>${codeRows}</tbody></table></div></div></div>
    <div class="card distribution-card"><div class="card-head"><h3>Signal values<span class="sub">Missing share and value range per signal.</span></h3>${info("P50 and P95 come from a bounded sample of numeric values; the range uses every value read.")}</div><div class="table-wrap"><table class="t"><thead><tr><th>Signal</th><th class="num">Rows</th><th class="num">Missing</th><th class="num">P50</th><th class="num">P95</th><th class="num">Range</th></tr></thead><tbody>${qualityRows || '<tr><td colspan="6" class="muted">No numeric signal columns</td></tr>'}</tbody></table></div></div>
    ${report.sections && Object.keys(report.sections).length ? `<div class="section-head"><h3>Export sections</h3></div><div class="section-pills">${Object.entries(report.sections).map(([name, count]) => `<span class="section-pill">${esc(name)} <b>${count}</b></span>`).join("")}</div>` : ""}
    <div class="card file-table-card"><div class="card-head"><h3>Files<span class="sub">${report.files_truncated ? "First 250 files." : "Per-file result."}</span></h3></div><div class="table-wrap"><table class="t file-table"><thead><tr><th>File</th><th>Type</th><th class="num">Rows</th><th>Status</th><th>Notes</th></tr></thead><tbody>${files || '<tr><td colspan="5" class="muted">No XLS or CSV files found</td></tr>'}</tbody></table></div></div>
    <div class="review-confirm"><div><b>Is this data usable?</b><p>Mark the review as done once you are satisfied with the source.</p></div><button class="primary-btn" id="mark-data-reviewed">${study.dataValidated ? "Data review recorded ✓" : "Mark data as reviewed"}</button></div></div>`;
}
function bindReportActions(root, report, study) {
  root.querySelector("#mark-data-reviewed")?.addEventListener("click", () => {
    setStudy(study.id, { dataValidated: true });
    study.dataValidated = true;
    document.querySelectorAll('a[href$="/ingest"]').forEach((a) => {
      if (!a.querySelector(".tab-check, .side-check")) a.insertAdjacentHTML("beforeend", `<span class="${a.classList.contains("study-tab") ? "tab-check" : "side-check"}">✓</span>`);
    });
    root.querySelector("#scan-result").innerHTML = reportHtml(report, study);
    bindReportActions(root, report, study);
  });
}

function reviewRecords(id) {
  try { return JSON.parse(localStorage.getItem(`setitec.reviews.${id}`) || "[]"); } catch { return []; }
}
function validation(body, fleet, study) {
  const records = reviewRecords(study.id);
  const preset = fleet.tools.some((t) => t.tool_ref === state.tool) ? state.tool : "study";
  body.innerHTML = `<div class="validation-grid"><form class="card validation-form" id="validation-form"><div class="card-head"><h3>Record a validation</h3></div>
      <label for="review-subject">Subject</label><select id="review-subject" class="sel"><option value="study">Whole study</option>${fleet.tools.map((t) => `<option value="${esc(t.tool_ref)}"${t.tool_ref === preset ? " selected" : ""}>${esc(t.tool_ref)} · ${esc(t.maker)} Ø${esc(t.diameter.toFixed(1))} mm</option>`).join("")}</select>
      <label>Conclusion</label><div class="decision-options"><label><input type="radio" name="decision" value="adequate" required><span><b>Performs well</b><small>Validated</small></span></label><label><input type="radio" name="decision" value="concerns"><span><b>Concerns</b><small>Needs attention</small></span></label><label><input type="radio" name="decision" value="inconclusive"><span><b>Inconclusive</b><small>Needs more data</small></span></label></div>
      <label for="reviewer-name">Reviewer <span class="muted">optional</span></label><input id="reviewer-name" placeholder="Name">
      <label for="review-notes">Rationale</label><textarea id="review-notes" rows="4" placeholder="Which cycles, trends or outliers informed this decision?"></textarea>
      <div class="form-foot"><span></span><button class="primary-btn" type="submit">Save validation</button></div></form></div>
    <div class="section-head review-history-head"><h2>History</h2><span>${records.length} record${records.length === 1 ? "" : "s"}</span></div>
    <div class="review-list">${records.length ? records.map(reviewRow).join("") : `<div class="review-empty compact"><b>No validation yet</b></div>`}</div>`;
  body.querySelector("#validation-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const decision = form.querySelector("input[name=decision]:checked")?.value;
    if (!decision) return;
    const subject = form.querySelector("#review-subject");
    const record = { id: `review-${Date.now()}`, subject: subject.value, subjectLabel: subject.selectedOptions[0].textContent,
      decision, reviewer: form.querySelector("#reviewer-name").value.trim(), notes: form.querySelector("#review-notes").value.trim(), date: new Date().toISOString() };
    try { localStorage.setItem(`setitec.reviews.${study.id}`, JSON.stringify([record, ...reviewRecords(study.id)])); } catch {}
    validation(body, fleet, study);
  });
}
function reviewRow(r) {
  const labels = { adequate: "Performs well", concerns: "Concerns", inconclusive: "Inconclusive" };
  return `<article class="review-row"><span class="review-symbol ${r.decision}">${r.decision === "adequate" ? "✓" : r.decision === "concerns" ? "!" : "…"}</span><div class="review-row-main"><div><b>${esc(labels[r.decision] || "Review")}</b><span class="review-subject">${esc(r.subjectLabel || r.subject)}</span></div>${r.notes ? `<p>${esc(r.notes)}</p>` : ""}</div><div class="review-meta">${r.reviewer ? `${esc(r.reviewer)}<br>` : ""}${esc(safeDate(r.date))}</div></article>`;
}
