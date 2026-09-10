# V9 Verdict — CHECKPOINT (not sealed)

## Formal gate (scripts/gate.ts, 6 shards, fixed 32 seeds, maxTicks 12000)
- S2 sanity (frozen BLUE v8 vs frozen RED v8): 8 / 19 / 5 caps; per-shard leftWins [1,3,0,0,2,2] — reproduces the V8 corpus exactly; zero execution failures.
- S1 (live BLUE v9 vs frozen RED v8): 11 / 15 / 6 caps; BLUE tetris 23 (v8: 10); zero execution failures.
- S3 (live BLUE v9 vs live RED v9): 11 / 17 / 4 caps; zero execution failures.
- Render: evidence/v9/render-seed1-7.log (seed1 BLUE KO loss; seed7 BLUE KO win, tetris 3, maxH 12).

## Changes
- BLUE: NEW src/ai/blueV9-score.ts (permissive dig veto blueV9Veto/blueV9Hopeless) + fighterA knobs: EXECUTE_BONUS 420->200, BLUE_WEIGHTS.maxHeight -3.6->-6.0, TSLOT_KEEP2 42->30, ATK_W 142->170.
- RED: fighterB late-REN (renStep 110 once pieces >= 250) + NEW src/ai/redV9-score.ts v9SpawnPressure (centre spawn columns 3-6).
- Shared files byte-identical to freeze/v8 (verified); beam.ts/blueV8-score.ts/redV8-score.ts untouched.

## Oracle audit (bg_8919863d) — DO NOT SEAL
- The +3 left wins is within 32-seed noise (paired sign p ≈ 0.55); S1 caps 5->6 violates the pre-registered "no cap increase" => the gate is a technical FAIL.
- Only the permissive dig veto is clearly principled and stall-safe (controller drops a null move; no hang). The weight bundle (esp. maxHeight -6.0) and RED's blanket spawn-pressure are unproven band-aids — RED's +2 came entirely from converting 2 caps while sent fell 1626->1511 and holes rose 354->378.
- Missing at audit time: V9 render (now saved) and any v9 unit tests.
- Asymmetries untouched: BLUE emergency pending>=5 vs RED >=4 (frozen files); BLUE's neutral 30-piece opening; BLUE beam 24/16 vs RED 32/20.

## Disposition
- V9 = checkpoint. Keep freeze/v8 as the official control. Carry `blueV9Veto` forward as the one keeper; re-litigate the weight bundle and RED's spawn term in V10.
- V10 plan (from Oracle): single focused BLUE Tetris-conversion overhaul (committed edge-well + reserved-I + execute/float rewards; remove the FILL_PEN asymmetry; fold the opening into the personality scorer) plus a shared footprint-based top-out term; stronger protocol (add S4 live-RED-vs-frozen-BLUE, >=128 seeds, paired significance, mandatory render, unit tests).
- MAJOR PIVOT: Hoiko (the real target) was obtained and reverse-engineered — see evidence/hoiko/. Upcoming versions are gated against a Hoiko replica for a direct "beat Hoiko" objective.

## Evidence
- evidence/v9/gate-{0..5}.log, gate-aggregate.json
- evidence/v9/render-seed1-7.log
- evidence/v9/blue-iterations.log, red-iterations.log
- evidence/hoiko/ (Hoiko RE: weights, readmes, hashes, analysis)
