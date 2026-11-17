# Setitec Tool Performance Workbench

A local dashboard and notebooks for exploring drilling-tool performance. The workbench compares recorded cycle outcomes, torque and thrust behavior, depth profiles, and stop-code patterns. Qualification decisions remain with the reviewer.

## Setup

Use Python 3.10 or later. From the project root:

```sh
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

For the notebooks, install their additional tools:

```sh
python -m pip install -r requirements-notebooks.txt
```

## Prepare data

The source data is kept locally and is not included in Git. Place raw Setitec exports under:

```text
Data/04 Qualification Outils Coupants/<tool-folder>/
```

Open `notebooks/data_ingestion.ipynb` in Jupyter or VS Code and run it from the project environment. It creates the metadata database and Parquet files used by the dashboard under `Data/Output Data/`. The ingestion notebook expects the legacy Setitec sectioned exports; the dashboard’s folder review can also inspect CSV files.

## Launch

From the project root, with the environment active:

```sh
python webapp/server.py
```

The dashboard opens at `http://127.0.0.1:8050`. To choose another port or keep the browser closed:

```sh
python webapp/server.py --port 9000 --no-browser
```

## Project layout

- `webapp/` — local dashboard and folder review
- `notebooks/` — ingestion, per-tool analysis, and data inspection notebooks
- `helper.py` — shared data loading and feature calculations
- `Data/` — local source and generated data; ignored by Git

`requirements-freeze.txt` is a snapshot of the original notebook environment. Standard setup uses the two focused requirements files above.
