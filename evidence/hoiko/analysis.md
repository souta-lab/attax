# Hoiko reverse engineering (Hoiko_PPT_v0-beta1)

Source: Discord attachment Hoiko_PPT_v0-beta1.7z (2026-09-10), persisted at /home/s0u7a/hoiko/.
Hashes: evidence/hoiko/hashes.txt.

## What it is
- Windows app for Puyo Puyo Tetris (PPT / PPT2, Steam). Drives a virtual gamepad (ScpDriverInterface.dll) and reads game process memory (classes Memory / Memory2: GetCombo, GetComingGarbage, GetOverheadGarbage, GetIsTetris, GetStartAnimation, GetCharSelectState, ...).
- Modes: Sprint, Ultra, VS. No online; solo disabled in PPT2.
- Native C++ core inside a .NET (mixed-mode) PE; MSVC symbols present (486 unique), so no clean IL decompile — the class/method inventory is recoverable:
  - EvaluateAI: GetResource, SearchPcBoard, SearchTst, SearchDTCannon, TransitionWeight; statics isEvenBoard, multiEvaluation, opponentIsPCBoard, opponentIsPowerfulBoard, opponentsCombo, playStyle, trustRate, useS4W, weight/weightList.
  - SearchAI: OpSearch, MultiEvaluator (ThreadStart, IsEvaluating); statics beamSizeLimit, maxBeamSize, minDepth, threadCount, isSearching, tree, timer.
  - TemplateAI: SearchTDOpeners; statics useTDOpeners, loopTemplate, opType, opDropCount, prevOpDropCount, failTDOpeners, useTemplate, useDPC.
  - Other: PPTAI/PPT2AI, TetrizAI, OffsetOffAI, ExpandAI, ConfigAI, PPTMain/TetrizMain, Xbox (pad).
- Default VS config (config.dll): viewNext=2, useHold=true, beamSize=50, minDepth=10, threadCount=1, speed=25, useTDOpeners=false, playStyle=0.

## Evaluation weights (complete; evidence/hoiko/weights/*.txt)
Keys: maxHeight, over10, over15, updown2, donateCover, cover, roof, badRoof, pierce, anabara, wellHint/wellDepth/wellPeak, column[10], pcStack, pcChance, resource/resourceMax, tsdHole/tsdSpinable/tsdClearable/tsdOffensive, tstHole/tstSpinable/tstClearable/tstHint/tstOffensive, tdHole/tdHint, moveDelay, holdI/holdT, wasteI/wasteT, single/double/triple/quad, tss/tsd/tst, btb, pc, comboBtb, comboAtk[5], comboDebt, nexus.
Presets: we/wo/wd/wr (VS play styles; default playStyle 0 -> "we"), ultra1/ultra2 (Ultra), sprint (Sprint).
Default VS preset "we": single -350, double -300, triple -250, quad +200; tss 50 / tsd 300 / tst 500; btb 50; pc 1500; comboAtk 180/360/540/900/1080; comboDebt 250; maxHeight -15 / over10 -30 / over15 -100; pierce -120; anabara -70; column [-50,-70,-10,0,0,0,0,-10,-70,-50]; wasteI -100 / wasteT -100; holdI 10 / holdT 10; resource 2 / resourceMax 30; pcStack 30; pcChance 1000; tdHole 60 / tdHint 20.

## Strategic read
- Hoiko is a Tetris / T-spin / Perfect-Clear archetype: it heavily penalizes small clears and hoards for quads (+200), T-spins (tsd 300 / tst 500) and PCs (+1500), with strong board-shape penalties and combo management (comboAtk, comboDebt).
- Weak spots to exploit: default viewNext=2 (shallow visible queue), combo debt (breaking its combo is costly to it), TD openers disabled by default, and its single-line aversion (it may die rather than clear a single when its weights dominate).
- Counter-directions: out-tempo it; force garbage during its quad/PC/TD setup; bait combo breaks; build a low, clean board to survive its bursts and out-last it.

## Plan
1. Implement a Hoiko replica fighter (src/ai/hoiko.ts): parse the weight files, compute the feature set from the afterstate board, reuse our beam search (beamSize 50, minDepth ~10, hold on), expose as a VersusFighter.
2. scripts/hoiko-gate.ts: head-to-head our fighter vs the Hoiko replica over the fixed corpus.
3. Measure current BLUE/RED vs Hoiko; then iterate to beat it (V10+). Replica is a proxy — final validation must be the real Hoiko in PPT.
