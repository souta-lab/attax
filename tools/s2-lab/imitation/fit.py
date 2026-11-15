#!/usr/bin/env python3
"""
Canonical Section D imitation fitting & mechanism-mismatch evaluation pipeline.

Implements:
  1. Fit 1 ("existing"): existing driver 24-dim weights on annotations.existing
  2. Fit 2 ("corrected"): corrected S2 driver 24-dim weights on annotations.corrected
  3. Fit 3 ("corrected_augmented"): corrected S2 + §C1 stock & §C2 solvency 34-dim weights

For each representation:
  - Separates pure preference (rescueApplied == false, rankZero target) from
    avoidable-death / solvency rescue decisions (hasAvoidableDeath, survival loss)
  - Minimizes §D set-valued ranking loss with temperature tau + L2 pull to theta_0
    using L-BFGS-B with exact analytic gradients & vectorized softmax over ragged candidate sets
  - Selects (tau, lambda) strictly on validation split (`val`), evaluates on untouched `test`
  - Verifies multi-start stability (theta_0, zeros, 3 perturbed starts)
  - Reports all 4 §D plateau ceilings, stratification breakdowns, tree-reuse noise floor,
    and exports fitted weight JSONs ready for Pass-2 iterative beam regeneration.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import numpy as np
from scipy.optimize import minimize

ALL_FEATURE_NAMES: list[str] = [
    "board.maxHeight",
    "board.danger",
    "board.holes",
    "board.holeCover",
    "board.holeRows",
    "board.bumpiness",
    "board.bumpinessSq",
    "board.rowTransitions",
    "board.wellDepth",
    "board.extraWells",
    "board.tSlot",
    "attack",
    "conversion",
    "clear.single",
    "clear.double",
    "clear.triple",
    "clear.quad",
    "clear.tspinMini",
    "clear.tspinSingle",
    "clear.tspinDouble",
    "clear.tspinTriple",
    "clear.perfectClear",
    "b2bBreak",
    "wastedT",
    "stock.surgeCashable",
    "stock.surgeGated",
    "stock.b2bBuildGated",
    "stock.comboGated",
    "solvency.rootDeficit",
    "solvency.pathMinDeficit",
    "solvency.pendingLeaf",
    "solvency.pathFatal",
    "solvency.highDanger",
    "downstack.garbageCleared",
]

BASE_DIM = 24
AUG_DIM = 10
TOTAL_DIM = 34
assert len(ALL_FEATURE_NAMES) == TOTAL_DIM

DEFAULT_DISCOUNT = 0.97
S2_SEED_VEC24 = np.array(
    [
        -6.0,
        -40.0,
        -60.0,
        -12.0,
        -40.0,
        -8.0,
        -3.0,
        -6.0,
        18.0,
        -40.0,
        60.0,
        90.0,
        0.0,
        -60.0,
        -40.0,
        -30.0,
        60.0,
        -20.0,
        40.0,
        120.0,
        160.0,
        400.0,
        -90.0,
        -50.0,
    ],
    dtype=np.float64,
)
S2_SEED_VEC34 = np.concatenate([S2_SEED_VEC24, np.zeros(AUG_DIM, dtype=np.float64)])


class PackedDecisions:
    """Flattened CSR-like representation of ragged candidate sets for fast L-BFGS-B."""

    def __init__(
        self,
        phi: np.ndarray,
        counts: np.ndarray,
        pos_mask: np.ndarray,
        strict_pos_mask: np.ndarray,
        weights: np.ndarray,
        cand_action_indices: np.ndarray,
        target_action_indices: np.ndarray,
        record_indices: np.ndarray,
    ) -> None:
        self.phi = phi  # (M, D)
        self.counts = counts  # (N,)
        self.pos_mask = pos_mask  # (M,) bool
        self.strict_pos_mask = strict_pos_mask  # (M,) bool
        self.weights = weights  # (N,) float64
        self.cand_action_indices = cand_action_indices  # (M,) int64
        self.target_action_indices = target_action_indices  # (N,) int64
        self.record_indices = record_indices  # (N,) int64

        self.n_decisions = int(len(counts))
        self.dim = int(phi.shape[1]) if len(phi) > 0 else 0
        self.total_weight = float(np.sum(weights)) if self.n_decisions > 0 else 0.0
        if self.n_decisions > 0:
            self.starts = np.zeros(self.n_decisions, dtype=np.int64)
            if self.n_decisions > 1:
                self.starts[1:] = np.cumsum(counts[:-1], dtype=np.int64)
            self.ends = self.starts + counts
            self.seg_ids = np.repeat(np.arange(self.n_decisions, dtype=np.int64), counts)
        else:
            self.starts = np.empty(0, dtype=np.int64)
            self.ends = np.empty(0, dtype=np.int64)
            self.seg_ids = np.empty(0, dtype=np.int64)


def set_ranking_loss_and_grad(
    theta: np.ndarray,
    packed: PackedDecisions,
    tau: float,
    theta0: np.ndarray | None = None,
    lam: float = 0.0,
) -> tuple[float, np.ndarray]:
    """
    Exact Canonical §D set-valued ranking loss & analytic gradient:
      L(theta) = - sum_s w_s * log( sum_{a in A*_s} exp(Q/tau) / sum_{a in A_s} exp(Q/tau) ) / sum w_s
                 + lam * ||theta - theta0||^2
    """
    if packed.n_decisions == 0 or packed.total_weight <= 0.0:
        reg = lam * float(np.sum((theta - theta0) ** 2)) if (theta0 is not None and lam > 0) else 0.0
        grad_reg = (
            2.0 * lam * (theta - theta0)
            if (theta0 is not None and lam > 0)
            else np.zeros_like(theta)
        )
        return reg, grad_reg

    logits = (packed.phi @ theta) / tau
    counts = packed.counts
    starts = packed.starts

    # Segment-wise max over all candidates in each decision
    max_all = np.maximum.reduceat(logits, starts)
    exp_all = np.exp(logits - np.repeat(max_all, counts))
    sum_exp_all = np.add.reduceat(exp_all, starts)
    logz_all = max_all + np.log(sum_exp_all)
    p_all = exp_all / np.repeat(sum_exp_all, counts)

    # Segment-wise max over positive target set A*_s
    pos_logits = np.where(packed.pos_mask, logits, -1e300)
    max_pos = np.maximum.reduceat(pos_logits, starts)
    exp_pos = np.where(packed.pos_mask, np.exp(pos_logits - np.repeat(max_pos, counts)), 0.0)
    sum_exp_pos = np.add.reduceat(exp_pos, starts)
    logz_pos = max_pos + np.log(np.maximum(sum_exp_pos, 1e-300))
    p_pos_cond = exp_pos / np.repeat(np.maximum(sum_exp_pos, 1e-300), counts)

    per_decision_loss = logz_all - logz_pos
    mean_loss = float(np.dot(packed.weights, per_decision_loss) / packed.total_weight)

    cand_weights = np.repeat(packed.weights / packed.total_weight, counts)
    residual = cand_weights * (p_all - p_pos_cond)
    grad = (packed.phi.T @ residual) / tau

    if theta0 is not None and lam > 0.0:
        diff = theta - theta0
        mean_loss += lam * float(np.dot(diff, diff))
        grad += 2.0 * lam * diff

    return mean_loss, grad


def evaluate_packed_metrics(
    theta: np.ndarray,
    packed: PackedDecisions,
    tau: float,
    total_records_in_scope: int,
) -> dict[str, Any]:
    """Computes strict NLL, set NLL, expressible & unconditional top-1/top-3/mean rank."""
    n = packed.n_decisions
    if n == 0:
        return {
            "expressibleCount": 0,
            "scopeCount": total_records_in_scope,
            "coverageRate": 0.0,
            "strictNll": None,
            "setNll": None,
            "strictTop1Expressible": None,
            "setTop1Expressible": None,
            "top3Expressible": None,
            "meanRankExpressible": None,
            "strictTop1FullScope": 0.0 if total_records_in_scope > 0 else None,
        }

    scores = packed.phi @ theta
    starts = packed.starts
    ends = packed.ends

    strict_top1_hits = 0
    set_top1_hits = 0
    top3_hits = 0
    rank_sum = 0.0

    # Fast exact NLL using set_ranking_loss_and_grad
    set_nll, _ = set_ranking_loss_and_grad(theta, packed, tau=tau)

    # Strict NLL over strict_pos_mask
    strict_packed = PackedDecisions(
        phi=packed.phi,
        counts=packed.counts,
        pos_mask=packed.strict_pos_mask,
        strict_pos_mask=packed.strict_pos_mask,
        weights=packed.weights,
        cand_action_indices=packed.cand_action_indices,
        target_action_indices=packed.target_action_indices,
        record_indices=packed.record_indices,
    )
    strict_nll, _ = set_ranking_loss_and_grad(theta, strict_packed, tau=tau)

    for i in range(n):
        s_idx = int(starts[i])
        e_idx = int(ends[i])
        sc = scores[s_idx:e_idx]
        best_pos = int(np.argmax(sc))
        if packed.strict_pos_mask[s_idx + best_pos]:
            strict_top1_hits += 1
        if packed.pos_mask[s_idx + best_pos]:
            set_top1_hits += 1
        # Rank of strict positive (1-indexed; ties broken favorably or mid-rank via strict > check)
        strict_locs = np.flatnonzero(packed.strict_pos_mask[s_idx:e_idx])
        if len(strict_locs) > 0:
            target_score = float(np.max(sc[strict_locs]))
            higher = int(np.sum(sc > target_score + 1e-12))
            ties = int(np.sum(np.abs(sc - target_score) <= 1e-12))
            eff_rank = higher + 1.0 + max(0, ties - 1) * 0.5
            rank_sum += eff_rank
            if higher < 3:
                top3_hits += 1

    cov = n / total_records_in_scope if total_records_in_scope > 0 else 1.0
    return {
        "expressibleCount": n,
        "scopeCount": total_records_in_scope,
        "coverageRate": cov,
        "strictNll": strict_nll,
        "setNll": set_nll,
        "strictTop1Expressible": strict_top1_hits / n,
        "setTop1Expressible": set_top1_hits / n,
        "top3Expressible": top3_hits / n,
        "meanRankExpressible": rank_sum / n,
        "strictTop1FullScope": (
            strict_top1_hits / total_records_in_scope if total_records_in_scope > 0 else None
        ),
    }


def extract_near_equivalent_indices(
    record: dict[str, Any],
    target_idx: int,
    cand_indices: set[int],
    cand_fatal_by_idx: dict[int, bool],
    tie_eps: float,
) -> set[int]:
    """Builds set A*_s of teacher near-equivalent actions present in variant candidates."""
    positives = {target_idx}
    if tie_eps <= 0.0 or target_idx not in cand_indices:
        return positives

    target_fatal = cand_fatal_by_idx.get(target_idx, False)
    teacher = record["teacher"]
    root_children = teacher.get("rootChildren") or []
    val_by_idx: dict[int, float] = {}
    for ch in root_children:
        idx = ch.get("actionIndex", -1)
        if idx >= 0 and isinstance(ch.get("value"), (int, float)):
            val_by_idx[idx] = float(ch["value"])

    if target_idx in val_by_idx:
        v_best = val_by_idx[target_idx]
        for idx in cand_indices:
            if not target_fatal and cand_fatal_by_idx.get(idx, False):
                continue
            v = val_by_idx.get(idx)
            if v is not None and (v_best - v) <= tie_eps:
                positives.add(idx)
    return positives


def pack_choice_dataset(
    records: list[dict[str, Any]],
    record_indices: list[int],
    variant_key: str,
    dim: int,
    target_mode: str,
    tie_eps: float,
    rescue_filter: bool | None = None,
) -> tuple[PackedDecisions, int]:
    """
    Packs choice preference decisions for `variant_key` ("existing" | "corrected").
    - `target_mode`: "rankZero" | "selected"
    - `rescue_filter`: None (all), False (pure preference, rescueApplied==False), True (rescues only)
    Returns `(packed, scope_record_count)`.
    """
    phi_chunks: list[np.ndarray] = []
    pos_chunks: list[np.ndarray] = []
    strict_chunks: list[np.ndarray] = []
    cand_idx_chunks: list[np.ndarray] = []
    counts: list[int] = []
    weights: list[float] = []
    target_actions: list[int] = []
    kept_rec_indices: list[int] = []
    scope_count = 0

    for idx_in_list in record_indices:
        rec = records[idx_in_list]
        teacher = rec["teacher"]
        is_rescued = bool(teacher.get("rescueApplied", False))
        if rescue_filter is not None and is_rescued != rescue_filter:
            continue
        scope_count += 1

        ann = (rec.get("annotations") or {}).get(variant_key)
        if not ann:
            continue
        cands = ann.get("candidates") or []
        if len(cands) < 2:
            continue

        target_action = (
            int(teacher["rankZeroActionIndex"])
            if target_mode == "rankZero"
            else int(teacher["selectedActionIndex"])
        )
        cand_map = {int(c["actionIndex"]): c for c in cands}
        if target_action not in cand_map:
            continue

        cand_fatal_map = {
            int(c["actionIndex"]): bool(c.get("fatalAtRoot") or c.get("fatalOnBestPath"))
            for c in cands
        }
        pos_set = extract_near_equivalent_indices(
            rec, target_action, set(cand_map.keys()), cand_fatal_map, tie_eps
        )

        k = len(cands)
        mat = np.empty((k, dim), dtype=np.float64)
        p_mask = np.zeros(k, dtype=bool)
        s_mask = np.zeros(k, dtype=bool)
        c_arr = np.empty(k, dtype=np.int64)
        for j, c in enumerate(cands):
            mat[j, :] = c["phi34"][:dim]
            ai = int(c["actionIndex"])
            c_arr[j] = ai
            if ai == target_action:
                s_mask[j] = True
            if ai in pos_set:
                p_mask[j] = True

        if not np.any(s_mask):
            continue

        phi_chunks.append(mat)
        pos_chunks.append(p_mask)
        strict_chunks.append(s_mask)
        cand_idx_chunks.append(c_arr)
        counts.append(k)
        weights.append(1.0)
        target_actions.append(target_action)
        kept_rec_indices.append(idx_in_list)

    if not counts:
        empty_phi = np.empty((0, dim), dtype=np.float64)
        return (
            PackedDecisions(
                phi=empty_phi,
                counts=np.empty(0, dtype=np.int64),
                pos_mask=np.empty(0, dtype=bool),
                strict_pos_mask=np.empty(0, dtype=bool),
                weights=np.empty(0, dtype=np.float64),
                cand_action_indices=np.empty(0, dtype=np.int64),
                target_action_indices=np.empty(0, dtype=np.int64),
                record_indices=np.empty(0, dtype=np.int64),
            ),
            scope_count,
        )

    return (
        PackedDecisions(
            phi=np.vstack(phi_chunks),
            counts=np.array(counts, dtype=np.int64),
            pos_mask=np.concatenate(pos_chunks),
            strict_pos_mask=np.concatenate(strict_chunks),
            weights=np.array(weights, dtype=np.float64),
            cand_action_indices=np.concatenate(cand_idx_chunks),
            target_action_indices=np.array(target_actions, dtype=np.int64),
            record_indices=np.array(kept_rec_indices, dtype=np.int64),
        ),
        scope_count,
    )


def pack_survival_dataset(
    records: list[dict[str, Any]],
    record_indices: list[int],
    variant_key: str,
    dim: int,
    rescued_weight: float = 2.0,
) -> tuple[PackedDecisions, int]:
    """
    Packs avoidable-death decisions for the separate §D survival loss:
      - Safe candidates `S+_s`: !fatalAtRoot && !fatalOnBestPath && minSolvencyMargin >= 0
      - Unsafe candidates `S-_s`: complementary candidates in movegen
    Focuses exclusively on avoidable-death splits (both safe & unsafe candidates present,
    or stratification.hasAvoidableDeath).
    """
    phi_chunks: list[np.ndarray] = []
    pos_chunks: list[np.ndarray] = []
    strict_chunks: list[np.ndarray] = []
    cand_idx_chunks: list[np.ndarray] = []
    counts: list[int] = []
    weights: list[float] = []
    target_actions: list[int] = []
    kept_rec_indices: list[int] = []
    scope_count = 0

    for idx_in_list in record_indices:
        rec = records[idx_in_list]
        ann = (rec.get("annotations") or {}).get(variant_key)
        cands = (ann or {}).get("candidates") or []
        strat = rec.get("stratification") or {}

        has_safe_ref = any(
            not bool(a["referee"]["amountToppedOut"]) and bool(a["referee"]["solvent"])
            for a in rec["legalActions"]
        )
        is_avoidable = bool(strat.get("hasAvoidableDeath", False))

        if cands:
            safe_flags = [
                (not bool(c.get("fatalAtRoot")))
                and (not bool(c.get("fatalOnBestPath")))
                and float(c.get("minSolvencyMargin", 0.0)) >= 0.0
                for c in cands
            ]
            has_safe_cand = any(safe_flags)
            has_unsafe_cand = any(not f for f in safe_flags)
        else:
            safe_flags = []
            has_safe_cand = False
            has_unsafe_cand = False

        if not (is_avoidable or (has_safe_cand and has_unsafe_cand)):
            continue
        scope_count += 1

        if not ann or len(cands) < 2 or not (has_safe_cand and has_unsafe_cand):
            continue

        teacher = rec["teacher"]
        sel_idx = int(teacher["selectedActionIndex"])
        cand_map_idx = [int(c["actionIndex"]) for c in cands]
        if sel_idx not in cand_map_idx and not has_safe_ref:
            continue

        k = len(cands)
        mat = np.empty((k, dim), dtype=np.float64)
        p_mask = np.array(safe_flags, dtype=bool)
        s_mask = np.zeros(k, dtype=bool)
        for j, c in enumerate(cands):
            mat[j, :] = c["phi34"][:dim]
            if int(c["actionIndex"]) == sel_idx:
                s_mask[j] = True
        if not np.any(s_mask):
            s_mask = p_mask.copy()

        w = rescued_weight if bool(teacher.get("rescueApplied", False)) else 1.0
        phi_chunks.append(mat)
        pos_chunks.append(p_mask)
        strict_chunks.append(s_mask)
        cand_idx_chunks.append(np.array(cand_map_idx, dtype=np.int64))
        counts.append(k)
        weights.append(w)
        target_actions.append(sel_idx)
        kept_rec_indices.append(idx_in_list)

    if not counts:
        empty_phi = np.empty((0, dim), dtype=np.float64)
        return (
            PackedDecisions(
                phi=empty_phi,
                counts=np.empty(0, dtype=np.int64),
                pos_mask=np.empty(0, dtype=bool),
                strict_pos_mask=np.empty(0, dtype=bool),
                weights=np.empty(0, dtype=np.float64),
                cand_action_indices=np.empty(0, dtype=np.int64),
                target_action_indices=np.empty(0, dtype=np.int64),
                record_indices=np.empty(0, dtype=np.int64),
            ),
            scope_count,
        )

    return (
        PackedDecisions(
            phi=np.vstack(phi_chunks),
            counts=np.array(counts, dtype=np.int64),
            pos_mask=np.concatenate(pos_chunks),
            strict_pos_mask=np.concatenate(strict_chunks),
            weights=np.array(weights, dtype=np.float64),
            cand_action_indices=np.concatenate(cand_idx_chunks),
            target_action_indices=np.array(target_actions, dtype=np.int64),
            record_indices=np.array(kept_rec_indices, dtype=np.int64),
        ),
        scope_count,
    )


def run_lbfgsb(
    init_theta: np.ndarray,
    packed: PackedDecisions,
    tau: float,
    theta0: np.ndarray,
    lam: float,
    maxiter: int = 300,
) -> tuple[np.ndarray, float, bool]:
    def obj(th: np.ndarray) -> tuple[float, np.ndarray]:
        return set_ranking_loss_and_grad(th, packed, tau=tau, theta0=theta0, lam=lam)

    res = minimize(
        obj,
        init_theta.copy(),
        method="L-BFGS-B",
        jac=True,
        options={"maxiter": maxiter, "ftol": 1e-11, "gtol": 1e-7},
    )
    return res.x.astype(np.float64), float(res.fun), bool(res.success)


def adaptive_tau_grid(packed: PackedDecisions, theta0: np.ndarray) -> list[float]:
    if packed.n_decisions == 0:
        return [1.0, 5.0, 20.0]
    scores = packed.phi @ theta0
    gaps: list[float] = []
    for i in range(min(500, packed.n_decisions)):
        s = int(packed.starts[i])
        e = int(packed.ends[i])
        if e - s < 2:
            continue
        sc = np.sort(scores[s:e])
        gaps.append(max(0.05, float(sc[-1] - sc[-2])))
    med = float(np.median(gaps)) if gaps else 10.0
    candidates = sorted(
        {
            round(max(0.25, med * mult), 4)
            for mult in (0.1, 0.25, 0.5, 1.0, 2.0, 4.0)
        }
        | {1.0, 5.0, 20.0}
    )
    return candidates


def fit_with_val_and_multistart(
    train_packed: PackedDecisions,
    val_packed: PackedDecisions,
    val_scope: int,
    theta0: np.ndarray,
    lam_grid: tuple[float, ...] = (1e-4, 1e-3, 1e-2, 5e-2),
    seed: int = 20261115,
) -> dict[str, Any]:
    if train_packed.n_decisions == 0:
        return {
            "bestTheta": theta0.tolist(),
            "bestTau": 1.0,
            "bestLam": 1e-3,
            "gridResults": [],
            "multistart": {"nStarts": 0, "nllSpread": 0.0, "maxL2Diff": 0.0, "minCosine": 1.0},
        }

    tau_grid = adaptive_tau_grid(train_packed, theta0)
    grid_results: list[dict[str, Any]] = []
    best_val_nll = float("inf")
    best_theta = theta0.copy()
    best_tau = tau_grid[0]
    best_lam = lam_grid[0]

    eval_packed = val_packed if val_packed.n_decisions > 0 else train_packed
    eval_scope = val_scope if val_packed.n_decisions > 0 else train_packed.n_decisions

    for tau in tau_grid:
        for lam in lam_grid:
            th, tr_obj, conv = run_lbfgsb(theta0, train_packed, tau=tau, theta0=theta0, lam=lam)
            val_metrics = evaluate_packed_metrics(th, eval_packed, tau=tau, total_records_in_scope=eval_scope)
            # Compare hyperparameters on scale-invariant strict NLL or top-1 + setNll
            val_nll = float(val_metrics["strictNll"])
            grid_results.append(
                {
                    "tau": tau,
                    "lam": lam,
                    "converged": conv,
                    "trainRegObj": tr_obj,
                    "valStrictNll": val_nll,
                    "valSetNll": val_metrics["setNll"],
                    "valStrictTop1": val_metrics["strictTop1Expressible"],
                    "valSetTop1": val_metrics["setTop1Expressible"],
                }
            )
            if val_nll < best_val_nll:
                best_val_nll = val_nll
                best_theta = th
                best_tau = tau
                best_lam = lam

    # Multi-start verification at winning (best_tau, best_lam)
    rng = np.random.default_rng(seed)
    scale = max(1.0, float(np.linalg.norm(theta0))) / math.sqrt(len(theta0))
    starts = [
        ("theta0", theta0.copy()),
        ("zeros", np.zeros_like(theta0)),
        ("perturbed_1", theta0 + rng.normal(0.0, 0.25 * scale, size=len(theta0))),
        ("perturbed_2", theta0 + rng.normal(0.0, 0.25 * scale, size=len(theta0))),
        ("perturbed_3", theta0 + rng.normal(0.0, 0.25 * scale, size=len(theta0))),
    ]
    thetas: list[np.ndarray] = []
    nlls: list[float] = []
    best_ms_obj = float("inf")
    best_ms_theta = best_theta

    for _label, s_init in starts:
        th, obj_val, _ = run_lbfgsb(s_init, train_packed, tau=best_tau, theta0=theta0, lam=best_lam)
        m = evaluate_packed_metrics(th, eval_packed, tau=best_tau, total_records_in_scope=eval_scope)
        thetas.append(th)
        nlls.append(float(m["strictNll"]))
        if obj_val < best_ms_obj:
            best_ms_obj = obj_val
            best_ms_theta = th

    max_l2_diff = 0.0
    min_cosine = 1.0
    for i in range(len(thetas)):
        for j in range(i + 1, len(thetas)):
            diff = float(np.linalg.norm(thetas[i] - thetas[j]))
            max_l2_diff = max(max_l2_diff, diff)
            ni = float(np.linalg.norm(thetas[i]))
            nj = float(np.linalg.norm(thetas[j]))
            if ni > 1e-12 and nj > 1e-12:
                cos = float(np.dot(thetas[i], thetas[j]) / (ni * nj))
                min_cosine = min(min_cosine, cos)

    return {
        "bestTheta": best_ms_theta.tolist(),
        "bestTau": best_tau,
        "bestLam": best_lam,
        "gridResults": grid_results,
        "multistart": {
            "nStarts": len(starts),
            "valStrictNlls": nlls,
            "nllSpread": max(nlls) - min(nlls),
            "maxL2Diff": max_l2_diff,
            "minCosine": min_cosine,
        },
    }


def evaluate_joint_survival_and_selection(
    theta_choice: np.ndarray,
    theta_surv: np.ndarray,
    records: list[dict[str, Any]],
    indices: list[int],
    variant_key: str,
    dim: int,
    val_indices: list[int] | None = None,
) -> dict[str, Any]:
    """
    Tests whether linear composition `theta_choice + alpha * theta_surv` improves
    post-rescue (`rescueApplied == true`) and overall (`selectedActionIndex`) accuracy
    without hurting pure preference (`rescueApplied == false`).
    """
    alpha_candidates = [0.0, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0]
    chosen_alpha = 0.0
    if val_indices:
        best_val_acc = -1.0
        for alpha in alpha_candidates:
            joint = theta_choice + alpha * theta_surv
            hits = 0
            total = 0
            for ri in val_indices:
                rec = records[ri]
                ann = (rec.get("annotations") or {}).get(variant_key)
                cands = (ann or {}).get("candidates") or []
                if len(cands) < 2:
                    continue
                total += 1
                sel_idx = int(rec["teacher"]["selectedActionIndex"])
                phi = np.array([c["phi34"][:dim] for c in cands], dtype=np.float64)
                best_pos = int(np.argmax(phi @ joint))
                if int(cands[best_pos]["actionIndex"]) == sel_idx:
                    hits += 1
            acc = hits / total if total > 0 else 0.0
            if acc > best_val_acc:
                best_val_acc = acc
                chosen_alpha = alpha

    joint = theta_choice + chosen_alpha * theta_surv

    def eval_subset(pred_vec: np.ndarray, rescue_flag: bool | None) -> dict[str, Any]:
        scope_n = 0
        expr_n = 0
        sel_hits = 0
        rz_hits = 0
        safe_avoid_n = 0
        safe_hits = 0
        for ri in indices:
            rec = records[ri]
            is_r = bool(rec["teacher"].get("rescueApplied", False))
            if rescue_flag is not None and is_r != rescue_flag:
                continue
            scope_n += 1
            ann = (rec.get("annotations") or {}).get(variant_key)
            cands = (ann or {}).get("candidates") or []
            if len(cands) < 2:
                continue
            phi = np.array([c["phi34"][:dim] for c in cands], dtype=np.float64)
            best_cand = cands[int(np.argmax(phi @ pred_vec))]
            best_ai = int(best_cand["actionIndex"])
            expr_n += 1
            if best_ai == int(rec["teacher"]["selectedActionIndex"]):
                sel_hits += 1
            if best_ai == int(rec["teacher"]["rankZeroActionIndex"]):
                rz_hits += 1
            if rec["stratification"].get("hasAvoidableDeath", False):
                safe_avoid_n += 1
                if (
                    not bool(best_cand.get("fatalAtRoot"))
                    and not bool(best_cand.get("fatalOnBestPath"))
                    and float(best_cand.get("minSolvencyMargin", 0.0)) >= 0.0
                ):
                    safe_hits += 1
        return {
            "scopeCount": scope_n,
            "expressibleCount": expr_n,
            "selectedTop1Expressible": sel_hits / expr_n if expr_n > 0 else None,
            "selectedTop1FullScope": sel_hits / scope_n if scope_n > 0 else None,
            "rankZeroTop1Expressible": rz_hits / expr_n if expr_n > 0 else None,
            "avoidableDeathCount": safe_avoid_n,
            "avoidableDeathSafeRate": safe_hits / safe_avoid_n if safe_avoid_n > 0 else None,
        }

    return {
        "chosenAlpha": chosen_alpha,
        "choiceOnly_all": eval_subset(theta_choice, None),
        "choiceOnly_rescueFalse": eval_subset(theta_choice, False),
        "choiceOnly_rescueTrue": eval_subset(theta_choice, True),
        "jointBlend_all": eval_subset(joint, None),
        "jointBlend_rescueFalse": eval_subset(joint, False),
        "jointBlend_rescueTrue": eval_subset(joint, True),
    }


def compute_ceiling_and_stratification(
    theta: np.ndarray,
    records: list[dict[str, Any]],
    indices: list[int],
    variant_key: str,
    dim: int,
) -> dict[str, Any]:
    """Computes §D plateau ceilings (legal coverage, beam coverage, pruning depth) and strat metrics."""
    n = len(indices)
    if n == 0:
        return {"count": 0}

    allow180_false_hits = 0
    in_movegen_sel = 0
    in_movegen_rz = 0
    survived_sel = 0
    survived_rz = 0
    prune_depths_sel: list[int] = []
    prune_depths_rz: list[int] = []

    strat_dims: dict[str, dict[str, dict[str, int]]] = {
        "source": {},
        "heightBucket": {},
        "hasPressure": {},
        "b2bBucket": {},
        "activeRen": {},
        "nonTSpinAny": {},
        "releaseVsCharge": {},
        "hasAvoidableDeath": {},
        "rescueApplied": {},
    }

    def bump(dim_name: str, bucket: str, expr: bool, hit_sel: bool, hit_rz: bool) -> None:
        d = strat_dims[dim_name].setdefault(
            bucket, {"scope": 0, "expr": 0, "hitSel": 0, "hitRz": 0}
        )
        d["scope"] += 1
        if expr:
            d["expr"] += 1
            if hit_sel:
                d["hitSel"] += 1
            if hit_rz:
                d["hitRz"] += 1

    for ri in indices:
        rec = records[ri]
        t = rec["teacher"]
        st = rec["stratification"]
        if t.get("selectedInAllow180False"):
            allow180_false_hits += 1

        ann = (rec.get("annotations") or {}).get(variant_key)
        expr = False
        hit_sel = False
        hit_rz = False
        if ann:
            if ann.get("teacherSelectedInMovegen"):
                in_movegen_sel += 1
            if ann.get("teacherRankZeroInMovegen"):
                in_movegen_rz += 1
            if ann.get("teacherSelectedSurvivedBeam"):
                survived_sel += 1
            if ann.get("teacherRankZeroSurvivedBeam"):
                survived_rz += 1
            prune_depths_sel.append(int(ann.get("teacherSelectedPruningDepth", 0)))
            prune_depths_rz.append(int(ann.get("teacherRankZeroPruningDepth", 0)))

            cands = ann.get("candidates") or []
            if len(cands) >= 2:
                phi = np.array([c["phi34"][:dim] for c in cands], dtype=np.float64)
                pred_ai = int(cands[int(np.argmax(phi @ theta))]["actionIndex"])
                cand_ais = {int(c["actionIndex"]) for c in cands}
                if int(t["rankZeroActionIndex"]) in cand_ais:
                    expr = True
                    hit_sel = pred_ai == int(t["selectedActionIndex"])
                    hit_rz = pred_ai == int(t["rankZeroActionIndex"])

        bump("source", str(rec["source"]), expr, hit_sel, hit_rz)
        bump("heightBucket", str(st["heightBucket"]), expr, hit_sel, hit_rz)
        bump("hasPressure", str(st["hasPressure"]), expr, hit_sel, hit_rz)
        bump("b2bBucket", str(st["b2bBucket"]), expr, hit_sel, hit_rz)
        bump("activeRen", str(st["activeRen"]), expr, hit_sel, hit_rz)
        bump("nonTSpinAny", str(st["nonTSpinAnyOpportunity"]), expr, hit_sel, hit_rz)
        bump("releaseVsCharge", str(st["releaseVsCharge"]), expr, hit_sel, hit_rz)
        bump("hasAvoidableDeath", str(st["hasAvoidableDeath"]), expr, hit_sel, hit_rz)
        bump("rescueApplied", str(t["rescueApplied"]), expr, hit_sel, hit_rz)

    strat_summary: dict[str, Any] = {}
    for d_name, buckets in strat_dims.items():
        strat_summary[d_name] = {
            b: {
                **cnt,
                "coverage": cnt["expr"] / cnt["scope"] if cnt["scope"] > 0 else None,
                "rzTop1Expr": cnt["hitRz"] / cnt["expr"] if cnt["expr"] > 0 else None,
                "rzTop1Full": cnt["hitRz"] / cnt["scope"] if cnt["scope"] > 0 else None,
                "selTop1Expr": cnt["hitSel"] / cnt["expr"] if cnt["expr"] > 0 else None,
            }
            for b, cnt in sorted(buckets.items())
        }

    p_arr = np.array(prune_depths_rz, dtype=np.float64) if prune_depths_rz else np.zeros(1)
    return {
        "count": n,
        "allow180FalseRate": allow180_false_hits / n,
        "selectedInMovegenRate": in_movegen_sel / n,
        "rankZeroInMovegenRate": in_movegen_rz / n,
        "selectedSurvivedBeamRate": survived_sel / n,
        "rankZeroSurvivedBeamRate": survived_rz / n,
        "rankZeroPruningDepthMean": float(np.mean(p_arr)) if prune_depths_rz else 0.0,
        "rankZeroPruningDepthMedian": float(np.median(p_arr)) if prune_depths_rz else 0.0,
        "rankZeroPruningDepthP10": float(np.percentile(p_arr, 10)) if prune_depths_rz else 0.0,
        "rankZeroPruningDepthP90": float(np.percentile(p_arr, 90)) if prune_depths_rz else 0.0,
        "stratification": strat_summary,
    }


def summarize_dataset(records: list[dict[str, Any]]) -> dict[str, Any]:
    split_counts: dict[str, int] = {"train": 0, "val": 0, "test": 0}
    seeds_by_split: dict[str, set[int]] = {"train": set(), "val": set(), "test": set()}
    source_counts: dict[str, int] = {}
    fresh_total = 0
    fresh_sel_agree = 0
    fresh_rz_agree = 0
    rescue_count = 0

    for rec in records:
        sp = str(rec["split"])
        sd = int(rec["seed"])
        split_counts[sp] = split_counts.get(sp, 0) + 1
        seeds_by_split.setdefault(sp, set()).add(sd)
        src = str(rec["source"])
        source_counts[src] = source_counts.get(src, 0) + 1
        if rec["teacher"].get("rescueApplied"):
            rescue_count += 1
        fa = rec.get("freshAgreement")
        if fa is not None:
            fresh_total += 1
            if fa.get("agreesSelected"):
                fresh_sel_agree += 1
            if fa.get("agreesRankZero"):
                fresh_rz_agree += 1

    # Enforce strict whole-seed split guarantee
    tr, va, te = seeds_by_split["train"], seeds_by_split["val"], seeds_by_split["test"]
    overlap = (tr & va) | (tr & te) | (va & te)
    if overlap:
        raise RuntimeError(f"Seed leakage across splits detected: {sorted(overlap)[:10]}")

    return {
        "totalPositions": len(records),
        "splitPositions": split_counts,
        "splitUniqueSeeds": {k: len(v) for k, v in seeds_by_split.items()},
        "sourceCounts": source_counts,
        "sourceShares": {k: v / len(records) for k, v in sorted(source_counts.items())},
        "rescueCount": rescue_count,
        "rescueRate": rescue_count / len(records) if records else 0.0,
        "freshProbes": {
            "count": fresh_total,
            "agreesSelectedRate": fresh_sel_agree / fresh_total if fresh_total > 0 else None,
            "agreesRankZeroRate": fresh_rz_agree / fresh_total if fresh_total > 0 else None,
            "treeReuseDisagreementFloor": (
                1.0 - (fresh_sel_agree / fresh_total) if fresh_total > 0 else None
            ),
        },
    }


def run_single_representation_fit(
    records: list[dict[str, Any]],
    split_indices: dict[str, list[int]],
    fit_name: str,
    variant_key: str,
    dim: int,
    theta0: np.ndarray,
    tie_eps: float,
    out_dir: Path | None,
) -> dict[str, Any]:
    tr_idx = split_indices["train"]
    va_idx = split_indices["val"]
    te_idx = split_indices["test"]

    # 1. Pure preference fit (rescueApplied == false, rankZero target)
    tr_pref, tr_pref_scope = pack_choice_dataset(
        records, tr_idx, variant_key, dim, target_mode="rankZero", tie_eps=tie_eps, rescue_filter=False
    )
    va_pref, va_pref_scope = pack_choice_dataset(
        records, va_idx, variant_key, dim, target_mode="rankZero", tie_eps=tie_eps, rescue_filter=False
    )
    te_pref, te_pref_scope = pack_choice_dataset(
        records, te_idx, variant_key, dim, target_mode="rankZero", tie_eps=tie_eps, rescue_filter=False
    )

    pref_fit = fit_with_val_and_multistart(tr_pref, va_pref, va_pref_scope, theta0)
    theta_pref = np.array(pref_fit["bestTheta"], dtype=np.float64)
    tau_pref = float(pref_fit["bestTau"])

    # Also baseline s2-seed evaluation on same test split
    seed_te_pref = evaluate_packed_metrics(theta0, te_pref, tau=tau_pref, total_records_in_scope=te_pref_scope)
    fitted_tr_pref = evaluate_packed_metrics(theta_pref, tr_pref, tau=tau_pref, total_records_in_scope=tr_pref_scope)
    fitted_va_pref = evaluate_packed_metrics(theta_pref, va_pref, tau=tau_pref, total_records_in_scope=va_pref_scope)
    fitted_te_pref = evaluate_packed_metrics(theta_pref, te_pref, tau=tau_pref, total_records_in_scope=te_pref_scope)

    # All-decisions rank-zero eval (including rescued positions' rankZero)
    te_all_rz, te_all_rz_scope = pack_choice_dataset(
        records, te_idx, variant_key, dim, target_mode="rankZero", tie_eps=tie_eps, rescue_filter=None
    )
    seed_te_all_rz = evaluate_packed_metrics(theta0, te_all_rz, tau=tau_pref, total_records_in_scope=te_all_rz_scope)
    fitted_te_all_rz = evaluate_packed_metrics(theta_pref, te_all_rz, tau=tau_pref, total_records_in_scope=te_all_rz_scope)

    # 2. Separate survival fit on avoidable-death decisions
    tr_surv, tr_surv_scope = pack_survival_dataset(records, tr_idx, variant_key, dim)
    va_surv, va_surv_scope = pack_survival_dataset(records, va_idx, variant_key, dim)
    te_surv, te_surv_scope = pack_survival_dataset(records, te_idx, variant_key, dim)

    surv_fit = fit_with_val_and_multistart(
        tr_surv, va_surv, va_surv_scope, np.zeros(dim, dtype=np.float64)
    )
    theta_surv = np.array(surv_fit["bestTheta"], dtype=np.float64)
    tau_surv = float(surv_fit["bestTau"])
    surv_va_metrics = evaluate_packed_metrics(theta_surv, va_surv, tau=tau_surv, total_records_in_scope=va_surv_scope)
    surv_te_metrics = evaluate_packed_metrics(theta_surv, te_surv, tau=tau_surv, total_records_in_scope=te_surv_scope)

    # 3. Joint preference + survival composition on val -> test
    joint_te = evaluate_joint_survival_and_selection(
        theta_pref, theta_surv, records, te_idx, variant_key, dim, val_indices=va_idx
    )

    # 4. Plateaus & Stratification on test (and train+val+test beam coverage)
    ceilings_test = compute_ceiling_and_stratification(theta_pref, records, te_idx, variant_key, dim)
    ceilings_all = compute_ceiling_and_stratification(
        theta_pref, records, tr_idx + va_idx + te_idx, variant_key, dim
    )

    if out_dir is not None:
        out_dir.mkdir(parents=True, exist_ok=True)
        alpha = float(joint_te.get("chosenAlpha", 0.0))
        theta_joint = theta_pref + alpha * theta_surv
        weights_payload: dict[str, Any] = {
            "weightsId": fit_name,
            "discount": DEFAULT_DISCOUNT,
            "theta24": theta_pref[:BASE_DIM].tolist(),
            "thetaSurv24": theta_surv[:BASE_DIM].tolist(),
        }
        joint_payload: dict[str, Any] = {
            "weightsId": f"{fit_name}_joint",
            "discount": DEFAULT_DISCOUNT,
            "theta24": theta_joint[:BASE_DIM].tolist(),
        }
        if dim == TOTAL_DIM:
            weights_payload["theta10"] = theta_pref[BASE_DIM:TOTAL_DIM].tolist()
            weights_payload["theta34"] = theta_pref.tolist()
            weights_payload["thetaSurv34"] = theta_surv.tolist()
            joint_payload["theta10"] = theta_joint[BASE_DIM:TOTAL_DIM].tolist()
            joint_payload["theta34"] = theta_joint.tolist()
        (out_dir / f"{fit_name}.weights.json").write_text(json.dumps(weights_payload, indent=2))
        (out_dir / f"{fit_name}.joint.weights.json").write_text(json.dumps(joint_payload, indent=2))

    feature_names = ALL_FEATURE_NAMES[:dim]
    return {
        "fitName": fit_name,
        "variantKey": variant_key,
        "dim": dim,
        "hyperparams": {
            "prefTau": tau_pref,
            "prefLam": pref_fit["bestLam"],
            "survTau": tau_surv,
            "survLam": surv_fit["bestLam"],
        },
        "multistartPref": pref_fit["multistart"],
        "multistartSurv": surv_fit["multistart"],
        "purePreference_rescueFalse": {
            "train": fitted_tr_pref,
            "val": fitted_va_pref,
            "test": fitted_te_pref,
            "s2SeedTestBaseline": seed_te_pref,
        },
        "rankZeroAllDecisions_test": {
            "fitted": fitted_te_all_rz,
            "s2SeedBaseline": seed_te_all_rz,
        },
        "survivalAvoidableDeath": {
            "trainCount": tr_surv.n_decisions,
            "val": surv_va_metrics,
            "test": surv_te_metrics,
        },
        "jointSelection_test": joint_te,
        "plateausAndStratification_test": ceilings_test,
        "plateausOverall": {
            k: v for k, v in ceilings_all.items() if k != "stratification"
        },
        "weightsPrefByFeature": dict(zip(feature_names, theta_pref.tolist())),
        "weightsSurvByFeature": dict(zip(feature_names, theta_surv.tolist())),
    }


def load_records(paths: list[str]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for p in paths:
        with open(p, "r", encoding="utf-8") as fh:
            for line in fh:
                s = line.strip()
                if s:
                    records.append(json.loads(s))
    return records


def main() -> None:
    parser = argparse.ArgumentParser(description="Canonical §D S2 Imitation Pipeline Fitter")
    parser.add_argument("--input", nargs="+", required=True, help="Annotated DecisionRecord JSONL file(s)")
    parser.add_argument("--out-dir", required=True, help="Directory for weight exports & fit report JSON")
    parser.add_argument("--tie-eps", type=float, default=0.02, help="RootChild value margin for near-equivalent A*_s")
    parser.add_argument(
        "--fits",
        default="existing,corrected,corrected_augmented",
        help="Comma-separated list of fits to run",
    )
    parser.add_argument("--tag", default="pass1", help="Tag prefix (e.g. pass1 or pass2_regen)")
    args = parser.parse_args()

    records = load_records(args.input)
    dataset_summary = summarize_dataset(records)

    split_indices: dict[str, list[int]] = {"train": [], "val": [], "test": []}
    for i, rec in enumerate(records):
        split_indices[str(rec["split"])].append(i)

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    requested_fits = [s.strip() for s in args.fits.split(",") if s.strip()]

    results: dict[str, Any] = {
        "schema": "attax-s2-imitation-fit-report/1",
        "tag": args.tag,
        "tieEps": args.tie_eps,
        "datasetSummary": dataset_summary,
        "fits": {},
    }

    if "existing" in requested_fits:
        results["fits"]["fit1_existing"] = run_single_representation_fit(
            records,
            split_indices,
            f"{args.tag}_fit1_existing",
            "existing",
            BASE_DIM,
            S2_SEED_VEC24,
            args.tie_eps,
            out_dir,
        )

    if "corrected" in requested_fits:
        results["fits"]["fit2_corrected"] = run_single_representation_fit(
            records,
            split_indices,
            f"{args.tag}_fit2_corrected",
            "corrected",
            BASE_DIM,
            S2_SEED_VEC24,
            args.tie_eps,
            out_dir,
        )

    if "corrected_augmented" in requested_fits:
        results["fits"]["fit3_corrected_augmented"] = run_single_representation_fit(
            records,
            split_indices,
            f"{args.tag}_fit3_corrected_augmented",
            "corrected",
            TOTAL_DIM,
            S2_SEED_VEC34,
            args.tie_eps,
            out_dir,
        )

    report_path = out_dir / f"{args.tag}_fit_report.json"
    report_path.write_text(json.dumps(results, indent=2))

    # Print concise quantitative table to stdout
    print(f"=== S2 Imitation Fit Report ({args.tag}) -> {report_path} ===")
    print(f"Positions: {dataset_summary['totalPositions']} | Splits: {dataset_summary['splitPositions']} | Seeds: {dataset_summary['splitUniqueSeeds']}")
    print(f"Sources: {dataset_summary['sourceCounts']}")
    print(f"Rescue rate: {dataset_summary['rescueRate']:.4f} | Fresh probes: {dataset_summary['freshProbes']}")
    for fname, fdata in results["fits"].items():
        pref_te = fdata["purePreference_rescueFalse"]["test"]
        base_te = fdata["purePreference_rescueFalse"]["s2SeedTestBaseline"]
        surv_te = fdata["survivalAvoidableDeath"]["test"]
        joint_te = fdata["jointSelection_test"]
        plat = fdata["plateausOverall"]
        print(
            f"\n[{fname}] dim={fdata['dim']} tau={fdata['hyperparams']['prefTau']} lam={fdata['hyperparams']['prefLam']} | "
            f"movegen_cov_rz={plat['rankZeroInMovegenRate']:.4f} beam_cov_rz={plat['rankZeroSurvivedBeamRate']:.4f} "
            f"mean_prune_depth={plat['rankZeroPruningDepthMean']:.2f}"
        )
        print(
            f"  Pure pref test (rescue=false): top1_expr={pref_te['strictTop1Expressible']} top1_full={pref_te['strictTop1FullScope']} "
            f"set_top1={pref_te['setTop1Expressible']} top3={pref_te['top3Expressible']} nll={pref_te['strictNll']} "
            f"(seed baseline top1_expr={base_te['strictTop1Expressible']}, nll={base_te['strictNll']})"
        )
        print(
            f"  Survival head test (n={surv_te['expressibleCount']}/{surv_te['scopeCount']}): safe_hit={surv_te['setTop1Expressible']} | "
            f"Joint alpha={joint_te['chosenAlpha']} rescue=true sel_top1={joint_te['jointBlend_rescueTrue']['selectedTop1Expressible']}"
        )


if __name__ == "__main__":
    main()
