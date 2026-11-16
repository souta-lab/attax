#!/usr/bin/env python3
"""Unit tests for tools/s2-lab/imitation/fit.py."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fit  # noqa: E402


class TestImitationFit(unittest.TestCase):
    def test_set_ranking_analytic_gradient_matches_finite_difference(self) -> None:
        rng = np.random.default_rng(42)
        counts = np.array([4, 3, 5, 2], dtype=np.int64)
        total_cands = int(np.sum(counts))
        dim = 8
        phi = rng.normal(0.0, 1.5, size=(total_cands, dim))
        pos_mask = np.zeros(total_cands, dtype=bool)
        strict_mask = np.zeros(total_cands, dtype=bool)
        offset = 0
        for i, k in enumerate(counts):
            pos_mask[offset] = True
            strict_mask[offset] = True
            if i == 0:
                pos_mask[offset + 1] = True  # multi-positive set A*_s
            offset += int(k)

        packed = fit.PackedDecisions(
            phi=phi,
            counts=counts,
            pos_mask=pos_mask,
            strict_pos_mask=strict_mask,
            weights=np.array([1.0, 2.0, 0.5, 1.5]),
            cand_action_indices=np.arange(total_cands, dtype=np.int64),
            target_action_indices=np.zeros(len(counts), dtype=np.int64),
            record_indices=np.arange(len(counts), dtype=np.int64),
        )
        theta = rng.normal(0.0, 0.5, size=dim)
        theta0 = rng.normal(0.0, 0.2, size=dim)
        tau = 1.7
        lam = 0.03

        loss, grad = fit.set_ranking_loss_and_grad(theta, packed, tau=tau, theta0=theta0, lam=lam)
        eps = 1e-6
        fd = np.zeros(dim, dtype=np.float64)
        for j in range(dim):
            tp = theta.copy()
            tm = theta.copy()
            tp[j] += eps
            tm[j] -= eps
            lp, _ = fit.set_ranking_loss_and_grad(tp, packed, tau=tau, theta0=theta0, lam=lam)
            lm, _ = fit.set_ranking_loss_and_grad(tm, packed, tau=tau, theta0=theta0, lam=lam)
            fd[j] = (lp - lm) / (2.0 * eps)

        max_err = float(np.max(np.abs(grad - fd)))
        self.assertLess(max_err, 1e-7)
        self.assertGreater(loss, 0.0)

    def test_synthetic_policy_recovery_and_rescue_separation(self) -> None:
        rng = np.random.default_rng(123)
        dim = fit.BASE_DIM
        true_pref = rng.normal(0.0, 1.0, size=dim)
        # Positive survival feature weight at index 0 (board.maxHeight = negative prefers low, positive tests linear recovery)
        records: list[dict] = []

        # Create whole-seed split records with 24 train seeds, 6 val seeds, 6 test seeds
        splits = ["train"] * 24 + ["val"] * 6 + ["test"] * 6
        for s_idx, sp in enumerate(splits):
            seed = 900_000 + s_idx
            for ply in range(1, 5):
                k = 5
                phi34 = rng.normal(0.0, 1.0, size=(k, fit.TOTAL_DIM))
                is_rescue = (ply == 4)
                if not is_rescue:
                    scores = phi34[:, :dim] @ true_pref
                    rz = int(np.argmax(scores))
                    sel = rz
                    fatal_flags = [False] * k
                    min_solv = [3] * k
                else:
                    # Make candidate 0 non-fatal best pref (Wait: rank0 fatal, candidate 2 safe!)
                    scores = phi34[:, :dim] @ true_pref
                    rz = int(np.argmax(scores))
                    fatal_flags = [i == rz for i in range(k)]
                    min_solv = [-4 if i == rz else 2 for i in range(k)]
                    # Pick best among safe as selected
                    safe_cands = [i for i in range(k) if not fatal_flags[i]]
                    sel = max(safe_cands, key=lambda i: float(scores[i]))

                legal_actions = []
                cands = []
                for j in range(k):
                    legal_actions.append(
                        {
                            "actionIndex": j,
                            "semanticKey": f"T:0:none:{j}",
                            "cellKey": f"T:0:{j}",
                            "piece": "T",
                            "usedHold": False,
                            "reachableWithout180": True,
                            "witnesses": [],
                            "referee": {
                                "lines": 0,
                                "spin": "none",
                                "comboAfter": 0,
                                "b2bAfter": 0,
                                "cancelledRows": 0,
                                "tankRows": 0,
                                "remainingRows": 0,
                                "outgoingBeforeCancel": 0,
                                "outgoingAfterCancel": 0,
                                "surgeSent": 0,
                                "occupiedHeightAfterLock": 6,
                                "visibleMarginAfterLock": 14,
                                "solvency": min_solv[j],
                                "amountToppedOut": fatal_flags[j],
                                "solvent": not fatal_flags[j],
                            },
                        }
                    )
                    cands.append(
                        {
                            "actionIndex": j,
                            "semanticKey": f"T:0:none:{j}",
                            "inMovegen": True,
                            "survivedBeam": True,
                            "pruningDepth": 14,
                            "fatalAtRoot": fatal_flags[j],
                            "fatalOnBestPath": fatal_flags[j],
                            "rootSolvencyMargin": min_solv[j],
                            "minSolvencyMargin": min_solv[j],
                            "beamValue": float(phi34[j, :dim] @ true_pref),
                            "completeValue": float(phi34[j, :dim] @ true_pref),
                            "stepCount": 14,
                            "phi34": phi34[j].tolist(),
                        }
                    )

                records.append(
                    {
                        "schema": "attax-s2-imitation/1",
                        "recordId": f"test:{seed}:{ply}",
                        "source": "champion_selfplay",
                        "gameId": f"g-{seed}",
                        "seed": seed,
                        "split": sp,
                        "ply": ply,
                        "actorSeat": "left",
                        "actorBot": "cc2-s2-champion",
                        "opponentBot": "cc2-s2-champion",
                        "tacticalTag": None,
                        "observation": {},
                        "legalActions": legal_actions,
                        "teacher": {
                            "botId": "cc2-s2-champion",
                            "profileId": "test",
                            "configHash": "test",
                            "sessionMode": "persistent",
                            "reuse": None,
                            "selectedActionIndex": sel,
                            "selectedSemanticKey": f"T:0:none:{sel}",
                            "selectedInAllow180False": True,
                            "rankZeroActionIndex": rz,
                            "rankZeroSemanticKey": f"T:0:none:{rz}",
                            "rescueApplied": is_rescue,
                            "rootValueTop1": 0.5,
                            "rootValueMargin12": 0.1,
                            "selectionMargin12": 0.1,
                            "ranked": [],
                            "rootChildren": [],
                        },
                        "freshTeacher": None,
                        "freshAgreement": None,
                        "stratification": {
                            "maxHeightRoot": 6,
                            "heightBucket": "0-8",
                            "pendingRows": 0,
                            "dueThisLockRows": 0,
                            "hasPressure": False,
                            "b2b": 0,
                            "b2bBucket": "0",
                            "combo": 0,
                            "activeRen": False,
                            "nonTSpinClearOpportunity": False,
                            "nonTSpinAnyOpportunity": False,
                            "rescueActivated": is_rescue,
                            "hasAvoidableDeath": is_rescue,
                            "releaseVsCharge": "none",
                        },
                        "annotations": {
                            "corrected": {
                                "weightsId": "s2-seed",
                                "width": 48,
                                "depth": 14,
                                "nodes": 500,
                                "bestActionIndex": 0,
                                "teacherSelectedInMovegen": True,
                                "teacherSelectedSurvivedBeam": True,
                                "teacherSelectedPruningDepth": 14,
                                "teacherRankZeroInMovegen": True,
                                "teacherRankZeroSurvivedBeam": True,
                                "teacherRankZeroPruningDepth": 14,
                                "candidates": cands,
                            }
                        },
                    }
                )

        summary = fit.summarize_dataset(records)
        self.assertEqual(summary["totalPositions"], 144)
        self.assertAlmostEqual(summary["rescueRate"], 0.25)

        split_idx = {"train": [], "val": [], "test": []}
        for i, r in enumerate(records):
            split_idx[r["split"]].append(i)

        with tempfile.TemporaryDirectory() as td:
            res = fit.run_single_representation_fit(
                records,
                split_idx,
                "synth_fit",
                "corrected",
                fit.BASE_DIM,
                np.zeros(fit.BASE_DIM, dtype=np.float64),
                tie_eps=0.0,
                out_dir=Path(td),
            )
            te_acc = res["purePreference_rescueFalse"]["test"]["strictTop1Expressible"]
            self.assertGreater(te_acc, 0.85)
            self.assertLess(res["multistartPref"]["nllSpread"], 1e-3)
            self.assertTrue((Path(td) / "synth_fit.weights.json").exists())

    def test_seed_leakage_raises_error(self) -> None:
        bad_records = [
            {"seed": 1001, "split": "train", "source": "champion_selfplay", "teacher": {}, "freshAgreement": None},
            {"seed": 1001, "split": "test", "source": "champion_selfplay", "teacher": {}, "freshAgreement": None},
        ]
        with self.assertRaises(RuntimeError):
            fit.summarize_dataset(bad_records)


if __name__ == "__main__":
    unittest.main()
