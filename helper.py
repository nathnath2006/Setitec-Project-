"""Shared loading and feature helpers for the Setitec drilling analysis notebooks.

Inputs are the outputs of data_ingestion.ipynb:
  - Data/Output Data/metadata.db 
  - Data/Output Data/data/
"""
from __future__ import annotations

import sqlite3
from collections.abc import Callable, Iterable, Sequence
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np
import pandas as pd
from numpy.typing import ArrayLike

if TYPE_CHECKING:
    import ipywidgets

ROOT = Path(__file__).resolve().parent
OUTPUT_PATH = ROOT / "Data/Output Data"
DB_PATH = OUTPUT_PATH / "metadata.db"
PARQUET_PATH = OUTPUT_PATH / "data"

STEP_LABELS = {} # TODO: What does step mean?
FAST_RPM = 1000 # Program steps above this RPM are "fast", else "slow"
MIN_SAMPLES = 50 # Minimum samples, below there may be a pb -> seen as empty

# Short name -> Parquet column
SIGNALS = {
    "Couple (I Torque)": "I Torque (A)",
    "Poussée (I Thrust)": "I Thrust (A)",
    "Puissance broche": "Torque Power (W)",
    "Gap (débourrage)": "Gap Length (mm)",
}
SERIES_COLS = [
    "file_id", "Position (mm)", "I Torque (A)", "I Thrust (A)", "I Torque Empty (A)", "I Thrust Empty (A)",
    "Step (nb)", "Stop code", "Mem Torque min (A)", "Torque Power (W)", "Gap Length (mm)",
]

# KPI column -> readable label
KPIS = {
    "torque_mean": "Couple moyen (A)",
    "torque_p95": "Couple P95 (A)",
    "thrust_mean": "Poussée moyenne (A)",
    "thrust_p95": "Poussée P95 (A)",
    "power_mean": "Puissance moyenne (W)",
    "energy_J": "Énergie (J)",
    "energy_J_per_mm": "Énergie spécifique (J/mm)",
    "duration_s": "Durée (s)",
    "feed_eff_mm_s": "Avance effective (mm/s)",
    "stroke_mm": "Course (mm)",
    "torque_empty": "Courant à vide M1 (A)",
    "gap_max": "Gap max (mm)",
}


# ---- Chart styling ----
FAB_COLORS = {"GUHRING": "#2a78d6", "KLENK": "#eb6834", "MAPAL": "#1baf7a"}
DIAM_SYMBOLS = {9.5: "circle", 11.1: "square", 12.7: "diamond", 14.3: "triangle-up"}
DIAM_DASH = {9.5: "dot", 11.1: "dash", 12.7: "dashdot", 14.3: "solid"}

# Sequential blue ramp (light = first holes, dark = last holes)
SEQ_BLUES = ["#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b"]
DIVERGING = [[0, "#2a78d6"], [0.5, "#f0efec"], [1, "#e34948"]]
KO_COLOR = "#d03b3b"
MUTED = "#898781"
INK, INK_2, GRID, AXIS, SURFACE = "#0b0b0b", "#52514e", "#e1e0d9", "#c3c2b7", "#fcfcfb"


def setup_plotly() -> None:
    """Initialize the plotly template"""
    import plotly.graph_objects as go
    import plotly.io as pio

    axis = dict(gridcolor=GRID, linecolor=AXIS, zerolinecolor=AXIS, tickcolor=AXIS,
                title_font=dict(color=INK_2), tickfont=dict(color=INK_2), showline=True)
    pio.templates["setitec"] = go.layout.Template(layout=dict(
        font=dict(family="system-ui, -apple-system, Segoe UI, sans-serif", size=12, color=INK),
        paper_bgcolor=SURFACE, plot_bgcolor=SURFACE,
        xaxis=axis, yaxis=axis,
        colorway=list(FAB_COLORS.values()),
        hoverlabel=dict(bgcolor="white", font_color=INK),
        legend=dict(bgcolor="rgba(0,0,0,0)"),
        margin=dict(l=60, r=20, t=60, b=50),
        title=dict(font=dict(size=15)),
    ))
    pio.templates.default = "simple_white+setitec"


def tool_style(tools: pd.DataFrame) -> dict[str, dict[str, str]]:
    """tool_ref -> dict(color, symbol, dash),  match a tool with the style of its manufacturer and diameter."""
    return {
        ref: dict(color=FAB_COLORS.get(fab, MUTED),
                  symbol=DIAM_SYMBOLS.get(diam, "circle"),
                  dash=DIAM_DASH.get(diam, "solid"))
        for ref, fab, diam in zip(tools["tool_ref"].astype(str), tools["fabricant"].astype(str),
                                  tools["diametre"].astype(float))
    }


def seq_color(frac: float) -> str:
    """Colour of the sequential ramp at frac in [0, 1]."""
    return SEQ_BLUES[int(round(np.clip(frac, 0, 1) * (len(SEQ_BLUES) - 1)))]


QueryFn = Callable[[str], pd.DataFrame]


def _query(sql: str) -> pd.DataFrame:
    """query function (local SQLite file). Loaders accept another `query` to read from a DB server."""
    with sqlite3.connect(DB_PATH) as con:
        return pd.read_sql(sql, con)


def load_tools(query: QueryFn | None = None) -> pd.DataFrame:
    """One row per tool, with manufacturer and diameter parsed from the folder name."""
    tools = (query or _query)("SELECT * FROM tools")
    parsed = tools["tool_name"].str.extract(r"^(?P<fabricant>\S+).*?Ø\s*(?P<diametre>[\d.,]+)")
    tools["fabricant"] = parsed["fabricant"].str.upper()
    tools["diametre"] = parsed["diametre"].str.replace(",", ".").astype(float)
    tools["label"] = tools["tool_ref"] + " · " + tools["fabricant"] + " Ø" + tools["diametre"].astype(str)
    return tools.sort_values(["fabricant", "diametre"]).reset_index(drop=True)


def load_holes(query: QueryFn | None = None) -> pd.DataFrame:
    """One row per drilling cycle (one file == one hole), ordered by date within each tool.

    hole_idx is the chronological rank of the hole for its tool (1 = first hole drilled).
    """
    query = query or _query
    holes = query("""
        SELECT g.file_id, g.tool_ref, g.source_file, g."Date" AS date, g."Sample Rate (Hz)" AS sample_rate,
               r."Cycle Time (s)" AS cycle_time_s, r."Distance (mm)" AS distance_mm, r."Cycle OK" AS cycle_ok,
               h."Head Name" AS head_name, h."Head Global Counter" AS head_global_counter,
               h."Head Local Counter 1" AS head_local_counter,
               m."Motor Operation Time" AS motor_operation_time
        FROM general_infos g
        LEFT JOIN results r USING (file_id)
        LEFT JOIN head h USING (file_id)
        LEFT JOIN motor_box m USING (file_id)
    """)
    holes["date"] = pd.to_datetime(holes["date"])
    holes["cycle_ok"] = holes["cycle_ok"].astype(bool)
    holes = holes.merge(load_tools(query)[["tool_ref", "fabricant", "diametre", "label"]], on="tool_ref")
    holes = holes.sort_values(["tool_ref", "date", "file_id"]).reset_index(drop=True)
    holes["hole_idx"] = holes.groupby("tool_ref").cumcount() + 1
    holes["n_holes_tool"] = holes.groupby("tool_ref")["file_id"].transform("size")
    # 0 = first hole of the tool, 1 = last one, normalization purposes.
    holes["life_frac"] = (holes["hole_idx"] - 1) / (holes["n_holes_tool"] - 1).clip(lower=1)
    return holes


def step_label(step: int | float) -> str:
    step = int(step)
    return STEP_LABELS.get(step, f"Step {step}")


def load_program(query: QueryFn | None = None) -> pd.DataFrame:
    """Active program steps, one row per (file_id, step), with the speed regime of each step."""
    prog = (query or _query)('SELECT * FROM program WHERE "Step On/Off" = 1')
    prog["step"] = prog["Step Nb"].astype(int)
    prog["regime"] = np.where(prog["RPM"] >= FAST_RPM, "rapide", "lent")
    prog.loc[prog["step"] == 0, "regime"] = "approche"  # step 0: torque ~0 on every tool, drill in the air
    return prog


def load_step_results(query: QueryFn | None = None) -> pd.DataFrame:
    sr = (query or _query)("SELECT * FROM step_results")
    sr["step"] = sr["Step Number"].astype(int)
    return sr


def load_series(tool_refs: Iterable[str] | None = None) -> pd.DataFrame:
    """Raw time series (Parquet data)

    Adds depth_mm (= -Position, positive into the part), t_s (time since the cycle start) and sample.
    """
    filters = [("tool_ref", "in", list(tool_refs))] if tool_refs is not None else None
    s = pd.read_parquet(PARQUET_PATH, columns=SERIES_COLS + ["tool_ref"], filters=filters)
    rates = _query('SELECT file_id, "Sample Rate (Hz)" AS r FROM general_infos').set_index("file_id")["r"]
    return prepare_series(s, rates)


def prepare_series(s: pd.DataFrame, rates: pd.Series) -> pd.DataFrame:
    """Typing + derived columns of raw series, whatever their source (Parquet or a DB table).

    If a `sample` column is present (DB tables have no implicit order) rows are ordered by it.
    """
    if "sample" in s.columns:
        s = s.sort_values(["file_id", "sample"], kind="stable").reset_index(drop=True)
    s["tool_ref"] = s["tool_ref"].astype(str)
    signal_cols = [c for c in SERIES_COLS if c not in ("file_id", "Step (nb)", "Stop code")]
    s[signal_cols] = s[signal_cols].astype("float32")
    s["step"] = s["Step (nb)"].astype(int)
    s["depth_mm"] = -s["Position (mm)"]
    s["sample"] = s.groupby("file_id").cumcount()
    #time since the beginning in seconds
    s["t_s"] = s["sample"] / s["file_id"].map(rates)
    return s


def depth_profiles(series: pd.DataFrame, bin_mm: float = 0.1,
                   signals: Iterable[str] | None = None) -> pd.DataFrame:
    """Resample every cycle onto a common depth grid (mean of each signal per depth bin).

    Only samples where the drill reaches a new maximum depth are kept, so that peck retracts
    and re-entries do not pull the averages towards zero.
    """
    signals = list(signals or SIGNALS.values())
    s = series[["file_id", "depth_mm", "step"] + signals]
    advancing = s["depth_mm"] >= s.groupby("file_id")["depth_mm"].cummax() - 1e-9
    s = s[advancing].copy()
    s["depth_bin"] = (np.floor(s["depth_mm"] / bin_mm) * bin_mm).round(6)
    agg = {c: "mean" for c in signals} | {"step": "max"}
    return s.groupby(["file_id", "depth_bin"], as_index=False).agg(agg)


def hole_step_features(series: pd.DataFrame, holes: pd.DataFrame,
                       program: pd.DataFrame | None = None) -> pd.DataFrame:
    """KPIs per (file_id, step), computed from the time series"""
    s = series
    rate = s["file_id"].map(holes.set_index("file_id")["sample_rate"])
    s = s.assign(energy=s["Torque Power (W)"] / rate)  # W * s per sample -> J
    g = s.groupby(["file_id", "step"])
    feat = g.agg(
        n=("depth_mm", "size"),
        depth_start=("depth_mm", "min"),
        depth_end=("depth_mm", "max"),
        torque_mean=("I Torque (A)", "mean"),
        torque_p95=("I Torque (A)", lambda x: x.quantile(0.95)),
        thrust_mean=("I Thrust (A)", "mean"),
        thrust_p95=("I Thrust (A)", lambda x: x.quantile(0.95)),
        power_mean=("Torque Power (W)", "mean"),
        energy_J=("energy", "sum"),
        torque_empty=("I Torque Empty (A)", "mean"),
        thrust_empty=("I Thrust Empty (A)", "mean"),
        gap_max=("Gap Length (mm)", "max"),
    ).reset_index()
    feat["duration_s"] = feat["n"] / feat["file_id"].map(holes.set_index("file_id")["sample_rate"])
    feat["stroke_mm"] = feat["depth_end"] - feat["depth_start"]
    feat["energy_J_per_mm"] = feat["energy_J"] / feat["stroke_mm"].where(feat["stroke_mm"] > 0.05)
    feat["feed_eff_mm_s"] = feat["stroke_mm"] / feat["duration_s"]
    feat["step_label"] = feat["step"].map(step_label)

    program = load_program() if program is None else program
    setpoints = program[["file_id", "step", "RPM", "Feed (mm/tr)", "Feed (mm/s)", "regime"]]
    feat = feat.merge(setpoints, on=["file_id", "step"], how="left")
    cols = ["file_id", "tool_ref", "label", "fabricant", "diametre", "hole_idx", "life_frac", "date", "cycle_ok"]
    return holes[cols].merge(feat, on="file_id")


def hole_features(series: pd.DataFrame, holes: pd.DataFrame) -> pd.DataFrame:
    """KPIs per cycle over all steps (whole hole)."""
    rate = series["file_id"].map(holes.set_index("file_id")["sample_rate"])
    s = series.assign(energy=series["Torque Power (W)"] / rate)
    feat = s.groupby("file_id").agg(
        n_samples=("depth_mm", "size"),
        depth_max=("depth_mm", "max"),
        torque_mean=("I Torque (A)", "mean"),
        torque_p95=("I Torque (A)", lambda x: x.quantile(0.95)),
        thrust_mean=("I Thrust (A)", "mean"),
        thrust_p95=("I Thrust (A)", lambda x: x.quantile(0.95)),
        power_mean=("Torque Power (W)", "mean"),
        energy_J=("energy", "sum"),
        torque_empty=("I Torque Empty (A)", "mean"),
        gap_max=("Gap Length (mm)", "max"),
        stop_code_last=("Stop code", lambda x: x[x != 0].iloc[-1] if (x != 0).any() else 0),
    ).reset_index()
    feat["energy_J_per_mm"] = feat["energy_J"] / feat["depth_max"].where(feat["depth_max"] > 0.05)
    return holes.merge(feat, on="file_id", how="left")


def valid_files(holes: pd.DataFrame, series: pd.DataFrame) -> set[int]:
    """file_ids that hold a usable curve (enough samples)."""
    counts = series.groupby("file_id").size()
    return set(counts[counts >= MIN_SAMPLES].index) & set(holes["file_id"])


def trend(x: ArrayLike, y: ArrayLike) -> tuple[float, float]:
    """
    Least-squares slope and relative change between the first and last 10 % of the points.
    Slope -> Change from one hole to another, can be the wear.
    Rel -> in %, enables comparaison between two tools (limit as over each own drill life).
    """
    x, y = np.asarray(x, float), np.asarray(y, float)
    ok = np.isfinite(x) & np.isfinite(y)
    x, y = x[ok], y[ok]
    if len(x) < 3:
        return np.nan, np.nan
    slope = np.polyfit(x, y, 1)[0]
    k = max(1, len(y) // 10)
    order = np.argsort(x)
    first, last = y[order[:k]].mean(), y[order[-k:]].mean()
    rel = (last - first) / abs(first) if first else np.nan
    return slope, rel


def regime_features(step_feat: pd.DataFrame) -> pd.DataFrame:
    """
    Collapse the per-step KPIs onto (file_id, regime): a hole can hold several steps of the same regime.
    Bascially because we can't understand what step is, I assume that is has to play with the RPM speed of the drill.
    Means are weighted by sample count, P95 / max take the max, energy / duration / stroke are summed.
    """
    f = step_feat.assign(_w=step_feat["n"])
    for c in ["torque_mean", "thrust_mean", "power_mean", "torque_empty"]:
        f[c] = f[c] * f["_w"]
    keys = ["file_id", "tool_ref", "label", "fabricant", "diametre", "hole_idx", "life_frac", "date", "cycle_ok", "regime"]
    out = f.groupby(keys, as_index=False).agg(
        n=("_w", "sum"), torque_mean=("torque_mean", "sum"), thrust_mean=("thrust_mean", "sum"),
        power_mean=("power_mean", "sum"), torque_empty=("torque_empty", "sum"),
        torque_p95=("torque_p95", "max"), thrust_p95=("thrust_p95", "max"), gap_max=("gap_max", "max"),
        energy_J=("energy_J", "sum"), duration_s=("duration_s", "sum"), stroke_mm=("stroke_mm", "sum"),
        RPM=("RPM", "mean"), feed_prog_mm_s=("Feed (mm/s)", "mean"),
    )
    for c in ["torque_mean", "thrust_mean", "power_mean", "torque_empty"]:
        out[c] = out[c] / out["n"]
    out["energy_J_per_mm"] = out["energy_J"] / out["stroke_mm"].where(out["stroke_mm"] > 0.05)
    out["feed_eff_mm_s"] = out["stroke_mm"] / out["duration_s"]
    return out


def live(render: Callable[[], None], controls: Sequence[ipywidgets.ValueWidget] = (),
         watch: Sequence[ipywidgets.ValueWidget] = ()) -> Callable[..., None]:
    """Display control + refresh with render wen needed."""
    import ipywidgets as w
    from IPython.display import display

    out = w.Output()

    def refresh(*_: object) -> None:
        with out:
            out.clear_output(wait=True)
            render()

    for c in [*controls, *watch]:
        c.observe(refresh, names="value")
    row = w.HBox(list(controls), layout=w.Layout(flex_flow="row wrap", gap="4px 16px"))
    display(w.VBox([row, out]) if controls else out)
    refresh()
    return refresh


def tiles(items: Iterable[tuple[str, object]]) -> str:
    """Small HTML stat tiles: [(label, value), ...]."""
    cells = "".join(
        f'<div style="padding:8px 14px;border:1px solid {GRID};border-radius:6px;min-width:120px">'
        f'<div style="color:{INK_2};font-size:12px">{k}</div>'
        f'<div style="font-size:20px;font-weight:600;color:{INK}">{v}</div></div>'
        for k, v in items
    )
    return f'<div style="display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 10px">{cells}</div>'
