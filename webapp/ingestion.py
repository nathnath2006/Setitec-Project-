"""Read-only inventory and quality preview for Setitec drilling exports."""
from __future__ import annotations

import csv
import io
import re
from collections import Counter
from pathlib import Path

import pandas as pd

SECTIONS = {
    "*** General Infos ***": "general_infos",
    "*** Control Box Datas ***": "control_box",
    "*** Motor Datas ***": "motor_box",
    "*** Head Datas ***": "head",
    "*** Pset ***": "pset",
    "*** Cycle Parameters ***": "cycle_parameters",
    "*** Program ***": "program",
    "*** Results ***": "results",
    "*** Step Results ***": "step_results",
    "*** Datas ***": "data",
}
EXPECTED_SECTIONS = {"general_infos", "program", "results", "step_results", "data"}
SIGNALS = {
    "Position (mm)": ("position (mm)",),
    "Torque current (A)": ("i torque (a)", "torque current (a)", "torque (a)"),
    "Thrust current (A)": ("i thrust (a)", "thrust current (a)", "thrust (a)"),
    "Spindle power (W)": ("torque power (w)", "spindle power (w)", "power (w)"),
    "Peck gap (mm)": ("gap length (mm)", "peck gap (mm)"),
    "Step": ("step (nb)", "step number", "step"),
    "Stop code": ("stop code", "stop codes"),
}


def _key(value: object) -> str:
    return re.sub(r"\s+", " ", str(value).strip().lower())


def _new_quality() -> dict[str, dict]:
    return {label: {"rows": 0, "missing": 0, "non_numeric": 0, "min": None, "max": None, "sample": []}
            for label in SIGNALS}


def _update_quality(quality: dict[str, dict], frame: pd.DataFrame) -> None:
    normalized = {_key(c): c for c in frame.columns}
    for label, aliases in SIGNALS.items():
        col = next((normalized[a] for a in aliases if a in normalized), None)
        if col is None:
            continue
        raw = frame[col]
        values = pd.to_numeric(raw, errors="coerce")
        blank = raw.isna() | raw.astype("string").str.strip().eq("")
        valid = values.dropna()
        item = quality[label]
        item["rows"] += int(len(raw))
        item["missing"] += int(blank.sum())
        item["non_numeric"] += int((values.isna() & ~blank).sum())
        if len(valid):
            lo, hi = float(valid.min()), float(valid.max())
            item["min"] = lo if item["min"] is None else min(item["min"], lo)
            item["max"] = hi if item["max"] is None else max(item["max"], hi)
            room = max(0, 50_000 - len(item["sample"]))
            if room:
                stride = max(1, len(valid) // min(2_000, room))
                item["sample"].extend(float(v) for v in valid.iloc[::stride].head(min(2_000, room)))
                if len(item["sample"]) > 50_000:
                    item["sample"] = item["sample"][::2]


def _merge_quality(total: dict[str, dict], part: dict[str, dict]) -> None:
    for label, row in part.items():
        if not row["rows"]:
            continue
        item = total[label]
        item["files"] = item.get("files", 0) + 1
        for key in ("rows", "missing", "non_numeric"):
            item[key] += row[key]
        if row["min"] is not None:
            item["min"] = row["min"] if item["min"] is None else min(item["min"], row["min"])
            item["max"] = row["max"] if item["max"] is None else max(item["max"], row["max"])
            item["sample"].extend(row["sample"])
            if len(item["sample"]) > 50_000:
                item["sample"] = item["sample"][::2]


def _quality_report(total: dict[str, dict]) -> dict[str, dict]:
    result = {}
    for label, row in total.items():
        sample = sorted(row["sample"])
        def quantile(q: float):
            return round(sample[round((len(sample) - 1) * q)], 4) if sample else None
        result[label] = {"files": row.get("files", 0), "rows": row["rows"], "missing": row["missing"],
                         "non_numeric": row["non_numeric"], "min": round(row["min"], 4) if row["min"] is not None else None,
                         "p50": quantile(0.5), "p95": quantile(0.95),
                         "max": round(row["max"], 4) if row["max"] is not None else None}
    return result


def _frames_from_legacy(path: Path) -> tuple[dict[str, pd.DataFrame], list[str]]:
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    markers = [(i, SECTIONS[line.strip()]) for i, line in enumerate(lines) if line.strip() in SECTIONS]
    frames: dict[str, pd.DataFrame] = {}
    if not markers:
        raise ValueError("No Setitec section headers found")
    for marker_idx, (start, name) in enumerate(markers):
        end = markers[marker_idx + 1][0] if marker_idx + 1 < len(markers) else len(lines)
        body = [line.rstrip("\t\r") for line in lines[start + 1:end] if line.strip()]
        if not body:
            continue
        if name in {"program", "step_results", "data"}:
            frames[name] = pd.read_csv(io.StringIO("\n".join(body)), sep="\t", decimal=",", skipinitialspace=True,
                                       on_bad_lines="skip")
        else:
            # Header/value sections are pairs; only the header names are needed for quality inventory.
            names = []
            for i in range(0, len(body), 2):
                names.extend(x.strip() for x in body[i].split("\t") if x.strip())
            frames[name] = pd.DataFrame(columns=names)
    return frames, [name for _, name in markers]


def _scan_binary_xls(path: Path) -> tuple[list[str], int, Counter, dict[str, int], dict[str, dict]]:
    sheets = pd.read_excel(path, sheet_name=None, engine="xlrd")
    names, rows = [], 0
    stop_counts: Counter = Counter()
    signal_counts: dict[str, int] = {label: 0 for label in SIGNALS}
    quality = _new_quality()
    for sheet_name, frame in sheets.items():
        names.extend(str(c).strip() for c in frame.columns)
        rows += len(frame)
        _update_quality(quality, frame)
        normalized = {_key(c): c for c in frame.columns}
        for label, aliases in SIGNALS.items():
            col = next((normalized[a] for a in aliases if a in normalized), None)
            if col is not None:
                signal_counts[label] = 1
                if label == "Stop code":
                    values = pd.to_numeric(frame[col], errors="coerce").dropna().astype("int64")
                    stop_counts.update(values.value_counts().to_dict())
    return names, rows, stop_counts, signal_counts, quality


def _read_csv_chunks(path: Path) -> tuple[list[str], int, Counter, dict[str, int], dict[str, dict]]:
    # Sniff the common comma, semicolon, tab, and pipe exports without loading an entire large file.
    with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as stream:
        sample = stream.read(8192)
        stream.seek(0)
        try:
            dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
            sep = dialect.delimiter
        except csv.Error:
            sep = ","
    rows = 0
    stop_counts: Counter = Counter()
    signal_counts: dict[str, int] = {}
    columns: list[str] = []
    quality = _new_quality()
    for chunk in pd.read_csv(path, sep=sep, decimal=",", encoding="utf-8-sig", encoding_errors="replace",
                             chunksize=100_000, on_bad_lines="skip"):
        if not columns:
            columns = [str(c).strip() for c in chunk.columns]
            norm = {_key(c): c for c in columns}
            for label, aliases in SIGNALS.items():
                signal_counts[label] = int(any(alias in norm for alias in aliases))
        rows += len(chunk)
        _update_quality(quality, chunk)
        normalized = {_key(c): c for c in chunk.columns}
        stop_col = next((normalized[a] for a in SIGNALS["Stop code"] if a in normalized), None)
        if stop_col:
            values = pd.to_numeric(chunk[stop_col], errors="coerce").dropna().astype("int64")
            stop_counts.update(values.value_counts().to_dict())
    return columns, rows, stop_counts, signal_counts, quality


def scan_folder(folder: str) -> dict:
    root = Path(folder).expanduser().resolve(strict=True)
    if not root.is_dir():
        raise ValueError("Choose a folder, not a file")

    candidates = sorted(p for p in root.rglob("*") if p.is_file() and p.suffix.lower() in {".xls", ".csv"})
    if len(candidates) > 5000:
        raise ValueError(f"Found {len(candidates):,} files; scan a folder with at most 5,000 supported files")

    file_rows = []
    section_counts: Counter = Counter()
    stop_counts: Counter = Counter()
    signal_files: Counter = Counter()
    signal_quality = _new_quality()
    total_data_rows = 0
    file_names: Counter = Counter(p.name.casefold() for p in candidates)
    duplicate_names = {name for name, count in file_names.items() if count > 1}

    for path in candidates:
        rel = path.relative_to(root).as_posix()
        row = {"name": rel, "format": path.suffix.lower()[1:], "bytes": path.stat().st_size,
               "status": "read", "rows": 0, "sections": [], "signals": [], "notes": []}
        try:
            if path.suffix.lower() == ".xls":
                with path.open("rb") as stream:
                    prefix = stream.read(8)
                if prefix.startswith(b"\xd0\xcf\x11\xe0"):
                    headers, nrows, stops, signals, file_quality = _scan_binary_xls(path)
                    row["rows"] = nrows
                    row["columns"] = headers[:40]
                    row["signals"] = [label for label, present in signals.items() if present]
                    signal_files.update(row["signals"])
                    _merge_quality(signal_quality, file_quality)
                    stop_counts.update(stops)
                    total_data_rows += nrows
                else:
                    frames, sections = _frames_from_legacy(path)
                    row["sections"] = sorted(set(sections))
                    section_counts.update(set(sections))
                    missing = EXPECTED_SECTIONS - set(sections)
                    if missing:
                        row["notes"].append("Missing sections: " + ", ".join(sorted(missing)))
                    data = frames.get("data", pd.DataFrame())
                    row["rows"] = int(len(data))
                    file_quality = _new_quality()
                    _update_quality(file_quality, data)
                    _merge_quality(signal_quality, file_quality)
                    header_keys = {_key(c) for c in data.columns}
                    for label, aliases in SIGNALS.items():
                        if any(alias in header_keys for alias in aliases):
                            row["signals"].append(label)
                            signal_files[label] += 1
                    # Step-results contains one stop code per completed program step; the raw data
                    # section repeats the active code across many samples and would inflate counts.
                    frame = frames.get("step_results")
                    if frame is not None:
                        normalized = {_key(c): c for c in frame.columns}
                        stop_col = next((normalized[a] for a in SIGNALS["Stop code"] if a in normalized), None)
                        if stop_col:
                            values = pd.to_numeric(frame[stop_col], errors="coerce").dropna().astype("int64")
                            stop_counts.update(values.value_counts().to_dict())
                    total_data_rows += int(len(data))
            else:
                columns, nrows, stops, signals, file_quality = _read_csv_chunks(path)
                row["rows"] = nrows
                row["columns"] = columns[:40]
                row["signals"] = [label for label, present in signals.items() if present]
                signal_files.update(row["signals"])
                _merge_quality(signal_quality, file_quality)
                stop_counts.update(stops)
                total_data_rows += nrows
            if path.name.casefold() in duplicate_names:
                row["notes"].append("Duplicate filename appears in more than one subfolder")
            if row["bytes"] == 0:
                row["notes"].append("File is empty")
        except Exception as exc:  # report per-file problems and continue scanning the folder
            row["status"] = "error"
            row["notes"].append(f"{type(exc).__name__}: {exc}")
        file_rows.append(row)

    by_format = Counter(row["format"] for row in file_rows)
    return {
        "folder": str(root), "files_found": len(file_rows), "files_read": sum(r["status"] == "read" for r in file_rows),
        "files_with_errors": sum(r["status"] == "error" for r in file_rows),
        "by_format": dict(by_format), "data_rows": total_data_rows,
        "sections": dict(section_counts), "signal_files": dict(signal_files),
        "signal_quality": _quality_report(signal_quality),
        "stop_codes": [{"code": int(code), "count": int(count)} for code, count in sorted(stop_counts.items())],
        "files": file_rows[:250], "files_truncated": len(file_rows) > 250,
        "duplicates": len(duplicate_names),
    }
