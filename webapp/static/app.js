// Router + shared state. Routes: #/fleet · #/tool/<ref> · #/cycle/<file_id>
import { get, purge, esc, day } from "./ui.js";
import { renderFleet } from "./fleet.js";
import { renderTool } from "./tool.js";
import { renderCycle } from "./cycle.js";

const app = document.getElementById("app");

const stored = (() => { try { return JSON.parse(localStorage.getItem("setitec.state") || "{}"); } catch { return {}; } })();
export const state = {
  tool: stored.tool ?? null,
  cycle: stored.cycle ?? null,
  signal: stored.signal ?? "torque",
  includeKo: stored.includeKo ?? true,
  kpi: stored.kpi ?? "torque_mean",
  heatMode: stored.heatMode ?? "heatmap",
  logFilter: "all",
};
export function setState(patch, rerender = true) {
  Object.assign(state, patch);
  try {
    const { tool, cycle, signal, includeKo, kpi, heatMode } = state;
    localStorage.setItem("setitec.state", JSON.stringify({ tool, cycle, signal, includeKo, kpi, heatMode }));
  } catch {}
  if (rerender) route();
}
export const go = (hash) => { location.hash = hash; };

let token = 0;
async function route() {
  const my = ++token;
  const [, view = "fleet", arg] = location.hash.replace(/^#\/?/, "#/").split("/");
  const fleet = await get("/api/fleet");

  let target = view;
  if (view === "tool" && !arg) return go(`#/tool/${state.tool ?? fleet.tools[0].tool_ref}`);
  if (view === "cycle" && !arg) {
    if (state.cycle) return go(`#/cycle/${state.cycle}`);
    const t = await get(`/api/tool/${state.tool ?? fleet.tools[0].tool_ref}`);
    return go(`#/cycle/${t.holes.file_id[0]}`);
  }
  if (!["fleet", "tool", "cycle"].includes(view)) return go("#/fleet");

  document.querySelectorAll(".views a").forEach((a) => {
    if (a.dataset.view === target) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });

  app.classList.add("loading");
  try {
    const html = document.createElement("div");
    let after;
    if (view === "fleet") after = await renderFleet(html, fleet);
    else if (view === "tool") { state.tool = arg; after = await renderTool(html, fleet, arg); }
    else { after = await renderCycle(html, fleet, +arg); }
    if (my !== token) return;
    purge(app);
    app.replaceChildren(...html.childNodes);
    after?.(app);
    setState({}, false);
  } catch (e) {
    console.error(e);
    app.innerHTML = `<div class="empty-state">Could not load this view (${esc(e.message)}). <a href="#/fleet">Back to fleet</a></div>`;
  } finally {
    if (my === token) app.classList.remove("loading");
  }
}

// Theme toggle: explicit choice wins over the OS setting, charts re-render with new tokens
document.getElementById("theme-btn").addEventListener("click", () => {
  const dark = getComputedStyle(document.documentElement).colorScheme.includes("dark");
  const next = dark ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("setitec.theme", next); } catch {}
  route();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => route());

window.addEventListener("hashchange", () => { window.scrollTo(0, 0); route(); });
get("/api/fleet").then((f) => {
  document.getElementById("dataset").textContent =
    `${f.tools.length} tools · ${f.totals.n} cycles · ${day(f.totals.start)} – ${day(f.totals.end)} ${new Date(f.totals.end).getFullYear()}`;
});
route();
