/**
 * Headless app-vs-gate behavioral comparison (no browser, no Playwright).
 *
 * Both constructions use the CLI loaders, which instantiate the same wasm bytes
 * as the browser `?url` loaders:
 *   app  = Hoiko LEFT (createRustHoiko() defaults) + Rust DeepSeek RIGHT + speedOptions(1)
 *   gate = DeepSeek LEFT + Hoiko RIGHT (resolveFaithfulHoikoOptions) + VERSUS_DEFAULTS
 *
 * Emits JSONL on stdout: app-cli-config, app-cli-match, app-cli-engine,
 * app-cli-deterministic, app-cli-summary.
 *
 * Usage: DSV2_RUST=1 bun tools/hoiko-oracle/diff/app-vs-cli.ts [--seeds=1,7,42]
 *        HOIKO_ADAPT=0 ... makes the gate-side faithful run beam-deterministic.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolveFaithfulHoikoOptions } from "../../../src/ai/hoiko-faithful.js";
import type { RustHoikoFighter, RustOut } from "../../../src/ai/hoiko-rust-core.js";
import type { GameSnapshot } from "../../../src/ui/types.js";
import { resolveVersusConfig } from "../../../src/versus/config.js";
import {
  createVersusController,
  type SideState,
  VERSUS_DEFAULTS,
  type VersusController,
  type VersusControllerOptions,
  type VersusFighter,
} from "../../../src/versus/controller.js";
import { speedOptions } from "../../../src/versus/speed.js";
import { createRustDeepSeekV2 } from "../../deepseek-rust/loader.js";
import { createRustHoiko } from "../../hoiko-rust/loader.js";

process.env.DSV2_RUST ??= "1";
const { makeOurFighter, readPreset, readV2Options } = await import("../../../scripts/gate-v2.js");

const TICK_MS = 16;
const MAX_REPLAY_SNAPSHOTS = 120;

function readArg(name: string): string | undefined {
  const hit = Bun.argv.find((argument) => argument.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const seedText = readArg("seeds") ?? process.env.HOIKO_SEEDS ?? "1,7,42";
const seeds = seedText
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value));
const maxTicks = Number(readArg("max-ticks") ?? process.env.HOIKO_MAX_TICKS ?? 12000);
if (!Number.isInteger(maxTicks) || maxTicks < 1) throw new Error(`bad maxTicks ${maxTicks}`);
const dsv2Engine = process.env.DSV2_RUST === "0" ? "ts" : "rust-wasm";
const preset = readPreset(process.env.HOIKO_PRESET);
const WASM_URL = new URL("../../../src/ai/wasm/hoiko_core.wasm", import.meta.url);
const DS_WASM_URL = new URL("../../../src/ai/wasm/deepseek_v2.wasm", import.meta.url);

function sha256(url: URL): string {
  return createHash("sha256").update(readFileSync(url)).digest("hex");
}

function emit(record: Record<string, unknown>): void {
  console.log(JSON.stringify(record));
}

interface DecisionTuple {
  readonly x: number;
  readonly rotation: number;
  readonly m: number;
  readonly garbageWait: number;
}

function tupleOf(out: RustOut): DecisionTuple {
  return {
    x: out.x,
    rotation: ((out.firstRRaw % 4) + 4) % 4,
    m: out.firstM,
    garbageWait: out.garbageWait,
  };
}

function tupleEqual(left: DecisionTuple, right: DecisionTuple): boolean {
  return (
    left.x === right.x &&
    left.rotation === right.rotation &&
    left.m === right.m &&
    left.garbageWait === right.garbageWait
  );
}

interface CapturedDecision {
  readonly snapshot: GameSnapshot;
  readonly out: RustOut;
  readonly tuple: DecisionTuple;
}

function instrumentHoiko(fighter: RustHoikoFighter, captured: CapturedDecision[]): VersusFighter {
  return {
    name: fighter.name,
    color: fighter.color,
    findBestMove: (snapshot) => {
      const result = fighter.searchSnapshot(snapshot);
      if (result !== null) {
        captured.push({
          snapshot: structuredClone(snapshot),
          out: result.out,
          tuple: tupleOf(result.out),
        });
      }
      return result?.move ?? null;
    },
  };
}

interface ParityReport {
  readonly steps: number;
  readonly decisionMismatches: number;
  readonly fullOutMismatches: number;
  readonly stateMismatches: number;
  readonly firstMismatchIndex: number | null;
  readonly firstFullOutMismatchIndex: number | null;
  readonly fullOutMismatchFields: readonly string[];
  readonly leftVsRecordedMismatches: number | null;
  readonly rightVsRecordedMismatches: number | null;
}

const OUT_FIELDS = [
  "ok",
  "x",
  "rotation",
  "y",
  "lastSrs",
  "useHold",
  "firstRRaw",
  "firstM",
  "firstAct",
  "moveDelay",
  "planActs",
  "planLen",
  "score",
  "depth",
  "node",
  "garbageWait",
  "maxBeamSize",
  "beamSizeLimit",
  "timerLimitMs",
  "weightIndex",
  "useOffsetOff",
  "ofsCanWait",
  "ofsCenter4",
  "ofsAtk",
  "ofsPcChance",
  "ofsNearOffset",
  "gbOpponentsAtk",
  "gbCoolTime",
  "gbRemainingTime",
  "gbOpponentsLockCount",
  "gbFirstInvalidLock",
  "hasLastOwnLock",
  "lastOwnLockId",
  "hasLastOppLock",
  "lastOppLockId",
] as const satisfies readonly (keyof RustOut)[];

function differentOutFields(left: RustOut, right: RustOut): string[] {
  return OUT_FIELDS.filter((field) => JSON.stringify(left[field]) !== JSON.stringify(right[field]));
}

function parityOverSnapshots(
  snapshots: readonly GameSnapshot[],
  makeLeft: () => RustHoikoFighter,
  makeRight: () => RustHoikoFighter,
  recorded?: readonly CapturedDecision[],
): ParityReport {
  const left = makeLeft();
  const right = makeRight();
  let decisionMismatches = 0;
  let fullOutMismatches = 0;
  let stateMismatches = 0;
  let firstMismatchIndex: number | null = null;
  let firstFullOutMismatchIndex: number | null = null;
  const fullOutMismatchFields = new Set<string>();
  let leftVsRecordedMismatches = recorded === undefined ? null : 0;
  let rightVsRecordedMismatches = recorded === undefined ? null : 0;
  for (const [index, snapshot] of snapshots.entries()) {
    if (JSON.stringify(left.engine.searchState) !== JSON.stringify(right.engine.searchState)) {
      stateMismatches += 1;
    }
    const leftResult = left.searchSnapshot(snapshot);
    const rightResult = right.searchSnapshot(snapshot);
    if (leftResult === null || rightResult === null) {
      throw new Error(`searchSnapshot returned null at index ${index}`);
    }
    const leftTuple = tupleOf(leftResult.out);
    const rightTuple = tupleOf(rightResult.out);
    if (!tupleEqual(leftTuple, rightTuple)) {
      decisionMismatches += 1;
      if (firstMismatchIndex === null) firstMismatchIndex = index;
    }
    if (JSON.stringify(leftResult.out) !== JSON.stringify(rightResult.out)) {
      fullOutMismatches += 1;
      if (firstFullOutMismatchIndex === null) firstFullOutMismatchIndex = index;
      for (const field of differentOutFields(leftResult.out, rightResult.out)) {
        fullOutMismatchFields.add(field);
      }
    }
    const reference = recorded?.[index];
    if (reference !== undefined) {
      if (!tupleEqual(leftTuple, reference.tuple)) {
        leftVsRecordedMismatches = (leftVsRecordedMismatches ?? 0) + 1;
      }
      if (!tupleEqual(rightTuple, reference.tuple)) {
        rightVsRecordedMismatches = (rightVsRecordedMismatches ?? 0) + 1;
      }
    }
  }
  return {
    steps: snapshots.length,
    decisionMismatches,
    fullOutMismatches,
    stateMismatches,
    firstMismatchIndex,
    firstFullOutMismatchIndex,
    fullOutMismatchFields: [...fullOutMismatchFields].sort(),
    leftVsRecordedMismatches,
    rightVsRecordedMismatches,
  };
}

type FighterId = "HOIKO" | "DEEPSEEK";

interface FighterSummary {
  readonly lines: number;
  readonly sent: number;
  readonly locks: number;
  readonly maxPending: number;
  readonly maxHeight: number;
  readonly holes: number;
  readonly executionSourceMismatches: number;
  readonly executionExpectedBoardFailures: number;
  readonly thinkCount: number;
  readonly thinkMs: number;
  readonly error: string | null;
}

interface MatchResult {
  readonly winner: FighterId | "draw" | "cap";
  readonly reason: string;
  readonly ticks: number;
  readonly pieces: number;
  readonly hoiko: FighterSummary;
  readonly deepseek: FighterSummary;
}

interface FlowDelta {
  readonly sameWinner: boolean;
  readonly sameTicks: boolean;
  readonly samePieces: boolean;
  readonly tickDelta: number;
  readonly pieceDelta: number;
  readonly hoikoLinesDelta: number;
  readonly deepseekLinesDelta: number;
  readonly hoikoSentDelta: number;
  readonly deepseekSentDelta: number;
}

function stackHeight(grid: GameSnapshot["board"]["grid"]): number {
  for (let rowIndex = 0; rowIndex < grid.length; rowIndex += 1) {
    if (grid[rowIndex]?.some((cell) => cell !== 0) === true) return grid.length - rowIndex;
  }
  return 0;
}

function countHoles(grid: GameSnapshot["board"]["grid"]): number {
  let holes = 0;
  for (let column = 0; column < 10; column += 1) {
    let blockSeen = false;
    for (const row of grid) {
      const filled = (row?.[column] ?? 0) !== 0;
      if (filled) blockSeen = true;
      else if (blockSeen) holes += 1;
    }
  }
  return holes;
}

function summarize(side: SideState, maxPending: number): FighterSummary {
  const snapshot = side.core.getSnapshot();
  return {
    lines: snapshot.lines,
    sent: side.sentTotal,
    locks: snapshot.lockId,
    maxPending,
    maxHeight: stackHeight(snapshot.board.grid),
    holes: countHoles(snapshot.board.grid),
    executionSourceMismatches: side.executionSourceMismatches,
    executionExpectedBoardFailures: side.executionExpectedBoardFailures,
    thinkCount: side.thinkCount,
    thinkMs: side.thinkMs,
    error: side.lastError,
  };
}

function buildApp(seed: number, adapt: boolean, captured: CapturedDecision[]): VersusController {
  const hoiko = createRustHoiko({ adapt });
  const deepseek = createRustDeepSeekV2();
  const deepseekFighter: VersusFighter = {
    name: "DEEPSEEK",
    color: "#38bdf8",
    findBestMove: (snapshot) => deepseek.findBestMove(snapshot),
    reset: () => deepseek.reset(),
  };
  return createVersusController(
    instrumentHoiko(hoiko, captured),
    deepseekFighter,
    seed,
    resolveVersusConfig(),
  );
}

function buildGate(seed: number, adapt: boolean, captured: CapturedDecision[]): VersusController {
  const v2 = readV2Options();
  const hoikoOptions = { ...resolveFaithfulHoikoOptions(process.env, preset), adapt };
  const hoiko = createRustHoiko(hoikoOptions);
  const ourFighter = makeOurFighter(v2);
  return createVersusController(
    ourFighter,
    instrumentHoiko(hoiko, captured),
    seed,
    resolveVersusConfig(),
  );
}

function runController(
  controller: VersusController,
  options: VersusControllerOptions,
  leftId: FighterId,
): MatchResult {
  let ticks = 0;
  let maxPendingLeft = 0;
  let maxPendingRight = 0;
  while (controller.result === null && ticks < maxTicks) {
    controller.tick(TICK_MS, options);
    ticks += 1;
    maxPendingLeft = Math.max(maxPendingLeft, controller.left.core.getSnapshot().pendingGarbage);
    maxPendingRight = Math.max(maxPendingRight, controller.right.core.getSnapshot().pendingGarbage);
  }
  const result = controller.result;
  const leftSummary = summarize(controller.left, maxPendingLeft);
  const rightSummary = summarize(controller.right, maxPendingRight);
  const winner: MatchResult["winner"] =
    result === null
      ? "cap"
      : result.winner === "draw"
        ? "draw"
        : result.winner === "left"
          ? leftId
          : leftId === "HOIKO"
            ? "DEEPSEEK"
            : "HOIKO";
  return {
    winner,
    reason: result?.reason ?? "max-ticks",
    ticks,
    pieces: result?.pieces ?? controller.pieces,
    hoiko: leftId === "HOIKO" ? leftSummary : rightSummary,
    deepseek: leftId === "DEEPSEEK" ? leftSummary : rightSummary,
  };
}

function flowOf(app: MatchResult, gate: MatchResult): FlowDelta {
  return {
    sameWinner: app.winner === gate.winner,
    sameTicks: app.ticks === gate.ticks,
    samePieces: app.pieces === gate.pieces,
    tickDelta: gate.ticks - app.ticks,
    pieceDelta: gate.pieces - app.pieces,
    hoikoLinesDelta: gate.hoiko.lines - app.hoiko.lines,
    deepseekLinesDelta: gate.deepseek.lines - app.deepseek.lines,
    hoikoSentDelta: gate.hoiko.sent - app.hoiko.sent,
    deepseekSentDelta: gate.deepseek.sent - app.deepseek.sent,
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

emit({
  type: "app-cli-config",
  seeds,
  tickMs: TICK_MS,
  maxTicks,
  app: {
    hoikoSide: "left",
    hoiko: resolveFaithfulHoikoOptions({}),
    deepseekSide: "right",
    deepseek: "rust-defaults",
    options: "speedOptions(1)",
    versus: resolveVersusConfig(),
  },
  gate: {
    hoikoSide: "right",
    hoiko: resolveFaithfulHoikoOptions(process.env, preset),
    deepseekSide: "left",
    deepseek: { ...readV2Options(), engine: dsv2Engine },
    options: "VERSUS_DEFAULTS",
    versus: resolveVersusConfig(),
  },
  wasm: { hoiko: sha256(WASM_URL), deepseek: sha256(DS_WASM_URL) },
});

interface SeedRow {
  readonly seed: number;
  readonly app: MatchResult;
  readonly gate: MatchResult;
  readonly flow: FlowDelta;
  readonly fixed: ParityReport;
  readonly faithful: ParityReport;
  readonly appFixed: MatchResult;
  readonly gateFixed: MatchResult;
  readonly deterministicFlow: FlowDelta;
}

const rows: SeedRow[] = [];

for (const seed of seeds) {
  const appCaptured: CapturedDecision[] = [];
  const gateCaptured: CapturedDecision[] = [];
  const app = runController(buildApp(seed, true, appCaptured), speedOptions(1), "HOIKO");
  const gate = runController(
    buildGate(seed, resolveFaithfulHoikoOptions(process.env, preset).adapt ?? true, gateCaptured),
    VERSUS_DEFAULTS,
    "DEEPSEEK",
  );
  const combined = [...appCaptured, ...gateCaptured].slice(0, MAX_REPLAY_SNAPSHOTS);
  const snapshots = combined.map((decision) => decision.snapshot);
  const fixed = parityOverSnapshots(
    snapshots,
    () => createRustHoiko({ adapt: false }),
    () => createRustHoiko({ ...resolveFaithfulHoikoOptions({}), adapt: false }),
  );
  const faithful = parityOverSnapshots(
    snapshots,
    () => createRustHoiko(),
    () => createRustHoiko(resolveFaithfulHoikoOptions(process.env, preset)),
    appCaptured,
  );
  const appFixed = runController(buildApp(seed, false, []), speedOptions(1), "HOIKO");
  const gateFixed = runController(buildGate(seed, false, []), VERSUS_DEFAULTS, "DEEPSEEK");
  const row: SeedRow = {
    seed,
    app,
    gate,
    flow: flowOf(app, gate),
    fixed,
    faithful,
    appFixed,
    gateFixed,
    deterministicFlow: flowOf(appFixed, gateFixed),
  };
  rows.push(row);
  emit({ type: "app-cli-match", seed, app, gate, flow: row.flow });
  emit({
    type: "app-cli-engine",
    seed,
    snapshots: snapshots.length,
    fixed,
    faithful: { ...faithful, recordedFrom: "app-match" },
  });
  emit({
    type: "app-cli-deterministic",
    seed,
    adapt: false,
    app: appFixed,
    gate: gateFixed,
    flow: row.deterministicFlow,
  });
}

const fixedDecisionMismatches = sum(rows.map((row) => row.fixed.decisionMismatches));
const fixedFullOutMismatches = sum(rows.map((row) => row.fixed.fullOutMismatches));
const faithfulDecisionMismatches = sum(rows.map((row) => row.faithful.decisionMismatches));
const faithfulFullOutMismatches = sum(rows.map((row) => row.faithful.fullOutMismatches));
const faithfulStateMismatches = sum(rows.map((row) => row.faithful.stateMismatches));
const recordedMismatches = sum(
  rows.map(
    (row) =>
      (row.faithful.leftVsRecordedMismatches ?? 0) + (row.faithful.rightVsRecordedMismatches ?? 0),
  ),
);
const sameWinner = rows.filter((row) => row.flow.sameWinner).length;
const deterministicSameWinner = rows.filter((row) => row.deterministicFlow.sameWinner).length;
const engineParity =
  fixedDecisionMismatches === 0 && fixedFullOutMismatches === 0
    ? "PASS: engine decisions identical on identical snapshots (fixed beam)"
    : `FAIL: ${fixedDecisionMismatches} tuple / ${fixedFullOutMismatches} full-out mismatches`;

emit({
  type: "app-cli-summary",
  seeds,
  verdict: {
    engineDecisionParity: engineParity,
    faithfulAdaptation: `${faithfulDecisionMismatches} tuple / ${faithfulFullOutMismatches} full-out / ${faithfulStateMismatches} state mismatches on ${sum(rows.map((row) => row.faithful.steps))} replayed decisions; ${recordedMismatches} replay-vs-recorded mismatches`,
    matchFlow: `${sameWinner}/${rows.length} seeds pick the same winner (faithful adaptation); deterministic (adapt off): ${deterministicSameWinner}/${rows.length}`,
  },
  fixed: { decisionMismatches: fixedDecisionMismatches, fullOutMismatches: fixedFullOutMismatches },
  faithful: {
    decisionMismatches: faithfulDecisionMismatches,
    fullOutMismatches: faithfulFullOutMismatches,
    stateMismatches: faithfulStateMismatches,
    replayVsRecordedMismatches: recordedMismatches,
  },
  flow: {
    sameWinner,
    sameTicks: rows.filter((row) => row.flow.sameTicks).length,
    samePieces: rows.filter((row) => row.flow.samePieces).length,
    perSeed: rows.map((row) => ({
      seed: row.seed,
      appWinner: row.app.winner,
      gateWinner: row.gate.winner,
      sameWinner: row.flow.sameWinner,
      tickDelta: row.flow.tickDelta,
      pieceDelta: row.flow.pieceDelta,
    })),
  },
  deterministicFlow: {
    sameWinner: deterministicSameWinner,
    sameTicks: rows.filter((row) => row.deterministicFlow.sameTicks).length,
    samePieces: rows.filter((row) => row.deterministicFlow.samePieces).length,
    perSeed: rows.map((row) => ({
      seed: row.seed,
      appWinner: row.appFixed.winner,
      gateWinner: row.gateFixed.winner,
      sameWinner: row.deterministicFlow.sameWinner,
      tickDelta: row.deterministicFlow.tickDelta,
      pieceDelta: row.deterministicFlow.pieceDelta,
      hoikoLinesDelta: row.deterministicFlow.hoikoLinesDelta,
      deepseekLinesDelta: row.deterministicFlow.deepseekLinesDelta,
    })),
  },
});
