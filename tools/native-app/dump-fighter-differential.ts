/**
 * Native-app Phase 2 differential fixture: record the TS (wasm-backed) fighter
 * decisions for a versus match at a reduced-but-faithful-format config.
 *
 *   bun tools/native-app/dump-fighter-differential.ts
 *
 * `rust/ai-fighters/tests/fighter_differential.rs` replays the same seeds with
 * the native fighters through the same controller and asserts every recorded
 * decision (useHold / placeAt / garbageWait) and the final side state match.
 * The reduced depth/beam only exists so the always-on Rust test is fast in
 * debug; the carry path (NextMino, offset, weight row, frame clock, piece
 * counter) is identical to the faithful config.
 */

import { writeFileSync } from "node:fs";
import type { AiMove, GameSnapshot } from "../../src/ui/types.js";
import { resolveVersusConfig } from "../../src/versus/config.js";
import {
  boardFingerprint,
  createVersusController,
  type SideState,
  VERSUS_DEFAULTS,
  type VersusFighter,
} from "../../src/versus/controller.js";
import { createRustDeepSeekV2 } from "../deepseek-rust/loader.js";
import { createRustHoiko } from "../hoiko-rust/loader.js";

const SEEDS = [1, 2, 3, 7, 42] as const;
const MAX_TICKS = 12_000;
const TICK_MS = 16;

const HOIKO_OPTIONS = {
  versus: true,
  beamSizeLimit: 12,
  depthLimit: 6,
  adapt: false,
  offset: true,
  framesPerThink: 20,
} as const;

const DEEPSEEK_OPTIONS = {
  depth: 3,
  width: 8,
  topK: 4,
  useKicks: true,
  useOpponent: true,
  useGarbageDefense: true,
  useDownstack: true,
} as const;

interface Decision {
  readonly useHold: boolean;
  readonly fallback: boolean;
  readonly x: number;
  readonly rotation: number;
  readonly topRow: number;
  readonly lastSrs: number;
  readonly garbageWait: boolean;
}

interface SideRecord {
  readonly lock: number;
  readonly over: boolean;
  readonly lines: number;
  readonly pending: number;
  readonly sent: number;
  readonly blocked: number;
  readonly board: string;
  readonly act: string;
}

function recordDecision(decisions: Decision[], move: AiMove | null): void {
  const placeAt = move?.execution?.steps.find((step) => step.kind === "placeAt");
  decisions.push({
    useHold: move?.useHold ?? false,
    fallback: move === null,
    x: move?.targetX ?? 0,
    rotation: move?.targetRotation ?? 0,
    topRow: placeAt?.topRow ?? 0,
    lastSrs: placeAt?.lastSrs ?? 0,
    garbageWait: move?.garbageWait ?? false,
  });
}

function recording(inner: VersusFighter, decisions: Decision[]): VersusFighter {
  return {
    name: inner.name,
    color: inner.color,
    reset: () => inner.reset(),
    findBestMove: (snapshot) => {
      let move: AiMove | null = null;
      try {
        move = inner.findBestMove(snapshot);
      } catch {
        move = null;
      }
      recordDecision(decisions, move);
      return move;
    },
  };
}

function sideRecord(side: SideState): SideRecord {
  const snapshot: GameSnapshot = side.core.getSnapshot();
  return {
    lock: snapshot.lockId,
    over: snapshot.gameOver,
    lines: snapshot.lines,
    pending: snapshot.pendingGarbage,
    sent: side.sentTotal,
    blocked: side.blockedTotal,
    board: boardFingerprint(snapshot),
    act: snapshot.lastAction,
  };
}

function runScenario(seed: number): unknown {
  const leftDecisions: Decision[] = [];
  const rightDecisions: Decision[] = [];
  const hoiko = recording(createRustHoiko(HOIKO_OPTIONS), leftDecisions);
  const deepseek = recording(createRustDeepSeekV2(DEEPSEEK_OPTIONS), rightDecisions);
  const controller = createVersusController(hoiko, deepseek, seed, resolveVersusConfig());
  let ticks = 0;
  while (controller.result === null && ticks < MAX_TICKS) {
    controller.tick(TICK_MS, VERSUS_DEFAULTS);
    ticks += 1;
  }
  const result = controller.result;
  return {
    seed,
    maxTicks: MAX_TICKS,
    tickMs: TICK_MS,
    hoiko: HOIKO_OPTIONS,
    deepseek: DEEPSEEK_OPTIONS,
    ticks,
    result:
      result === null
        ? null
        : {
            winner: result.winner,
            reason: result.reason,
            pieces: result.pieces,
            linesLeft: result.linesLeft,
            linesRight: result.linesRight,
            sentLeft: result.sentLeft,
            sentRight: result.sentRight,
          },
    leftDecisions,
    rightDecisions,
    final: {
      pieces: controller.pieces,
      left: sideRecord(controller.left),
      right: sideRecord(controller.right),
      leftMismatches: controller.left.executionSourceMismatches,
      rightMismatches: controller.right.executionSourceMismatches,
      leftBoardFailures: controller.left.executionExpectedBoardFailures,
      rightBoardFailures: controller.right.executionExpectedBoardFailures,
    },
  };
}

const scenarios = SEEDS.map(runScenario);
const out = new URL("../../evidence/native-app/fighter-differential.json", import.meta.url);
writeFileSync(out, `${JSON.stringify({ scenarios })}\n`);
for (const scenario of scenarios as {
  seed: number;
  ticks: number;
  result: { winner: string } | null;
  leftDecisions: readonly unknown[];
  rightDecisions: readonly unknown[];
}[]) {
  console.log(
    `seed ${scenario.seed}: ${scenario.result?.winner ?? "cap"} ticks ${scenario.ticks} decisions ${scenario.leftDecisions.length}/${scenario.rightDecisions.length}`,
  );
}
