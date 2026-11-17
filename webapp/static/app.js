// Router + shared state.
// Routes: #/studies · #/settings · #/study/<id>/<tab>[/<tool>[/<file_id>]]
//   tabs: overview · ingest · individual · group · validate
import { get, purge, esc, day } from "./ui.js";
import { renderStudyHome, renderStudy } from "./study.js";
import { renderSettings, applyTheme } from "./settings.js";

const app = document.getElementById("app");
const stored = (() => { try { return JSON.parse(localStorage.getItem("setitec.state") || "{}"); } catch { return {}; } })();
const PERSIST = ["study", "tool", "cycle", "signal", "includeKo", "kpi", "heatMode", "groupBy", "groupKey", "groupCustom", "groupFeatures", "colorBy"];
export const state = {
  study: null, tool: null, cycle: null, signal: "torque", includeKo: true, kpi: "torque_mean", heatMode: "heatmap",
  groupBy: null, groupKey: null, groupCustom: null, groupFeatures: null, colorBy: "cluster",
  ...Object.fromEntries(PERSIST.filter((k) => stored[k] != null).map((k) => [k, stored[k]])),
  logFilter: "all", outlierFilter: "all",
};
function persist() {
  try { localStorage.setItem("setitec.state", JSON.stringify(Object.fromEntries(PERSIST.map((k) => [k, state[k]])))); } catch {}
}
export function setState(patch, rerender = true) {
  Object.assign(state, patch);
  persist();
  if (rerender) route();
}
export const go = (hash) => { location.hash = hash; };

// Links inside the current study
const sid = () => encodeURIComponent(state.study || "showcase-study");
export const tabHref = (tab) => `#/study/${sid()}/${tab}`;
export const toolHref = (ref) => `#/study/${sid()}/individual/${encodeURIComponent(ref)}`;
export const cycleHref = (ref, fileId) => `#/study/${sid()}/individual/${encodeURIComponent(ref)}/${fileId}`;

let token = 0;
async function route() {
  const my = ++token;
  const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  const view = parts[0] || "studies";
  app.classList.add("loading");
  try {
    const fleet = await get("/api/fleet");
    // legacy routes from the first version of the dashboard
    if (view === "fleet") return go(tabHref("group"));
    if (view === "tool") return go(toolHref(parts[1] || fleet.tools[0].tool_ref));
    if (view === "cycle" && parts[1]) { const C = await get(`/api/cycle/${+parts[1]}`); return go(cycleHref(C.tool_ref, C.file_id)); }
    if (view === "preferences") return go("#/settings");
    if (!["studies", "study", "settings"].includes(view)) return go("#/studies");

    const html = document.createElement("div");
    let after;
    if (view === "studies") renderStudyHome(html, fleet);
    else if (view === "settings") after = renderSettings(html, fleet);
    else {
      state.study = parts[1] || "showcase-study";
      after = await renderStudy(html, fleet, state.study, parts[2] || "overview", parts[3], parts[4]);
      if (after === false) return; // redirected
    }
    if (my !== token) return;
    purge(app);
    app.replaceChildren(...html.childNodes);
    after?.(app);
    persist();
    const total = fleet.totals;
    document.getElementById("dataset").textContent = `${fleet.tools.length} tools · ${total.n} cycles · ${day(total.start)} – ${day(total.end)} ${new Date(total.end).getFullYear()}`;
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="startup-error"><h1>Data could not be loaded</h1><p>${esc(e.message)}</p><p>Check that <code>Data/Output Data</code> exists, then restart the server.</p></div>`;
  } finally { if (my === token) app.classList.remove("loading"); }
}

document.getElementById("theme-btn").addEventListener("click", () => {
  const dark = getComputedStyle(document.documentElement).colorScheme.includes("dark");
  applyTheme(dark ? "light" : "dark");
  route();
});
document.getElementById("profile-btn").addEventListener("click", () => go("#/settings"));
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => route());
window.addEventListener("hashchange", () => { window.scrollTo(0, 0); route(); });
route();
