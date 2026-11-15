/**
 * Canonical §D imitation dataset generator.
 *
 * Generates whole-game / whole-seed DecisionRecord JSONL streams across §D's four sources:
 *   - 40% attax_vs_champion            (existing attax s2-seed vs persistent champion)
 *   - 30% champion_selfplay / historical (20% champion self-play + 10% vs historical F14)
 *   - 20% corrected_attax_vs_champion  (corrected S2 attax vs persistent champion)
 *   - 10% targeted_tactical            (6-archetype stressed boards + champion rollouts)
 */

import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Placement } from "../../../src/ai/bot/movegen.js";
import type { Weights } from "../../../src/ai/bot/weights.js";
import type { PieceKind } from "../../../src/core/pieces.js";
import { cellKey, placementCells } from "../attax-player.js";
import { applyTransition, controller, fullStateKey, lab } from "../lab.mjs";
import {
  type AnnotatableVariant,
  annotateDecisionRecord,
  loadWeightSpec,
} from "./annotate-dataset.js";
import { runVariantSearch, semanticActionKey } from "./s2-variants.js";
import type { DatasetSource, DecisionRecord, LegalActionEntry, TeacherLabel } from "./schema.js";
import { createTacticalScenario, TACTICAL_ARCHETYPES } from "./tactical-scenarios.js";
import {
  assembleDecisionRecord,
  buildLegalActions,
  type CanonicalState,
  type ChampionResolvedResult,
  type ChampionTransitionResult,
  canonicalToGuiState,
  type LegalActionsBuildResult,
  publicObservationFromState,
  searchInputFromObservation,
  TeacherOracle,
} from "./teacher-oracle.js";

const { createGame, extendSeededQueue, toS2GuiState } = await lab("cc2-gui/game.mjs");
const { guiStateToCanonical } = await lab("src-js/gui-state.mjs");
const { matchOutcome } = await lab("src-js/bot-match-options.mjs");

export const SOURCE_SEED_OFFSETS: Readonly<Record<DatasetSource, number>> = {
  attax_vs_champion: 100_000,
  champion_selfplay: 200_000,
  champion_vs_historical: 250_000,
  corrected_attax_vs_champion: 300_000,
  targeted_tactical: 400_000,
};

export const DEFAULT_SOURCE_QUOTAS: Readonly<Record<DatasetSource, number>> = {
  attax_vs_champion: 0.4,
  champion_selfplay: 0.2,
  champion_vs_historical: 0.1,
  corrected_attax_vs_champion: 0.2,
  targeted_tactical: 0.1,
};

export const HISTORICAL_BOT_TYPES = [
  "cc2-s2-champion-spsa-v10",
  "cc2-s2-champion-spsa-v7",
  "cc2-s2-champion-tree-reuse",
] as const;

export interface GeneratorConfig {
  readonly outputPath: string;
  readonly targetPositions: number;
  readonly quotas?: Readonly<Record<DatasetSource, number>>;
  readonly maxTurnsPerMatch?: number;
  readonly pps?: number;
  readonly freshEveryPlies?: number;
  readonly annotateVariants?: readonly AnnotatableVariant[];
  readonly shardIndex?: number;
  readonly shardCount?: number;
  readonly seedStride?: number;
  readonly weightsPath?: string;
  readonly width?: number;
}

interface MatchBotEntry {
  readonly id: string;
  state: CanonicalState;
}

interface MatchSnapshot {
  readonly bots: MatchBotEntry[];
  readonly turnNumber: number;
}

interface MatchSubmission {
  readonly botId: string;
  readonly positionFingerprint: string;
  readonly result: ChampionResolvedResult | { readonly transition: ChampionTransitionResult };
}

function deriveBotSeed(matchSeed: number, offset: number): number {
  return (Math.imul(matchSeed ^ 0x9e3779b9, 0x85ebca6b) + offset) >>> 0;
}

function makeInitialCanonicalBotState(seed: number): {
  state: CanonicalState;
  bagSeed: number;
} {
  const g = createGame(seed);
  const ext = extendSeededQueue([g.queue[0], ...g.queue.slice(1)], g.bagSeed, 24);
  g.queue = ext.queue;
  g.bagSeed = ext.bagSeed;
  return {
    state: guiStateToCanonical(toS2GuiState(g)) as CanonicalState,
    bagSeed: ext.bagSeed as number,
  };
}

function hasVisibleOverflow(state: CanonicalState): boolean {
  const cells = state?.board?.cells;
  return typeof cells === "string" && /[^_]/.test(cells.slice(200));
}

function pickWitnessPlacementForAttax(
  legal: LegalActionsBuildResult,
  entry: LegalActionEntry,
): Record<string, unknown> {
  const w =
    entry.referee.spin !== "none"
      ? (entry.witnesses.find((wit) => wit.rotationEvidence.lastInputWasRotation) ??
        entry.witnesses[0])
      : (entry.witnesses.find((wit) => !wit.rotationEvidence.lastInputWasRotation) ??
        entry.witnesses[0]);
  if (!w) {
    throw new Error(`No witness found for semantic legal action ${entry.semanticKey}`);
  }
  void legal;
  return {
    piece: entry.piece,
    rotation: w.rotation,
    x: w.x,
    y: w.y,
    usedHold: entry.usedHold,
    rotationEvidence: {
      lastInputWasRotation: w.rotationEvidence.lastInputWasRotation,
      kickIndex: w.rotationEvidence.kickIndex,
      kickId: w.rotationEvidence.kickId,
      kickOffset: w.rotationEvidence.kickOffset ? [...w.rotationEvidence.kickOffset] : null,
    },
  };
}

function selectAttaxSubmission(args: {
  readonly canonicalState: CanonicalState;
  readonly legal: LegalActionsBuildResult;
  readonly variant: "existing" | "corrected";
  readonly weights: Weights;
  readonly width: number;
}): { transition: ChampionTransitionResult; placement: Record<string, unknown> } {
  const { canonicalState, legal, variant, weights, width } = args;
  const no180Entries = legal.legalActions.filter((a) => a.reachableWithout180);
  const no180Semantic = new Set(no180Entries.map((a) => a.semanticKey));
  const no180Cells = new Set(no180Entries.map((a) => a.cellKey));

  const input = {
    ...searchInputFromObservation(publicObservationFromState(canonicalState)),
    acceptRoot: (placement: Placement, usedHold: boolean): boolean => {
      const sKey = semanticActionKey(placement, usedHold, placement.tspin);
      if (no180Semantic.has(sKey)) return true;
      const cKey = `${placement.kind}:${usedHold ? 1 : 0}:${cellKey(placementCells(placement))}`;
      return no180Cells.has(cKey);
    },
  };

  const report = runVariantSearch(input, variant, {
    weights,
    width,
    completePrunedRoots: false,
  });

  let chosenEntry: LegalActionEntry | undefined;
  const best = report.searchResult?.best;
  if (best) {
    const sKey = semanticActionKey(best.placement, best.usedHold, best.placement.tspin);
    chosenEntry = no180Entries.find((a) => a.semanticKey === sKey);
    if (!chosenEntry) {
      const cKey = `${best.placement.kind}:${best.usedHold ? 1 : 0}:${cellKey(placementCells(best.placement))}`;
      chosenEntry = no180Entries.find((a) => a.cellKey === cKey);
    }
  }
  if (!chosenEntry) {
    chosenEntry = no180Entries[0] ?? legal.legalActions[0];
  }
  if (!chosenEntry) {
    throw new Error("Attax has no legal placements on non-topped-out board");
  }
  const placement = pickWitnessPlacementForAttax(legal, chosenEntry);
  const transition = applyTransition(
    canonicalState,
    { kind: "placement", placement },
    canonicalState.rulesetId,
  ) as ChampionTransitionResult;
  if (transition.legality?.legal !== true || transition.nextState === null) {
    throw new Error(
      `Attax selected illegal referee placement ${chosenEntry.semanticKey}: ${transition.legality?.reason ?? "unknown"}`,
    );
  }
  return { transition, placement };
}

type SeatDriver =
  | { kind: "champion"; botType: string; oracle: TeacherOracle; logMoves: boolean }
  | { kind: "attax"; variant: "existing" | "corrected"; profileId: string };

export async function playAndLogMatch(args: {
  readonly source: Exclude<DatasetSource, "targeted_tactical">;
  readonly seed: number;
  readonly pps: number;
  readonly maxTurns: number;
  readonly freshEveryPlies: number;
  readonly championOracleLeft: TeacherOracle;
  readonly championOracleRight: TeacherOracle;
  readonly historicalOracles: Map<string, TeacherOracle>;
  readonly weights: Weights;
  readonly width: number;
  readonly annotateVariants: readonly AnnotatableVariant[];
  readonly weightSpec: ReturnType<typeof loadWeightSpec>;
}): Promise<{
  readonly records: DecisionRecord[];
  readonly winnerSeat: string | null;
  readonly endReason: string;
  readonly turns: number;
}> {
  const {
    source,
    seed,
    pps,
    maxTurns,
    freshEveryPlies,
    championOracleLeft,
    championOracleRight,
    historicalOracles,
    weights,
    width,
    annotateVariants,
    weightSpec,
  } = args;

  await championOracleLeft.resetPersistentTree();
  await championOracleRight.resetPersistentTree();
  for (const h of historicalOracles.values()) {
    await h.resetPersistentTree();
  }

  const gameId = `${source}-s${seed}`;
  const initLeft = makeInitialCanonicalBotState(deriveBotSeed(seed, 1));
  const initRight = makeInitialCanonicalBotState(deriveBotSeed(seed, 2));
  const bagSeeds: Record<string, number> = {
    left: initLeft.bagSeed,
    right: initRight.bagSeed,
  };

  let leftDriver: SeatDriver;
  let rightDriver: SeatDriver;

  if (source === "attax_vs_champion" || source === "corrected_attax_vs_champion") {
    const variant = source === "attax_vs_champion" ? "existing" : "corrected";
    const profileId = variant === "existing" ? "attax-s2-seed" : "attax-s2-corrected";
    const champFirst = seed % 2 === 1;
    if (champFirst) {
      leftDriver = {
        kind: "champion",
        botType: "cc2-s2-champion",
        oracle: championOracleLeft,
        logMoves: true,
      };
      rightDriver = { kind: "attax", variant, profileId };
    } else {
      leftDriver = { kind: "attax", variant, profileId };
      rightDriver = {
        kind: "champion",
        botType: "cc2-s2-champion",
        oracle: championOracleRight,
        logMoves: true,
      };
    }
  } else if (source === "champion_selfplay") {
    leftDriver = {
      kind: "champion",
      botType: "cc2-s2-champion",
      oracle: championOracleLeft,
      logMoves: true,
    };
    rightDriver = {
      kind: "champion",
      botType: "cc2-s2-champion",
      oracle: championOracleRight,
      logMoves: true,
    };
  } else {
    const histIdx = seed % HISTORICAL_BOT_TYPES.length;
    const histType = HISTORICAL_BOT_TYPES[histIdx] as string;
    const histOracle = historicalOracles.get(histType);
    if (!histOracle) throw new Error(`Missing historical oracle for ${histType}`);
    const champIsLeft = seed % 2 === 0;
    if (champIsLeft) {
      leftDriver = {
        kind: "champion",
        botType: "cc2-s2-champion",
        oracle: championOracleLeft,
        logMoves: true,
      };
      rightDriver = { kind: "champion", botType: histType, oracle: histOracle, logMoves: false };
    } else {
      leftDriver = { kind: "champion", botType: histType, oracle: histOracle, logMoves: false };
      rightDriver = {
        kind: "champion",
        botType: "cc2-s2-champion",
        oracle: championOracleRight,
        logMoves: true,
      };
    }
  }

  const drivers: Record<string, SeatDriver> = { left: leftDriver, right: rightDriver };

  let match = controller.createBotMatch({
    bots: [
      { id: "left", state: initLeft.state },
      { id: "right", state: initRight.state },
    ],
    mode: "paced",
    ppsByBotId: { left: pps, right: pps },
    garbageDelayFrames: 0,
  }) as MatchSnapshot;

  const lastTankTopout: Record<string, boolean> = { left: false, right: false };
  const records: DecisionRecord[] = [];
  let plyCounter = 0;

  while (true) {
    for (const bot of match.bots) {
      if (bot.state.pieces.known.length < 18) {
        const ext = extendSeededQueue(
          [bot.state.pieces.current, ...bot.state.pieces.known],
          bagSeeds[bot.id] as number,
          28,
        );
        bagSeeds[bot.id] = ext.bagSeed as number;
        bot.state = {
          ...bot.state,
          pieces: { ...bot.state.pieces, known: ext.queue.slice(1) as PieceKind[] },
        };
      }
    }

    const preOutcome = matchOutcome(
      match.bots.map((b) => ({
        id: b.id,
        toppedOut: Boolean(lastTankTopout[b.id]) || hasVisibleOverflow(b.state),
      })),
      match.turnNumber,
      maxTurns,
    );
    if (preOutcome.complete) {
      return {
        records,
        winnerSeat: (preOutcome.winnerBotId as string | null) ?? null,
        endReason: String(preOutcome.reason ?? "complete"),
        turns: match.turnNumber,
      };
    }

    const due = controller.botMatchNextStep(match);
    const submissions: MatchSubmission[] = [];
    let abortedNoLegalMove: { reason: string; losingSeat: string } | null = null;

    for (const side of due.botIds as string[]) {
      const bot = match.bots.find((b) => b.id === side);
      if (!bot) continue;
      const otherSide = side === "left" ? "right" : "left";
      const driver = drivers[side] as SeatDriver;
      const otherDriver = drivers[otherSide] as SeatDriver;
      const gui = controller.botMatchToGuiState(match, side) as Record<string, unknown>;
      const legal = buildLegalActions(bot.state);

      if (legal.legalActions.length === 0) {
        abortedNoLegalMove = { reason: "no-legal-placements", losingSeat: side };
        break;
      }

      if (driver.kind === "champion") {
        const evalRes = await driver.oracle.decidePersistent(bot.state, legal, gui);
        if (!evalRes.ok) {
          abortedNoLegalMove = { reason: evalRes.status, losingSeat: side };
          break;
        }
        if (driver.logMoves) {
          plyCounter += 1;
          let freshLabel: TeacherLabel | null = null;
          if (freshEveryPlies > 0 && (plyCounter === 1 || plyCounter % freshEveryPlies === 0)) {
            const freshRes = await championOracleLeft.decideFresh(bot.state, legal, gui);
            if (freshRes.ok) freshLabel = freshRes.label;
          }
          let rec = assembleDecisionRecord({
            source,
            gameId,
            seed,
            ply: plyCounter,
            actorSeat: side,
            actorBot: driver.botType,
            opponentBot:
              otherDriver.kind === "champion" ? otherDriver.botType : otherDriver.profileId,
            tacticalTag: null,
            canonicalState: bot.state,
            legal,
            teacher: evalRes.label,
            freshTeacher: freshLabel,
          });
          if (annotateVariants.length > 0) {
            rec = annotateDecisionRecord(rec, {
              variants: annotateVariants,
              weightSpec,
              width,
            });
          }
          records.push(rec);
        }
        if (evalRes.resolved.transition.tankResult?.toppedOut) {
          lastTankTopout[side] = true;
        }
        submissions.push({
          botId: side,
          positionFingerprint: fullStateKey(bot.state) as string,
          result: evalRes.resolved,
        });
      } else {
        const no180Count = legal.legalActions.filter((a) => a.reachableWithout180).length;
        if (no180Count === 0) {
          abortedNoLegalMove = { reason: "no-legal-no180-placements", losingSeat: side };
          break;
        }
        const attaxMove = selectAttaxSubmission({
          canonicalState: bot.state,
          legal,
          variant: driver.variant,
          weights,
          width,
        });
        plyCounter += 1;
        const teacherRes = await championOracleLeft.decideFresh(bot.state, legal, gui);
        if (teacherRes.ok) {
          let rec = assembleDecisionRecord({
            source,
            gameId,
            seed,
            ply: plyCounter,
            actorSeat: side,
            actorBot: driver.profileId,
            opponentBot: "cc2-s2-champion",
            tacticalTag: null,
            canonicalState: bot.state,
            legal,
            teacher: teacherRes.label,
            freshTeacher: null,
          });
          if (annotateVariants.length > 0) {
            rec = annotateDecisionRecord(rec, {
              variants: annotateVariants,
              weightSpec,
              width,
            });
          }
          records.push(rec);
        }
        if (attaxMove.transition.tankResult?.toppedOut) {
          lastTankTopout[side] = true;
        }
        submissions.push({
          botId: side,
          positionFingerprint: fullStateKey(bot.state) as string,
          result: { transition: attaxMove.transition },
        });
      }
    }

    if (abortedNoLegalMove !== null) {
      return {
        records,
        winnerSeat: abortedNoLegalMove.losingSeat === "left" ? "right" : "left",
        endReason: abortedNoLegalMove.reason,
        turns: match.turnNumber,
      };
    }

    match = controller.advanceBotMatch(match, submissions) as MatchSnapshot;
  }
}

export async function playAndLogTacticalRollout(args: {
  readonly tacticalSeed: number;
  readonly archetypeIndex: number;
  readonly freshEveryPlies: number;
  readonly oracle: TeacherOracle;
  readonly annotateVariants: readonly AnnotatableVariant[];
  readonly weightSpec: ReturnType<typeof loadWeightSpec>;
  readonly width: number;
}): Promise<DecisionRecord[]> {
  const {
    tacticalSeed,
    archetypeIndex,
    freshEveryPlies,
    oracle,
    annotateVariants,
    weightSpec,
    width,
  } = args;
  const scenario = createTacticalScenario(tacticalSeed, archetypeIndex);
  await oracle.resetPersistentTree();

  const gameId = `tactical-${scenario.archetype}-s${tacticalSeed}`;
  let state = scenario.state as CanonicalState;
  let bagSeed = scenario.bagSeed;
  const records: DecisionRecord[] = [];

  for (let ply = 1; ply <= scenario.rolloutPlies + 1; ply += 1) {
    if (hasVisibleOverflow(state)) break;
    if (state.pieces.known.length < 18) {
      const ext = extendSeededQueue([state.pieces.current, ...state.pieces.known], bagSeed, 24);
      bagSeed = ext.bagSeed as number;
      state = {
        ...state,
        pieces: { ...state.pieces, known: ext.queue.slice(1) as PieceKind[] },
      };
    }
    const legal = buildLegalActions(state);
    if (legal.legalActions.length === 0) break;

    const gui = canonicalToGuiState(state);
    const res =
      ply === 1
        ? await oracle.decideFresh(state, legal, gui)
        : await oracle.decidePersistent(state, legal, gui);
    if (!res.ok) break;

    let freshLabel: TeacherLabel | null = null;
    if (ply > 1 && freshEveryPlies > 0 && ply % freshEveryPlies === 0) {
      const freshProbe = await oracle.decideFresh(state, legal, gui);
      if (freshProbe.ok) freshLabel = freshProbe.label;
    }

    let rec = assembleDecisionRecord({
      source: "targeted_tactical",
      gameId,
      seed: tacticalSeed,
      ply,
      actorSeat: "tactical",
      actorBot: "cc2-s2-champion",
      opponentBot: `tactical:${scenario.archetype}`,
      tacticalTag: scenario.archetype,
      canonicalState: state,
      legal,
      teacher: res.label,
      freshTeacher: freshLabel,
    });
    if (annotateVariants.length > 0) {
      rec = annotateDecisionRecord(rec, { variants: annotateVariants, weightSpec, width });
    }
    records.push(rec);

    const nextState = res.resolved.transition.nextState;
    if (!nextState || res.resolved.transition.tankResult?.toppedOut) break;
    state = {
      ...nextState,
      time: {
        ...nextState.time,
        logicalFrame: nextState.time.logicalFrame + 24,
      },
    };
  }
  return records;
}

export async function generateImitationDataset(config: GeneratorConfig): Promise<{
  readonly totalPositions: number;
  readonly gamesBySource: Record<DatasetSource, number>;
  readonly positionsBySource: Record<DatasetSource, number>;
  readonly positionsBySplit: Record<"train" | "val" | "test", number>;
  readonly metadataPath: string;
}> {
  const quotas = config.quotas ?? DEFAULT_SOURCE_QUOTAS;
  const maxTurns = config.maxTurnsPerMatch ?? 240;
  const pps = config.pps ?? 2.5;
  const freshEveryPlies = config.freshEveryPlies ?? 8;
  const annotateVariants = config.annotateVariants ?? [];
  const shardIndex = config.shardIndex ?? 0;
  const shardCount = config.shardCount ?? 1;
  const seedStride = config.seedStride ?? shardCount;
  const width = config.width ?? 48;
  const weightSpec = loadWeightSpec(config.weightsPath);

  const championOracleLeft = new TeacherOracle({ botType: "cc2-s2-champion" });
  const championOracleRight = new TeacherOracle({ botType: "cc2-s2-champion" });
  const historicalOracles = new Map<string, TeacherOracle>();
  for (const hb of HISTORICAL_BOT_TYPES) {
    historicalOracles.set(hb, new TeacherOracle({ botType: hb }));
  }

  mkdirSync(dirname(resolve(config.outputPath)), { recursive: true });
  const out = createWriteStream(resolve(config.outputPath), { encoding: "utf8" });

  const sources: DatasetSource[] = [
    "attax_vs_champion",
    "champion_selfplay",
    "champion_vs_historical",
    "corrected_attax_vs_champion",
    "targeted_tactical",
  ];
  const positionsBySource: Record<DatasetSource, number> = {
    attax_vs_champion: 0,
    champion_selfplay: 0,
    champion_vs_historical: 0,
    corrected_attax_vs_champion: 0,
    targeted_tactical: 0,
  };
  const gamesBySource: Record<DatasetSource, number> = {
    attax_vs_champion: 0,
    champion_selfplay: 0,
    champion_vs_historical: 0,
    corrected_attax_vs_champion: 0,
    targeted_tactical: 0,
  };
  const positionsBySplit: Record<"train" | "val" | "test", number> = {
    train: 0,
    val: 0,
    test: 0,
  };
  const seqBySource: Record<DatasetSource, number> = {
    attax_vs_champion: 0,
    champion_selfplay: 0,
    champion_vs_historical: 0,
    corrected_attax_vs_champion: 0,
    targeted_tactical: 0,
  };

  let totalPositions = 0;
  const startedAt = performance.now();

  try {
    while (totalPositions < config.targetPositions) {
      let pickedSource: DatasetSource = sources[0] as DatasetSource;
      let maxDeficit = -Infinity;
      for (const s of sources) {
        if ((quotas[s] ?? 0) <= 0) continue;
        const deficit = quotas[s] * (totalPositions + 1) - positionsBySource[s];
        if (deficit > maxDeficit) {
          maxDeficit = deficit;
          pickedSource = s;
        }
      }

      const seq = seqBySource[pickedSource];
      seqBySource[pickedSource] = seq + 1;
      const seed = SOURCE_SEED_OFFSETS[pickedSource] + 1 + shardIndex + seq * seedStride;

      let gameRecords: DecisionRecord[] = [];
      if (pickedSource === "targeted_tactical") {
        gameRecords = await playAndLogTacticalRollout({
          tacticalSeed: seed,
          archetypeIndex: seq % TACTICAL_ARCHETYPES.length,
          freshEveryPlies,
          oracle: championOracleLeft,
          annotateVariants,
          weightSpec,
          width,
        });
      } else {
        const res = await playAndLogMatch({
          source: pickedSource,
          seed,
          pps,
          maxTurns,
          freshEveryPlies,
          championOracleLeft,
          championOracleRight,
          historicalOracles,
          weights: weightSpec.weights,
          width,
          annotateVariants,
          weightSpec,
        });
        gameRecords = res.records;
      }

      for (const rec of gameRecords) {
        out.write(`${JSON.stringify(rec)}\n`);
        positionsBySource[pickedSource] += 1;
        positionsBySplit[rec.split] += 1;
        totalPositions += 1;
      }
      gamesBySource[pickedSource] += 1;

      const elapsedSec = (performance.now() - startedAt) / 1000;
      console.error(
        `[gen shard ${shardIndex}/${shardCount}] +${gameRecords.length} (${pickedSource} seed=${seed}) -> total=${totalPositions}/${config.targetPositions} (${(totalPositions / Math.max(0.01, elapsedSec)).toFixed(2)} pos/s)`,
      );
    }
  } finally {
    await championOracleLeft.close();
    await championOracleRight.close();
    for (const h of historicalOracles.values()) {
      await h.close();
    }
    await new Promise<void>((res, rej) => {
      out.end(() => res());
      out.on("error", rej);
    });
  }

  const metadataPath = `${resolve(config.outputPath)}.meta.json`;
  const elapsedSec = (performance.now() - startedAt) / 1000;
  writeFileSync(
    metadataPath,
    JSON.stringify(
      {
        schema: "attax-s2-imitation-meta/1",
        generatedAt: new Date().toISOString(),
        elapsedSec,
        wasmPath: "bot/cold-clear-2-s2/target/wasm32-unknown-unknown/release/cold_clear_2_s2.wasm",
        wasmSha256: championOracleLeft.wasmSha256,
        championConfigHash: championOracleLeft.configHash,
        championProfileId: championOracleLeft.profile.profileId,
        weightsId: weightSpec.weightsId,
        width,
        pps,
        maxTurns,
        freshEveryPlies,
        shardIndex,
        shardCount,
        seedStride,
        annotateVariants,
        quotas,
        totalPositions,
        gamesBySource,
        positionsBySource,
        positionsBySplit,
      },
      null,
      2,
    ),
  );

  return {
    totalPositions,
    gamesBySource,
    positionsBySource,
    positionsBySplit,
    metadataPath,
  };
}

function parseCliArgs(argv: readonly string[]): GeneratorConfig {
  let outputPath = "";
  let targetPositions = 2000;
  let maxTurnsPerMatch = 240;
  let pps = 2.5;
  let freshEveryPlies = 8;
  let annotateVariants: AnnotatableVariant[] = [];
  let shardIndex = 0;
  let shardCount = 1;
  let weightsPath: string | undefined;
  let width = 48;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const next = argv[i + 1];
    if (arg === "--output" && next) {
      outputPath = next;
      i += 1;
    } else if (arg === "--target-positions" && next) {
      targetPositions = Number(next);
      i += 1;
    } else if (arg === "--max-turns" && next) {
      maxTurnsPerMatch = Number(next);
      i += 1;
    } else if (arg === "--pps" && next) {
      pps = Number(next);
      i += 1;
    } else if (arg === "--fresh-every" && next) {
      freshEveryPlies = Number(next);
      i += 1;
    } else if (arg === "--annotate") {
      annotateVariants = ["existing", "corrected"];
    } else if (arg === "--annotate-variants" && next) {
      annotateVariants = next
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is AnnotatableVariant => s === "existing" || s === "corrected");
      i += 1;
    } else if (arg === "--shard-index" && next) {
      shardIndex = Number(next);
      i += 1;
    } else if (arg === "--shard-count" && next) {
      shardCount = Number(next);
      i += 1;
    } else if (arg === "--weights" && next) {
      weightsPath = next;
      i += 1;
    } else if (arg === "--width" && next) {
      width = Number(next);
      i += 1;
    }
  }
  if (!outputPath) {
    throw new Error(
      "Usage: bun tools/s2-lab/imitation/generate-dataset.ts --output <out.jsonl> [--target-positions 2000] [--annotate] [--shard-index 0 --shard-count 1]",
    );
  }
  return {
    outputPath,
    targetPositions,
    maxTurnsPerMatch,
    pps,
    freshEveryPlies,
    annotateVariants,
    shardIndex,
    shardCount,
    weightsPath,
    width,
  };
}

if (import.meta.main) {
  const cfg = parseCliArgs(process.argv.slice(2));
  generateImitationDataset(cfg)
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
