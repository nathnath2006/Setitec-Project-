// Settings: appearance, server connections (profiles + live checks), analysis defaults.
import { esc, seg, onSeg, settings, saveSettings, SETTINGS_DEFAULTS, info } from "./ui.js";
import { frame, lastStudy } from "./study.js";

// ---------- appearance ----------
export function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === "light" || mode === "dark") root.dataset.theme = mode; else delete root.dataset.theme;
  try { if (mode === "light" || mode === "dark") localStorage.setItem("setitec.theme", mode); else localStorage.removeItem("setitec.theme"); } catch {}
}
function currentTheme() {
  try { return localStorage.getItem("setitec.theme") || "system"; } catch { return "system"; }
}

// ---------- server profiles ----------
const SERVERS = "setitec.servers";
const DEMO = { id: "demo", kind: "demo", name: "Local demo server", host: "localhost", port: 8050, protocol: "http", auth: "none" };
function store() {
  try {
    const s = JSON.parse(localStorage.getItem(SERVERS) || "null");
    if (s?.profiles?.some((p) => p.id === "demo")) return s;
  } catch {}
  return { active: "demo", profiles: [{ ...DEMO }] };
}
function saveStore(s) { try { localStorage.setItem(SERVERS, JSON.stringify(s)); } catch {} }
export function activeServer() {
  const s = store();
  return s.profiles.find((p) => p.id === s.active) || s.profiles[0];
}
const STATUS = {
  connected: ["ok", "Connected"],
  reachable: ["warn", "Reachable · API not available"],
  unreachable: ["bad", "Unreachable"],
  untested: ["idle", "Not tested"],
};
export function serverStatusHtml(p, compact = false) {
  const st = p.lastTest?.status || "untested";
  const [cls, label] = STATUS[st] || STATUS.untested;
  return `<span class="conn ${cls}"><i></i>${compact ? `${esc(p.name)}` : label}</span>`;
}
const when = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

let selected = null;
const secrets = new Map(); // API keys / passwords: memory only, never written to storage

export function renderSettings(root) {
  const s = settings();
  const theme = currentTheme();
  const st = store();
  if (!st.profiles.some((p) => p.id === selected)) selected = st.active;
  root.innerHTML = frame("settings", lastStudy(), `
    <div class="home-head"><div><h1>Settings</h1></div></div>
    <nav class="settings-nav"><a href="#appearance" data-jump="appearance">Appearance</a><a href="#server" data-jump="server">Server connection</a><a href="#analysis" data-jump="analysis">Analysis</a></nav>

    <section class="settings-section" id="appearance">
      <div class="settings-label"><h2>Appearance</h2><p>Theme of the workbench and its charts.</p></div>
      <div class="theme-options">${[["system", "System", "Follows your computer"], ["light", "Light", "Always light"], ["dark", "Dark", "Always dark"]].map(([v, l, d]) => `
        <label class="theme-card ${theme === v ? "selected" : ""}"><input type="radio" name="theme" value="${v}" ${theme === v ? "checked" : ""}>
          <span class="theme-preview ${v}"><i></i><i></i><i></i></span><b>${l}</b><small>${d}</small></label>`).join("")}</div>
    </section>

    <section class="settings-section" id="server">
      <div class="settings-label"><h2>Server connection</h2><p>Where cycles are synced from.</p>
        ${info("Testing a remote profile runs real checks from this computer: name resolution, TCP connection and, for HTTPS, the TLS certificate. The Setitec API exchange itself is not implemented in this version, so a reachable server stops there. The Local demo server reads the project's local dataset.")}</div>
      <div class="server-layout">
        <div class="server-list">${st.profiles.map((p) => `
          <button type="button" class="server-row ${p.id === selected ? "selected" : ""}" data-profile="${esc(p.id)}">
            <span class="server-row-main"><b>${esc(p.name)}</b><small>${p.kind === "demo" ? "Local dataset" : `${esc(p.protocol.toUpperCase())} · ${esc(p.host)}:${p.port}`}</small></span>
            <span class="server-row-side">${p.id === st.active ? '<span class="active-tag">Active</span>' : ""}${serverStatusHtml(p)}</span>
          </button>`).join("")}
          <button type="button" class="quiet-btn add-server" id="add-server">＋ Add server</button>
        </div>
        <div class="server-editor card" id="server-editor"></div>
      </div>
    </section>

    <section class="settings-section" id="analysis">
      <div class="settings-label"><h2>Analysis</h2><p>Defaults of the Group tab.</p></div>
      <div class="card analysis-form">
        <div class="field-row"><label for="set-z">Outlier threshold</label><div><input id="set-z" type="number" min="1.5" max="10" step="0.5" value="${s.z}"><span class="unit">σ (robust z)</span></div>
          <p>A cycle is an outlier when one feature is further than this from the group median. Lower = more outliers.</p></div>
        <div class="field-row"><label>Number of clusters</label><div class="k-range"><select class="sel" id="set-kmin">${[2, 3, 4, 5, 6].map((k) => `<option${k === s.kmin ? " selected" : ""}>${k}</option>`).join("")}</select><span>to</span>
          <select class="sel" id="set-kmax">${[2, 3, 4, 5, 6, 7, 8].map((k) => `<option${k === s.kmax ? " selected" : ""}>${k}</option>`).join("")}</select></div>
          <p>The best k in this range is picked automatically (silhouette score).</p></div>
        <div class="field-row"><label>Default grouping</label><div>${seg("set-groupby", [["diameter", "Diameter"], ["maker", "Maker"], ["custom", "Custom"]], s.groupBy)}</div>
          <p>How the Group tab groups tools when you open it.</p></div>
        <div class="form-foot"><span class="saved-note" id="saved-note"></span><button type="button" class="quiet-btn" id="reset-analysis">Reset to defaults</button></div>
      </div>
    </section>`);

  return (app) => {
    app.querySelectorAll("[data-jump]").forEach((a) => a.addEventListener("click", (e) => { e.preventDefault(); app.querySelector(`#${a.dataset.jump}`).scrollIntoView({ behavior: "smooth", block: "start" }); }));
    app.querySelectorAll("input[name=theme]").forEach((r) => r.addEventListener("change", () => {
      applyTheme(r.value);
      app.querySelectorAll(".theme-card").forEach((c) => c.classList.toggle("selected", c.contains(r)));
    }));
    // analysis defaults
    const note = app.querySelector("#saved-note");
    const saved = () => { note.textContent = "Saved"; clearTimeout(saved.t); saved.t = setTimeout(() => (note.textContent = ""), 1500); };
    app.querySelector("#set-z").addEventListener("change", (e) => {
      const v = Math.min(10, Math.max(1.5, +e.target.value || SETTINGS_DEFAULTS.z));
      e.target.value = v; saveSettings({ z: v }); saved();
    });
    const kmin = app.querySelector("#set-kmin"), kmax = app.querySelector("#set-kmax");
    const saveK = () => {
      if (+kmax.value < +kmin.value) kmax.value = kmin.value;
      saveSettings({ kmin: +kmin.value, kmax: +kmax.value }); saved();
    };
    kmin.addEventListener("change", saveK); kmax.addEventListener("change", saveK);
    onSeg(app, "set-groupby", (v) => {
      saveSettings({ groupBy: v }); saved();
      app.querySelectorAll('[data-seg="set-groupby"] button').forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === v)));
    });
    app.querySelector("#reset-analysis").addEventListener("click", () => { saveSettings({ ...SETTINGS_DEFAULTS }); renderInto(app); });
    // servers
    bindServers(app);
  };
}

function renderInto(app) {
  const holder = document.createElement("div");
  const after = renderSettings(holder);
  app.replaceChildren(...holder.childNodes);
  after(app);
}

function bindServers(app) {
  app.querySelectorAll("[data-profile]").forEach((b) => b.addEventListener("click", () => { selected = b.dataset.profile; renderInto(app); }));
  app.querySelector("#add-server").addEventListener("click", () => {
    const st = store();
    const p = { id: `srv-${Date.now().toString(36)}`, kind: "remote", name: "New server", host: "", port: 443, protocol: "https", auth: "apikey" };
    st.profiles.push(p); saveStore(st); selected = p.id; renderInto(app);
    app.querySelector("#srv-host")?.focus();
  });
  editor(app);
}

function editor(app) {
  const st = store();
  const p = st.profiles.find((x) => x.id === selected) || st.profiles[0];
  const el = app.querySelector("#server-editor");
  const demo = p.kind === "demo";
  const t = p.lastTest;
  el.innerHTML = `
    <div class="card-head"><h3>${esc(p.name)}<span class="sub">${demo ? "Built-in profile reading the local dataset." : "Remote Setitec server."}</span></h3>${serverStatusHtml(p)}</div>
    <form id="server-form-edit" class="server-fields" autocomplete="off">
      <label>Name<input id="srv-name" value="${esc(p.name)}" ${demo ? "disabled" : ""} required></label>
      <div class="field-pair">
        <label>Host<input id="srv-host" value="${esc(demo ? "localhost (local dataset)" : p.host)}" placeholder="setitec-srv01.plant.local" ${demo ? "disabled" : ""} required></label>
        <label class="port">Port<input id="srv-port" type="number" min="1" max="65535" value="${p.port}" ${demo ? "disabled" : ""} required></label>
      </div>
      <div class="field-pair">
        <label>Protocol<select class="sel" id="srv-protocol" ${demo ? "disabled" : ""}><option value="https"${p.protocol === "https" ? " selected" : ""}>HTTPS</option><option value="http"${p.protocol === "http" ? " selected" : ""}>HTTP</option></select></label>
        <label>Authentication<select class="sel" id="srv-auth" ${demo ? "disabled" : ""}>${[["apikey", "API key"], ["basic", "User name + password"], ["none", "None"]].map(([v, l]) => `<option value="${v}"${p.auth === v ? " selected" : ""}>${l}</option>`).join("")}</select></label>
      </div>
      ${demo ? "" : `<div class="auth-fields" id="auth-fields">${authFields(p)}</div>`}
      <div class="server-actions">
        <button type="button" class="primary-btn" id="srv-test">${demo ? "Connect & sync" : "Test connection"}</button>
        ${demo ? "" : '<button type="submit" class="quiet-btn">Save</button>'}
        ${p.id !== st.active ? '<button type="button" class="quiet-btn" id="srv-activate">Use this server</button>' : ""}
        ${demo ? "" : '<button type="button" class="link-btn danger" id="srv-delete">Delete</button>'}
      </div>
    </form>
    <div class="test-result" id="test-result">${t ? testHtml(t, demo) : '<p class="muted">Not tested yet.</p>'}</div>`;

  const read = () => ({ ...p, name: el.querySelector("#srv-name").value.trim() || "Server", host: el.querySelector("#srv-host").value.trim(),
    port: +el.querySelector("#srv-port").value, protocol: el.querySelector("#srv-protocol").value, auth: el.querySelector("#srv-auth").value });
  const persist = (next) => { const s = store(); s.profiles = s.profiles.map((x) => (x.id === next.id ? next : x)); saveStore(s); };

  el.querySelector("#srv-auth")?.addEventListener("change", () => { el.querySelector("#auth-fields").innerHTML = authFields(read()); bindSecret(); });
  const bindSecret = () => el.querySelectorAll("[data-secret]").forEach((i) => i.addEventListener("input", () => secrets.set(`${p.id}:${i.dataset.secret}`, i.value)));
  bindSecret();
  el.querySelector("#server-form-edit").addEventListener("submit", (e) => {
    e.preventDefault();
    if (demo) return;
    persist({ ...read(), lastTest: p.host === read().host && p.port === read().port ? p.lastTest : undefined });
    renderInto(app);
  });
  el.querySelector("#srv-activate")?.addEventListener("click", () => { const s = store(); s.active = p.id; saveStore(s); renderInto(app); });
  el.querySelector("#srv-delete")?.addEventListener("click", () => {
    if (!confirm(`Delete “${p.name}”?`)) return;
    const s = store(); s.profiles = s.profiles.filter((x) => x.id !== p.id); if (s.active === p.id) s.active = "demo";
    saveStore(s); selected = s.active; renderInto(app);
  });
  el.querySelector("#srv-test").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const cur = demo ? p : read();
    if (!demo && !cur.host) { el.querySelector("#srv-host").focus(); return; }
    btn.disabled = true; btn.textContent = demo ? "Syncing…" : "Testing…";
    el.querySelector("#test-result").innerHTML = `<ol class="test-steps running"><li><span class="step-icon">…</span>${demo ? "Opening local dataset" : `Contacting ${esc(cur.host)}:${cur.port}`}</li></ol>`;
    try {
      const r = await fetch("/api/connection/test", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(demo ? { mode: "demo" } : { host: cur.host, port: cur.port, protocol: cur.protocol }) });
      const res = await r.json();
      if (!r.ok) throw new Error(res.error || "Test failed");
      persist({ ...cur, lastTest: res });
    } catch (err) {
      persist({ ...cur, lastTest: { status: "unreachable", checked: new Date().toISOString(), steps: [{ key: "req", label: "Request", status: "fail", detail: err.message }] } });
    }
    renderInto(app);
  });
}

function authFields(p) {
  const v = (k) => esc(secrets.get(`${p.id}:${k}`) || "");
  if (p.auth === "apikey") return `<label>API key<input type="password" data-secret="key" value="${v("key")}" placeholder="Provided by your administrator"></label><p class="field-hint">Kept in memory for this session only.</p>`;
  if (p.auth === "basic") return `<div class="field-pair"><label>User name<input data-secret="user" value="${v("user")}"></label><label>Password<input type="password" data-secret="pass" value="${v("pass")}"></label></div><p class="field-hint">Kept in memory for this session only.</p>`;
  return "";
}

function testHtml(t, demo) {
  const icon = { ok: "✓", fail: "✕", skip: "–", unavailable: "○" };
  const head = t.status === "connected"
    ? `<div class="test-summary ok"><b>Connected</b> · ${t.tools} tools · ${t.cycles} cycles · synced ${when(t.checked)}</div>`
    : t.status === "reachable"
      ? `<div class="test-summary warn"><b>Server reachable</b> · the Setitec API exchange is not available in this version · checked ${when(t.checked)}</div>`
      : `<div class="test-summary bad"><b>Could not connect</b> · checked ${when(t.checked)}</div>`;
  return `${head}<ol class="test-steps">${t.steps.map((s) => `<li class="${s.status}"><span class="step-icon">${icon[s.status] || "·"}</span><span class="step-label">${esc(s.label)}</span><span class="step-detail">${esc(s.detail || "")}</span><span class="step-ms">${s.ms != null ? `${s.ms} ms` : ""}</span></li>`).join("")}</ol>`;
}
