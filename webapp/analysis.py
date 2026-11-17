"""Group analysis: robust outliers and k-means clusters over the cycles of a group of tools.

One point = one cycle (one drilled hole). Method, in order:
1. Features per cycle (torque P95, thrust P95, ...). When the group mixes diameters, every value is
   divided by the median of the OK cycles of its diameter (whole campaign), so a Ø14.3 drill is not
   an outlier just because it is bigger.
2. Baseline = OK cycles of the group (all cycles if the group has fewer than MIN_OK OK cycles).
3. Robust z-score per feature: (x - median) / scale, with scale = 1.4826 * MAD, floored by
   1.2533 * mean absolute deviation (both ≈ σ for normal data); taken on the baseline.
   A cycle is an outlier when any |z| exceeds the threshold; the features responsible are its reasons.
4. k-means on the z-scores (clipped at ±CLIP so one extreme cycle cannot own a cluster), fitted on the
   baseline, k chosen by silhouette in [kmin, kmax]. Every cycle (KO included) is then assigned.
5. PCA (2 components) of the same z-scores, fitted on the baseline, for the map.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from sklearn.metrics import silhouette_score

FEATURES = {  # key -> (label, unit)
    "torque_p95": ("Torque P95", "A"),
    "thrust_p95": ("Thrust P95", "A"),
    "torque_mean": ("Mean torque", "A"),
    "energy_J_per_mm": ("Specific energy", "J/mm"),
    "cycle_time_s": ("Cycle time", "s"),
    "thrust_mean": ("Mean thrust", "A"),
    "gap_max": ("Max peck gap", "mm"),
}
DEFAULT_FEATURES = ["torque_p95", "thrust_p95", "torque_mean", "energy_J_per_mm", "cycle_time_s"]
MIN_OK = 10
CLIP = 6.0
PROFILE_Z = 0.75  # |median z| above which a feature characterises a cluster


def _f(v, nd=3):
    if v is None:
        return None
    v = float(v)
    return round(v, nd) if math.isfinite(v) else None


def _robust_scale(x: pd.DataFrame) -> tuple[pd.Series, pd.Series]:
    med = x.median()
    mad = (x - med).abs().median() * 1.4826
    # mean absolute deviation floor: when most cycles share one value (e.g. no peck gap) the MAD
    # collapses towards 0 and every other cycle would explode to a huge z
    meanad = (x - med).abs().mean() * 1.2533
    scale = np.maximum(mad, meanad)
    scale = scale.where(scale > 1e-12, x.std()).where(lambda s: s > 1e-12, 1.0)
    return med, scale


def group_analysis(holes: pd.DataFrame, refs: list[str], features: list[str], z_thr: float = 3.5,
                   kmin: int = 2, kmax: int = 4) -> dict:
    features = [f for f in features if f in FEATURES] or DEFAULT_FEATURES
    all_valid = holes[holes["valid"]]
    h = all_valid[all_valid["tool_ref"].isin(refs)].copy()
    if h.empty:
        raise ValueError("No usable cycles for this group")

    missing = h[features].isna().any(axis=1)
    n_excluded = int(missing.sum())
    h = h[~missing].sort_values(["tool_ref", "hole_idx"]).reset_index(drop=True)
    raw = h[features].astype(float)

    normalised = h["diametre"].nunique() > 1
    x = raw.copy()
    if normalised:
        ref = all_valid[all_valid["cycle_ok"]] if all_valid["cycle_ok"].any() else all_valid
        per_diam = ref.groupby("diametre")[features].median()
        fallback = all_valid.groupby("diametre")[features].median()
        norms = per_diam.reindex(fallback.index).fillna(fallback)
        x = raw / norms.loc[h["diametre"]].to_numpy()

    ok = h["cycle_ok"].to_numpy(bool)
    basis_kind = "ok" if ok.sum() >= MIN_OK else "all"
    fit = ok if basis_kind == "ok" else np.ones(len(h), bool)

    med, scale = _robust_scale(x[fit])
    z = (x - med) / scale
    zabs = z.abs()
    outlier = (zabs > z_thr).any(axis=1).to_numpy()

    zc = z.clip(-CLIP, CLIP).to_numpy()
    zfit = zc[fit]

    # k-means, k by silhouette
    k_best, labels, sil = 1, np.zeros(len(h), int), None
    k_hi = min(kmax, len(zfit) - 1)
    best = None
    for k in range(max(2, kmin), k_hi + 1):
        km = KMeans(n_clusters=k, n_init=10, random_state=0).fit(zfit)
        if len(set(km.labels_)) < 2:
            continue
        s = silhouette_score(zfit, km.labels_)
        if best is None or s > best[0]:
            best = (s, k, km)
    if best:
        sil, k_best, km = best
        labels = km.predict(zc)
    # rename clusters by size on the baseline (A = largest)
    order = pd.Series(labels[fit]).value_counts().index.tolist()
    order += [c for c in range(k_best) if c not in order]
    remap = {old: new for new, old in enumerate(order)}
    labels = np.array([remap[c] for c in labels])

    n_comp = min(2, zfit.shape[1], len(zfit))
    pca = PCA(n_components=n_comp).fit(zfit)
    pcs = pca.transform(zc)
    if n_comp < 2:
        pcs = np.column_stack([pcs, np.zeros(len(pcs))])
    loadings = [
        sorted(({"feature": f, "weight": _f(w, 2)} for f, w in zip(features, comp)), key=lambda d: -abs(d["weight"]))
        for comp in pca.components_
    ]

    reasons = []
    for i in range(len(h)):
        if not outlier[i]:
            reasons.append([])
            continue
        r = [{"feature": f, "z": _f(z.iat[i, j], 1), "value": _f(raw.iat[i, j], 2)}
             for j, f in enumerate(features) if zabs.iat[i, j] > z_thr]
        reasons.append(sorted(r, key=lambda d: -abs(d["z"])))

    clusters = []
    for c in range(k_best):
        members = labels == c
        base_members = members & fit
        zm = pd.DataFrame(zc[base_members if base_members.any() else members], columns=features).median()
        traits = [{"feature": f, "z": _f(v, 2)} for f, v in zm.items() if abs(v) >= PROFILE_Z]
        traits.sort(key=lambda d: -abs(d["z"]))
        life = h.loc[members, "life_frac"].median()
        tools = h.loc[members, "tool_ref"].value_counts()
        clusters.append(dict(
            id=c, name=chr(65 + c), n=int(members.sum()), n_ok=int((members & ok).sum()),
            n_ko=int((members & ~ok).sum()), n_outliers=int((members & outlier).sum()),
            median_z={f: _f(v, 2) for f, v in zm.items()}, traits=traits,
            raw_median={f: _f(raw.loc[members, f].median(), 2) for f in features},
            life_median=_f(life, 2), tools={k: int(v) for k, v in tools.items()},
        ))

    per_tool = []
    for ref_, g in h.groupby("tool_ref"):
        idx = g.index.to_numpy()
        per_tool.append(dict(tool_ref=ref_, n=int(len(g)), n_outliers=int(outlier[idx].sum()),
                             clusters={chr(65 + c): int((labels[idx] == c).sum()) for c in range(k_best)}))

    return dict(
        tools=sorted(set(h["tool_ref"])), features=[dict(key=f, label=FEATURES[f][0], unit=FEATURES[f][1]) for f in features],
        normalised=normalised, basis=basis_kind, n=int(len(h)), n_fit=int(fit.sum()), n_excluded=n_excluded,
        z_threshold=z_thr, k=k_best, silhouette=_f(sil, 3), explained=[_f(v, 3) for v in pca.explained_variance_ratio_],
        loadings=loadings,
        baseline=dict(median={f: _f(raw[fit][f].median(), 3) for f in features}),
        points=dict(
            file_id=h["file_id"].astype(int).tolist(), tool_ref=h["tool_ref"].tolist(),
            hole_idx=h["hole_idx"].astype(int).tolist(), cycle_ok=ok.tolist(), outcome=h["outcome"].tolist(),
            fit=fit.tolist(), pc1=[_f(v) for v in pcs[:, 0]], pc2=[_f(v) for v in pcs[:, 1]],
            cluster=labels.astype(int).tolist(), outlier=outlier.tolist(), reasons=reasons,
            values={f: [_f(v, 3) for v in raw[f]] for f in features},
        ),
        clusters=clusters, per_tool=per_tool,
    )
