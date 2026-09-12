import { readFileSync } from "node:fs";
import { readV2Options } from "../../scripts/gate-v2.js";
import type { GameSnapshot } from "../../src/ui/types.js";
import { resolveVersusConfig } from "../../src/versus/config.js";
import {
  createVersusController,
  VERSUS_DEFAULTS,
  type VersusFighter,
} from "../../src/versus/controller.js";
import type { RustDeepSeekFighter } from "../../tools/deepseek-rust/loader.js";
import type { RustHoikoFighter } from "../../tools/hoiko-rust/loader.js";

export function readSource(url: URL): string {
  return readFileSync(url, "utf8");
}

export function capturedGroup(source: string, pattern: RegExp, label: string): string {
  const value = pattern.exec(source)?.[1];
  if (value === undefined) throw new Error(`could not find ${label}`);
  return value;
}

/** Decision snapshots exactly as the versus controller builds them for a fighter. */
export function captureDecisionSnapshots(limit: number, seed: number): readonly GameSnapshot[] {
  const snapshots: GameSnapshot[] = [];
  const makeStub = (capture: boolean): VersusFighter => {
    let piece = 0;
    return {
      name: capture ? "capture" : "stub",
      color: "#000000",
      findBestMove: (snapshot) => {
        if (snapshot.active === null || snapshot.gameOver) return null;
        if (capture && snapshots.length < limit) snapshots.push(structuredClone(snapshot));
        piece += 1;
        return { targetX: piece % 10, targetRotation: piece % 4, useHold: false };
      },
    };
  };
  const controller = createVersusController(
    makeStub(true),
    makeStub(false),
    seed,
    resolveVersusConfig(),
  );
  let ticks = 0;
  while (snapshots.length < limit && controller.result === null && ticks < limit * 16) {
    if (ticks > 0 && ticks % 40 === 0) controller.left.core.receiveGarbage?.(3);
    controller.tick(VERSUS_DEFAULTS.stepIntervalMs, VERSUS_DEFAULTS);
    ticks += 1;
  }
  return snapshots;
}

export function requireSnapshot(snapshot: GameSnapshot | undefined, label: string): GameSnapshot {
  if (snapshot === undefined) throw new Error(`no snapshot captured for ${label}`);
  return snapshot;
}

export interface HoikoEngineSettings {
  readonly adapt: boolean;
  readonly depthLimit: number;
  readonly viewNext: number;
  readonly isEvenBoard: boolean;
  readonly framesPerThink: number;
  readonly offsetEnabled: number;
  readonly searchState: {
    readonly maxBeamSize: number;
    readonly beamSizeLimit: number;
    readonly timerLimitMs: number;
  };
}

export function hoikoEngineSettings(fighter: RustHoikoFighter): HoikoEngineSettings {
  return {
    adapt: fighter.engine.adapt,
    depthLimit: fighter.engine.depthLimit,
    viewNext: fighter.engine.viewNext,
    isEvenBoard: fighter.engine.isEvenBoard,
    framesPerThink: fighter.engine.framesPerThink,
    offsetEnabled: fighter.engine.offsetEnabled,
    searchState: fighter.engine.searchState,
  };
}

export function hoikoDecision(fighter: RustHoikoFighter, snapshot: GameSnapshot) {
  const result = fighter.searchSnapshot(snapshot);
  if (result === null) throw new Error("searchSnapshot returned null for a live snapshot");
  return result;
}

export function deepSeekEngineSettings(fighter: RustDeepSeekFighter) {
  return {
    depth: fighter.engine.depth,
    width: fighter.engine.width,
    topK: fighter.engine.topK,
    useKicks: fighter.engine.useKicks,
    useOpponent: fighter.engine.useOpponent,
    useGarbageDefense: fighter.engine.useGarbageDefense,
    useDownstack: fighter.engine.useDownstack,
  };
}

export function deepSeekDecision(fighter: RustDeepSeekFighter, snapshot: GameSnapshot) {
  const result = fighter.searchSnapshot(snapshot);
  if (result === null) throw new Error("searchSnapshot returned null for a live snapshot");
  return result;
}

/** Gate defaults, read through the gate's own resolver with DSV2_* env cleared. */
export function readGateV2Defaults() {
  const keys = [
    "DSV2_DEPTH",
    "DSV2_WIDTH",
    "DSV2_TOP_K",
    "DSV2_KICKS",
    "DSV2_OPPONENT",
    "DSV2_GARBAGE",
    "DSV2_DOWNSTACK",
    "DSV2_BOOK",
  ] as const;
  const saved = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) delete process.env[key];
  try {
    return readV2Options();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
