"""Setitec tool-performance workbench: data API + static file server.

Run from the project root (with the venv active):
    python webapp/server.py            # http://127.0.0.1:8050
    python webapp/server.py --port 9000

All features come from helper.py (same definitions as per_tool_analysis.ipynb), computed once at
start-up (~5 s). Raw 100 Hz series for the cycle view are read from Parquet on demand, per tool.
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import mimetypes
import sys
import time
from functools import lru_cache
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
import helper as st  # noqa: E402
from analysis import DEFAULT_FEATURES, FEATURES, group_analysis  # noqa: E402
from connection import test_demo, test_remote  # noqa: E402
from ingestion import scan_folder  # noqa: E402

STATIC = HERE / "static"
PLOTLY_JS = Path(__import__("plotly").__file__).parent / "package_data" / "plotly.min.js"

# ---- Vocabulary (the helper keeps the French labels used by the notebooks) ----
REGIME_EN = {"approche": "approach", "lent": "slow", "rapide": "fast"}
SIGNALS = {  # key -> (parquet column, label, unit)
    "torque": ("I Torque (A)", "Torque current", "A"),
    "thrust": ("I Thrust (A)", "Thrust current", "A"),
    "power": ("Torque Power (W)", "Spindle power", "W"),
    "gap": ("Gap Length (mm)", "Peck gap", "mm"),
}
NORMAL_END_CODE = 2048  # every OK cycle finishes its last step on this code

# ---------------------------------------------------------------------------------------------
# Data preparation
# ---------------------------------------------------------------------------------------------
def rel_change(x, y) -> float:
    return st.trend(x, y)[1]


def build() -> dict:
    t0 = time.time()
    tools = st.load_tools()
    holes = st.load_holes()
    program = st.load_program()
    program["regime"] = program["regime"].map(REGIME_EN)
    step_res = st.load_step_results()

    series = st.load_series()
    valid = st.valid_files(holes, series)
    series = series[series["file_id"].isin(valid)]
    hole_feat = st.hole_features(series, holes)
    step_feat = st.hole_step_features(series, holes, program)
    profiles = st.depth_profiles(series)
    del series

    # Stop-code signature of each cycle: codes of its steps in order, e.g. "4-2048-1-1024"
    sr = step_res.sort_values(["file_id", "step"])
    sig = sr.groupby("file_id").agg(
        signature=("Stop Code", lambda c: "-".join(str(int(v)) for v in c)),
        last_step=("step", "max"),
        final_code=("Stop Code", "last"),
    )
    last_prog_step = program.groupby("file_id")["step"].max().rename("last_prog_step")
    hole_feat = hole_feat.join(sig, on="file_id").join(last_prog_step, on="file_id")
    hole_feat["valid"] = hole_feat["file_id"].isin(valid)

    def outcome(r) -> str:
        if r.cycle_ok:
            return "ok"
        if pd.notna(r.last_step) and r.last_step >= r.last_prog_step:
            return "ko_end"  # ran every programmed step, last one ended on an abnormal code
        return "ko_stop"  # stopped before the last programmed step

    hole_feat["outcome"] = [outcome(r) for r in hole_feat.itertuples()]

    print(f"  features ready in {time.time() - t0:.1f} s", flush=True)
    return dict(tools=tools, holes=hole_feat, program=program, step_res=step_res,
                step_feat=step_feat, profiles=profiles)


# ---------------------------------------------------------------------------------------------
# JSON helpers
# ---------------------------------------------------------------------------------------------
def num(v, nd: int = 4):
    if v is None:
        return None
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (bool, np.bool_)):
        return bool(v)
    try:
        f = float(v)
    except (TypeError, ValueError):
        return v
    if not math.isfinite(f):
        return None
    return round(f, nd)


def arr(values, nd: int = 4) -> list:
    a = np.asarray(values, dtype=float)
    a = np.round(a, nd)
    return [None if not math.isfinite(x) else x for x in a.tolist()]


def columns(df: pd.DataFrame, spec: dict[str, int | str]) -> dict[str, list]:
    """Column-oriented export. spec: column -> decimals (int) or 'raw' / 'date' / 'bool'."""
    out = {}
    for col, kind in spec.items():
        s = df[col]
        if kind == "date":
            out[col] = s.dt.strftime("%Y-%m-%dT%H:%M:%S").tolist()
        elif kind == "bool":
            out[col] = s.astype(bool).tolist()
        elif kind == "int":
            out[col] = [None if pd.isna(v) else int(v) for v in s]
        elif kind == "raw":
            out[col] = [None if (isinstance(v, float) and not math.isfinite(v)) else v for v in s.tolist()]
        else:
            out[col] = arr(s, kind)
    return out


# ---------------------------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------------------------
class Api:
    def __init__(self, data: dict):
        self.d = data

    # -- per-tool summary shared by the fleet view and the tool header --
    def summary(self, ref: str) -> dict:
        t = self.d["tools"].set_index("tool_ref").loc[ref]
        h = self.d["holes"][self.d["holes"]["tool_ref"] == ref]
        ok = h[h["cycle_ok"]]
        basis = ok if len(ok) >= 5 else h[h["valid"]]  # drift reference set
        ok_rate = float(h["cycle_ok"].mean())
        outcomes = h["outcome"].value_counts()
        ko_sigs = h.loc[~h["cycle_ok"], "signature"].fillna("none").value_counts()
        b = basis.sort_values("hole_idx")
        return dict(
            tool_ref=ref, maker=t["fabricant"], diameter=float(t["diametre"]), label=t["label"],
            head=", ".join(sorted(h["head_name"].dropna().unique())),
            n=int(len(h)), n_ok=int(len(ok)), n_ko=int(len(h) - len(ok)), ok_rate=num(ok_rate),
            outcomes={k: int(outcomes.get(k, 0)) for k in ("ok", "ko_end", "ko_stop")},
            ko_signatures={k: int(v) for k, v in ko_sigs.items()},
            start=h["date"].min().strftime("%Y-%m-%dT%H:%M:%S"),
            end=h["date"].max().strftime("%Y-%m-%dT%H:%M:%S"),
            span_h=num((h["date"].max() - h["date"].min()).total_seconds() / 3600, 2),
            cycle_time_med=num(basis["cycle_time_s"].median(), 1),
            depth_med=num(basis["distance_mm"].median(), 2),
            energy_mm_med=num(basis["energy_J_per_mm"].median(), 1),
            torque_p95_med=num(basis["torque_p95"].median(), 2),
            drift_basis="ok" if basis is ok else "all",
            drift_energy=num(rel_change(basis["hole_idx"], basis["energy_J_per_mm"])),
            drift_torque=num(rel_change(basis["hole_idx"], basis["torque_p95"])),
            spark=dict(hole_idx=b["hole_idx"].tolist(), energy=arr(b["energy_J_per_mm"], 1)),
        )

    def fleet(self) -> dict:
        h = self.d["holes"]
        return dict(
            tools=[self.summary(r) for r in self.d["tools"]["tool_ref"]],
            totals=dict(n=int(len(h)), n_ok=int(h["cycle_ok"].sum()),
                        start=h["date"].min().strftime("%Y-%m-%dT%H:%M:%S"),
                        end=h["date"].max().strftime("%Y-%m-%dT%H:%M:%S")),
            normal_end_code=NORMAL_END_CODE,
            signals={k: dict(label=v[1], unit=v[2]) for k, v in SIGNALS.items()},
        )

    def tool(self, ref: str) -> dict:
        d = self.d
        if ref not in set(d["tools"]["tool_ref"]):
            raise KeyError(ref)
        h = d["holes"][d["holes"]["tool_ref"] == ref].sort_values("hole_idx")
        prog = d["program"][d["program"]["tool_ref"] == ref]
        sf = d["step_feat"][d["step_feat"]["tool_ref"] == ref]

        # Program: one row per step, distinct set-points encountered
        def distinct(s):
            vals = sorted(s.dropna().unique())
            return [num(v) if not isinstance(v, str) else v for v in vals]

        spans = sf.groupby("step")[["depth_start", "depth_end"]].median()
        steps = []
        for step, g in prog.groupby("step"):
            steps.append(dict(
                step=int(step), n=int(len(g)), regime=g["regime"].mode()[0],
                rpm=distinct(g["RPM"]), feed_rev=distinct(g["Feed (mm/tr)"]), feed_s=distinct(g["Feed (mm/s)"]),
                stroke=distinct(g["Stroke (mm)"]), torque_max=distinct(g["Torque Max (A)"]),
                thrust_max=distinct(g["Thrust Max (A)"]), gap=distinct(g["Gap (mm)"]),
                peck=distinct(g["Peck (nb)"]),
                depth_start=num(spans["depth_start"].get(step), 2), depth_end=num(spans["depth_end"].get(step), 2),
            ))

        # Depth profiles: one matrix per signal, rows = valid holes by hole_idx, cols = depth bins
        p = d["profiles"][d["profiles"]["file_id"].isin(h["file_id"])]
        p = p.merge(h[["file_id", "hole_idx"]], on="file_id")
        # depth_bin is float32: key the 0.1 mm bins by an integer index so they align exactly
        p = p.assign(bin=np.rint(p["depth_bin"].astype("float64") * 10).astype(int))
        bins = np.arange(p["bin"].min(), p["bin"].max() + 1)
        grid = np.round(bins / 10, 1)
        rows = sorted(p["hole_idx"].unique())
        matrices = {}
        for key, (col, *_rest) in SIGNALS.items():
            pv = p.pivot_table(index="hole_idx", columns="bin", values=col).reindex(index=rows, columns=bins)
            nd = 1 if key == "power" else 3
            matrices[key] = [arr(r, nd) for r in pv.to_numpy()]

        sr = d["step_res"][d["step_res"]["tool_ref"] == ref]
        codes = pd.crosstab(sr["step"], sr["Stop Code"].astype(int))

        kpi_cols = ["torque_mean", "torque_p95", "thrust_mean", "thrust_p95", "power_mean", "energy_J",
                    "energy_J_per_mm", "duration_s", "feed_eff_mm_s", "stroke_mm", "torque_empty", "gap_max"]
        return dict(
            summary=self.summary(ref),
            holes=columns(h, dict(file_id="int", hole_idx="int", date="date", cycle_ok="bool", valid="bool",
                                  outcome="raw", signature="raw", final_code="int", source_file="raw",
                                  cycle_time_s=2, distance_mm=2, energy_J=0, energy_J_per_mm=1,
                                  torque_mean=3, torque_p95=3, thrust_mean=3, thrust_p95=3, gap_max=2)),
            program=steps,
            step_feat=columns(sf.sort_values(["step", "hole_idx"]),
                              {"file_id": "int", "hole_idx": "int", "step": "int", "cycle_ok": "bool",
                               "regime": "raw", "RPM": 0, **{c: 4 for c in kpi_cols}}),
            profiles=dict(depth=grid.tolist(), hole_idx=[int(r) for r in rows], **matrices),
            stop_codes=dict(steps=[int(s) for s in codes.index], codes=[int(c) for c in codes.columns],
                            counts=codes.to_numpy().tolist()),
        )

    def group(self, query: dict) -> dict:
        known = set(self.d["tools"]["tool_ref"])
        refs = [r for r in query.get("tools", [""])[0].split(",") if r in known]
        if not refs:
            raise ValueError("Choose at least one tool")
        feats = [f for f in query.get("features", [",".join(DEFAULT_FEATURES)])[0].split(",") if f in FEATURES]
        z = min(10.0, max(1.5, float(query.get("z", ["3.5"])[0])))
        kmin = min(6, max(2, int(query.get("kmin", ["2"])[0])))
        kmax = min(8, max(kmin, int(query.get("kmax", ["4"])[0])))
        return group_analysis(self.d["holes"], refs, feats, z, kmin, kmax)

    def cycle(self, file_id: int) -> dict:
        d = self.d
        hrow = d["holes"][d["holes"]["file_id"] == file_id]
        if hrow.empty:
            raise KeyError(file_id)
        hrow = hrow.iloc[0]
        ref = hrow["tool_ref"]
        s = tool_series(ref)
        s = s[s["file_id"] == file_id]
        siblings = d["holes"][d["holes"]["tool_ref"] == ref].sort_values("hole_idx")
        ids = siblings["file_id"].tolist()
        i = ids.index(file_id)

        prog = d["program"][d["program"]["file_id"] == file_id].sort_values("step")
        sr = d["step_res"][d["step_res"]["file_id"] == file_id].sort_values("step")
        stops = s[s["Stop code"] != 0]
        return dict(
            tool_ref=ref, file_id=int(file_id), hole_idx=int(hrow["hole_idx"]), n_holes=int(len(ids)),
            prev=int(ids[i - 1]) if i > 0 else None, next=int(ids[i + 1]) if i < len(ids) - 1 else None,
            date=hrow["date"].strftime("%Y-%m-%dT%H:%M:%S"), cycle_ok=bool(hrow["cycle_ok"]),
            outcome=hrow["outcome"], signature=hrow["signature"], source_file=hrow["source_file"],
            head=hrow["head_name"], valid=bool(hrow["valid"]),
            kpi=dict(cycle_time_s=num(hrow["cycle_time_s"], 2), distance_mm=num(hrow["distance_mm"], 2),
                     depth_max=num(hrow["depth_max"], 2), energy_J=num(hrow["energy_J"], 0),
                     energy_J_per_mm=num(hrow["energy_J_per_mm"], 1), torque_p95=num(hrow["torque_p95"], 2),
                     thrust_p95=num(hrow["thrust_p95"], 2), final_code=num(hrow["final_code"], 0)),
            series=dict(t=arr(s["t_s"], 2), depth=arr(s["depth_mm"], 3), step=s["step"].tolist(),
                        torque=arr(s["I Torque (A)"], 3), thrust=arr(s["I Thrust (A)"], 3),
                        power=arr(s["Torque Power (W)"], 1), gap=arr(s["Gap Length (mm)"], 3)),
            stops=dict(t=arr(stops["t_s"], 2), depth=arr(stops["depth_mm"], 3),
                       code=[int(c) for c in stops["Stop code"]]),
            program=[dict(step=int(r["step"]), regime=r["regime"], rpm=num(r["RPM"]),
                          feed_rev=num(r["Feed (mm/tr)"]), feed_s=num(r["Feed (mm/s)"]), stroke=num(r["Stroke (mm)"]),
                          torque_max=num(r["Torque Max (A)"]), thrust_max=num(r["Thrust Max (A)"]),
                          gap=num(r["Gap (mm)"]), peck=num(r["Peck (nb)"]))
                     for _, r in prog.iterrows()],
            step_results=[dict(step=int(r["step"]), code=int(r["Stop Code"]), duration=num(r["Duration (s)"], 2),
                               dist_m2=num(r["Distance M2"], 2), m1_max=num(r["M1 Max Amp"], 2),
                               m1_noload=num(r["M1 No Load Amp"], 2), m2_max=num(r["M2 Max Amp"], 2),
                               gap_max=num(r["Gap Max (mm)"], 2))
                          for _, r in sr.iterrows()],
        )


@lru_cache(maxsize=3)
def tool_series(ref: str) -> pd.DataFrame:
    return st.load_series([ref])


# ---------------------------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------------------------
class Handler(SimpleHTTPRequestHandler):
    api: Api
    cache: dict[str, bytes] = {}

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(STATIC), **kw)

    def end_headers(self):
        # Static app files (html/js/css) must never be served from the browser cache: Safari in
        # particular keeps ES modules and ignores Cmd+Shift+R, so an update would not show up.
        path = urlparse(self.path).path
        if not path.startswith(("/api/", "/vendor/")):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # quieter console
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write("  " + (fmt % args) + "\n")

    def send_bytes(self, body: bytes, ctype: str, cacheable: bool = False):
        gz = "gzip" in self.headers.get("Accept-Encoding", "") and len(body) > 1024
        if gz:
            body = gzip.compress(body, 5)
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        if gz:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Cache-Control", "max-age=86400" if cacheable else "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/vendor/plotly.min.js":
            return self.send_bytes(PLOTLY_JS.read_bytes(), "text/javascript", cacheable=True)
        if path == "/api/group":
            return self.handle_group()
        if path.startswith("/api/"):
            return self.handle_api(path)
        return super().do_GET()

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ("/api/ingest/scan", "/api/connection/test"):
            return self.send_error(HTTPStatus.NOT_FOUND, "Unknown resource")
        if self.client_address[0] not in {"127.0.0.1", "::1"}:
            return self.send_error(HTTPStatus.FORBIDDEN, "Only available from this computer")
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length > 16_384:
                raise ValueError("Request is too large")
            body = json.loads(self.rfile.read(length) or b"{}")
            if path == "/api/ingest/scan":
                folder = str(body.get("folder", "")).strip()
                if not folder:
                    raise ValueError("Enter a folder path to scan")
                payload = scan_folder(folder)
            elif body.get("mode") == "demo":
                payload = test_demo(self.api.d, st._query)
            else:
                payload = test_remote(str(body.get("host", "")), int(body.get("port", 0)),
                                      "https" if body.get("protocol") == "https" else "http")
            self.send_json(payload)
        except (OSError, ValueError, TypeError, json.JSONDecodeError) as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def send_json(self, payload, status=HTTPStatus.OK):
        if status != HTTPStatus.OK:
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_bytes(json.dumps(payload, separators=(",", ":"), allow_nan=False).encode(), "application/json")

    def handle_group(self):
        key = self.path
        try:
            if key not in self.cache:
                payload = self.api.group(parse_qs(urlparse(self.path).query))
                self.cache[key] = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode()
            self.send_bytes(self.cache[key], "application/json")
        except (KeyError, ValueError) as e:
            self.send_json({"error": str(e)}, HTTPStatus.BAD_REQUEST)

    def handle_api(self, path: str):
        parts = path.strip("/").split("/")[1:]
        try:
            if path not in self.cache:
                if parts == ["fleet"]:
                    payload = self.api.fleet()
                elif len(parts) == 2 and parts[0] == "tool":
                    payload = self.api.tool(parts[1])
                elif len(parts) == 2 and parts[0] == "cycle":
                    payload = self.api.cycle(int(parts[1]))
                else:
                    raise KeyError(path)
                self.cache[path] = json.dumps(payload, separators=(",", ":"), allow_nan=False).encode()
            self.send_bytes(self.cache[path], "application/json")
        except (KeyError, ValueError) as e:
            self.send_error(HTTPStatus.NOT_FOUND, f"Unknown resource: {e}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8050)
    ap.add_argument("--no-browser", action="store_true", help="do not open the dashboard in the browser")
    args = ap.parse_args()

    # Bind first (fast) so a busy port is reported before the 5-10 s data preparation
    server = None
    for port in range(args.port, args.port + 10):
        try:
            server = ThreadingHTTPServer((args.host, port), Handler)
            break
        except OSError:
            print(f"  port {port} is already in use (another copy of the dashboard is probably running), trying {port + 1}…")
    if server is None:
        sys.exit(f"No free port between {args.port} and {args.port + 9}. Close the other dashboard window/terminal, or pass --port.")
    url = f"http://{args.host}:{server.server_address[1]}"

    mimetypes.add_type("text/javascript", ".js")
    print("Setitec dashboard — preparing data…", flush=True)
    Handler.api = Api(build())
    print(f"  ready: {url}   (Ctrl+C to stop)", flush=True)
    if not args.no_browser:
        import webbrowser
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
