"""Data layer of the dashboard: where the data comes from, how it is aggregated, where it is cached.

    source (local files or SQL server)  ──►  build()  ──►  cache (.cache/<fingerprint>/*.parquet)  ──►  API

* A *source* answers SQL queries on the metadata tables and returns raw 100 Hz series for one tool or
  one cycle. Two implementations: LocalSource (SQLite + Parquet written by data_ingestion.ipynb) and
  SqlSource (any SQLAlchemy URL, e.g. PostgreSQL, with the same tables + a `series` table, see
  export_to_server.py).
* build() computes the aggregated features tool by tool (raw series never all in memory) and writes
  them to the cache. Only aggregates are cached; raw series stay in the source and are read on demand
  for the cycle view.
* The cache key (fingerprint) changes when the source changes, so a stale cache is never served.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import helper as st  # noqa: E402

CACHE_DIR = HERE / ".cache"
SETTINGS_FILE = HERE / "settings.json"
KEEP_CACHES = 3
REGIME_EN = {"approche": "approach", "lent": "slow", "rapide": "fast"}
RAW_COLS = st.SERIES_COLS + ["tool_ref"]
REQUIRED_TABLES = ["tools", "general_infos", "results", "head", "motor_box", "program", "step_results"]

DEFAULT_SETTINGS = {
    # null = keep the built-in, validated light/dark pair for that role
    "colors": {"GUHRING": None, "KLENK": None, "MAPAL": None, "data": None, "ko": None},
    "source": {"kind": "local", "url": ""},
}


# ---------------------------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------------------------
def load_settings() -> dict:
    s = json.loads(json.dumps(DEFAULT_SETTINGS))
    if SETTINGS_FILE.exists():
        saved = json.loads(SETTINGS_FILE.read_text())
        s["colors"].update(saved.get("colors", {}))
        s["source"].update(saved.get("source", {}))
    return s


def save_settings(s: dict) -> None:
    SETTINGS_FILE.write_text(json.dumps(s, indent=2))


def mask_url(url: str) -> str:
    if not url:
        return ""
    try:
        from sqlalchemy.engine import make_url
        return make_url(url).render_as_string(hide_password=True)
    except Exception:
        return url


# ---------------------------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------------------------
class LocalSource:
    """SQLite metadata + Parquet series, as written by data_ingestion.ipynb."""
    kind = "local"

    def describe(self) -> str:
        return f"Local files: {st.DB_PATH.relative_to(st.ROOT)} + {st.PARQUET_PATH.relative_to(st.ROOT)}/"

    def check(self) -> dict:
        missing = [p for p in (st.DB_PATH, st.PARQUET_PATH) if not p.exists()]
        if missing:
            raise FileNotFoundError("Missing: " + ", ".join(str(p) for p in missing))
        n = int(self.query("SELECT COUNT(*) AS n FROM general_infos")["n"].iloc[0])
        return {"cycles": n, "series": "Parquet, partitioned by tool"}

    def query(self, sql: str) -> pd.DataFrame:
        return st._query(sql)

    def fingerprint(self) -> str:
        h = hashlib.sha1(b"local")
        for p in [st.DB_PATH, *sorted(st.PARQUET_PATH.rglob("*.parquet"))]:
            stt = p.stat()
            h.update(f"{p.name}:{stt.st_size}:{stt.st_mtime_ns}".encode())
        return h.hexdigest()[:12]

    def series_for_tool(self, ref: str) -> pd.DataFrame:
        return pd.read_parquet(st.PARQUET_PATH, columns=RAW_COLS, filters=[("tool_ref", "==", ref)])

    def series_for_file(self, ref: str, file_id: int) -> pd.DataFrame:
        return pd.read_parquet(st.PARQUET_PATH, columns=RAW_COLS,
                               filters=[("tool_ref", "==", ref), ("file_id", "==", int(file_id))])


class SqlSource:
    """Any SQL server reachable with SQLAlchemy, holding the metadata tables + a `series` table.

    Tested with SQLite URLs; PostgreSQL (postgresql+psycopg://…) and SQL Server use the same code
    (identifiers are double-quoted, which those servers accept).
    """
    kind = "sql"

    def __init__(self, url: str):
        from sqlalchemy import create_engine
        if not url:
            raise ValueError("No connection URL given.")
        self.url = url
        self.engine = create_engine(url, pool_pre_ping=True)

    def describe(self) -> str:
        return f"SQL server: {mask_url(self.url)}"

    def check(self) -> dict:
        from sqlalchemy import inspect
        tables = set(inspect(self.engine).get_table_names())
        missing = [t for t in REQUIRED_TABLES + ["series"] if t not in tables]
        if missing:
            raise LookupError(f"Connected, but these tables are missing: {', '.join(missing)}. "
                              "Fill the server with webapp/export_to_server.py first.")
        n = int(self.query("SELECT COUNT(*) AS n FROM general_infos")["n"].iloc[0])
        return {"cycles": n, "series": "table `series`"}

    def query(self, sql: str, params: dict | None = None) -> pd.DataFrame:
        from sqlalchemy import text
        with self.engine.connect() as con:
            return pd.read_sql(text(sql), con, params=params)

    def fingerprint(self) -> str:
        r = self.query('SELECT COUNT(*) AS n, MAX(file_id) AS m, MAX("Date") AS d FROM general_infos').iloc[0]
        key = f"sql|{mask_url(self.url)}|{r['n']}|{r['m']}|{r['d']}"
        return hashlib.sha1(key.encode()).hexdigest()[:12]

    def _series(self, where: str, params: dict) -> pd.DataFrame:
        cols = ", ".join(f'"{c}"' for c in RAW_COLS + ["sample"])
        return self.query(f"SELECT {cols} FROM series WHERE {where}", params)

    def series_for_tool(self, ref: str) -> pd.DataFrame:
        return self._series("tool_ref = :ref", {"ref": ref})

    def series_for_file(self, ref: str, file_id: int) -> pd.DataFrame:
        return self._series("file_id = :fid", {"fid": int(file_id)})


def make_source(cfg: dict):
    import os
    env_url = os.environ.get("SETITEC_DB_URL")
    if env_url:  # lets you keep the password out of settings.json
        return SqlSource(env_url)
    if cfg.get("kind") == "sql":
        return SqlSource(cfg.get("url", ""))
    return LocalSource()


# ---------------------------------------------------------------------------------------------
# Aggregation + cache
# ---------------------------------------------------------------------------------------------
@dataclass
class Dataset:
    tools: pd.DataFrame
    holes: pd.DataFrame       # one row per cycle: metadata + whole-cycle features + outcome
    program: pd.DataFrame     # one row per (cycle, active step)
    step_res: pd.DataFrame    # controller step results
    step_feat: pd.DataFrame   # features per (cycle, step)
    profiles: pd.DataFrame    # signals resampled every 0.1 mm per cycle
    rates: pd.Series          # sample rate per file_id
    meta: dict
    source: object

    def series(self, ref: str, file_id: int) -> pd.DataFrame:
        raw = self.source.series_for_file(ref, file_id)
        return st.prepare_series(raw, self.rates)


TABLES = ["tools", "holes", "program", "step_res", "step_feat", "profiles"]


def _outcome(r) -> str:
    if r.cycle_ok:
        return "ok"
    if pd.notna(r.last_step) and r.last_step >= r.last_prog_step:
        return "ko_end"   # every programmed step ran, the last one ended on an abnormal code
    return "ko_stop"      # stopped before the last programmed step


def compute(source, log=print) -> dict:
    q = source.query
    tools = st.load_tools(q)
    holes = st.load_holes(q)
    program = st.load_program(q)
    program["regime"] = program["regime"].map(REGIME_EN)
    step_res = st.load_step_results(q)
    rates = holes.set_index("file_id")["sample_rate"]

    hole_parts, step_parts, prof_parts, valid = [], [], [], set()
    for i, ref in enumerate(tools["tool_ref"], 1):
        t0 = time.time()
        h = holes[holes["tool_ref"] == ref]
        s = st.prepare_series(source.series_for_tool(ref), rates)
        v = st.valid_files(h, s)
        valid |= v
        s = s[s["file_id"].isin(v)]
        hole_parts.append(st.hole_features(s, h))
        step_parts.append(st.hole_step_features(s, h, program))
        prof_parts.append(st.depth_profiles(s))
        log(f"    {i:>2}/{len(tools)}  {ref}: {len(h)} cycles, {len(s):,} samples  ({time.time() - t0:.1f} s)")
        del s

    hole_feat = pd.concat(hole_parts, ignore_index=True)
    step_feat = pd.concat(step_parts, ignore_index=True)
    profiles = pd.concat(prof_parts, ignore_index=True)

    # Stop-code signature of each cycle, e.g. "4-2048-1-1024", and its outcome class
    sr = step_res.sort_values(["file_id", "step"])
    sig = sr.groupby("file_id").agg(
        signature=("Stop Code", lambda c: "-".join(str(int(v)) for v in c)),
        last_step=("step", "max"), final_code=("Stop Code", "last"))
    last_prog = program.groupby("file_id")["step"].max().rename("last_prog_step")
    hole_feat = hole_feat.join(sig, on="file_id").join(last_prog, on="file_id")
    hole_feat["valid"] = hole_feat["file_id"].isin(valid)
    hole_feat["outcome"] = [_outcome(r) for r in hole_feat.itertuples()]
    # profiles: integer 0.1 mm bin index (depth_bin is float32, not exactly comparable)
    profiles["bin"] = np.rint(profiles["depth_bin"].astype("float64") * 10).astype("int32")
    return dict(tools=tools, holes=hole_feat, program=program, step_res=step_res,
                step_feat=step_feat, profiles=profiles)


def build(source, force: bool = False, log=print) -> Dataset:
    t0 = time.time()
    fp = source.fingerprint()
    cdir = CACHE_DIR / fp
    if not force and (cdir / "meta.json").exists():
        tables = {t: pd.read_parquet(cdir / f"{t}.parquet") for t in TABLES}
        meta = json.loads((cdir / "meta.json").read_text())
        meta["loaded_from_cache"] = True
        log(f"  loaded aggregates from cache {fp} in {time.time() - t0:.1f} s")
    else:
        log(f"  computing aggregates from {source.describe()} …")
        tables = compute(source, log)
        tmp = CACHE_DIR / f"{fp}.tmp"
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir(parents=True)
        for t, df in tables.items():
            df.to_parquet(tmp / f"{t}.parquet", index=False)
        meta = dict(fingerprint=fp, source=source.describe(), source_kind=source.kind,
                    built_at=time.strftime("%Y-%m-%d %H:%M:%S"), build_seconds=round(time.time() - t0, 1),
                    cycles=int(len(tables["holes"])), tools=int(len(tables["tools"])),
                    rows={t: int(len(df)) for t, df in tables.items()})
        (tmp / "meta.json").write_text(json.dumps(meta, indent=2))
        shutil.rmtree(cdir, ignore_errors=True)
        tmp.rename(cdir)
        meta["loaded_from_cache"] = False
        prune_cache(keep=fp)
        log(f"  aggregates computed and cached in {time.time() - t0:.1f} s")
    meta["size_bytes"] = sum(p.stat().st_size for p in cdir.glob("*"))
    rates = tables["holes"].set_index("file_id")["sample_rate"]
    return Dataset(**tables, rates=rates, meta=meta, source=source)


def prune_cache(keep: str) -> None:
    dirs = sorted((d for d in CACHE_DIR.glob("*") if d.is_dir() and d.name != keep),
                  key=lambda d: d.stat().st_mtime, reverse=True)
    for d in dirs[KEEP_CACHES - 1:]:
        shutil.rmtree(d, ignore_errors=True)


def clear_cache() -> None:
    shutil.rmtree(CACHE_DIR, ignore_errors=True)
