// DeepSeek v2 evaluation helpers: garbage-aware defense, opponent telemetry
// model, and board-shape statistics. Kept pure so they can be unit tested
// independently of the fighter wiring.
import { type Board, COLS } from "../core/board.js";
import type { GameSnapshot } from "../ui/types.js";
import { dsHeights } from "./deepseek-score.js";

export interface V2BoardStats {
  readonly heights: readonly number[];
  readonly globalMax: number;
  readonly middleMax: number;
  readonly avgHeight: number;
  readonly holes: number;
  readonly holeRows: number;
  /** Holes whose covering gap sits in the upper third of the stack. */
  readonly topHoles: number;
  /** Deep holes (2+ buried cells) that are expensive to dig out. */
  readonly deepHoles: number;
}

/** Board-shape stats tuned for versus survivability. */
export function v2BoardStats(after: Board): V2BoardStats {
  const heights = dsHeights(after);
  let globalMax = 0;
  let sum = 0;
  for (const v of heights) {
    if (v > globalMax) globalMax = v;
    sum += v;
  }
  let middleMax = 0;
  for (let x = 3; x <= 6; x += 1) {
    const v = heights[x] ?? 0;
    if (v > middleMax) middleMax = v;
  }
  let holes = 0;
  let holeRows = 0;
  let topHoles = 0;
  let deepHoles = 0;
  const topCut = Math.max(0, globalMax - 3);
  for (let x = 0; x < COLS; x += 1) {
    const top = heights[x] ?? 0;
    let deepest = 0;
    let hasHole = false;
    for (let y = 0; y < top; y += 1) {
      if (((after[y] ?? 0) & (1 << x)) !== 0) continue;
      holes += 1;
      hasHole = true;
      const depth = top - y;
      if (depth > deepest) deepest = depth;
      if (y >= topCut) topHoles += 1;
      if (depth >= 2) deepHoles += 1;
    }
    if (hasHole) holeRows += 1;
  }
  return {
    heights,
    globalMax,
    middleMax,
    avgHeight: sum / COLS,
    holes,
    holeRows,
    topHoles,
    deepHoles,
  };
}

/**
 * Cold Clear-inspired incoming-garbage defense. Incoming rows shift the whole
 * stack up, so the relevant danger is `stackHeight + pending`, and any hole is
 * more expensive when it will be lifted toward the ceiling.
 */
export function v2GarbageDefense(stats: V2BoardStats, pendingAfter: number): number {
  if (pendingAfter <= 0) return 0;
  const danger = stats.globalMax + pendingAfter;
  let penalty = 0;
  if (danger >= 19) penalty += (danger - 18) * 420;
  else if (danger >= 15) penalty += (danger - 14) * 130;
  else if (danger >= 12) penalty += (danger - 11) * 42;
  penalty += stats.middleMax * pendingAfter * GARBAGE_MID_W;
  penalty += stats.topHoles * pendingAfter * GARBAGE_TOP_HOLE_W;
  penalty += stats.deepHoles * pendingAfter * GARBAGE_DEEP_HOLE_W;
  penalty += stats.middleMax * GARBAGE_MID_FLAT;
  return -penalty;
}

export const GARBAGE_MID_W = 6;
export const GARBAGE_MID_FLAT = 2;
export const GARBAGE_TOP_HOLE_W = 9;
export const GARBAGE_DEEP_HOLE_W = 3;

export interface V2OppModel {
  /** 0..~1.6 estimate of how much pressure the opponent is applying. */
  readonly danger: number;
  /** 1 when the opponent just whiffed and cannot cancel our next burst. */
  readonly vuln: number;
}

/**
 * Minimal opponent model from controller telemetry. The controller does not
 * expose the opponent board, but it does forward combo / b2b / last-attack
 * fields, which is enough to time bursts against a cancel window.
 */
export function v2OpponentModel(s: GameSnapshot): V2OppModel {
  const known = s.opponentLockId !== undefined;
  const lastRaw = s.opponentLastRawAttack ?? 0;
  const combo = s.opponentLastNativeCombo ?? s.opponentCombo ?? 0;
  const btbRaw = s.opponentLastNativeBtb ?? s.opponentBtb ?? 0;
  const btb = btbRaw > 0 ? 1 : 0;
  const danger = Math.min(1.6, lastRaw / 4 + combo / 4 + btb * 0.4);
  const clearLines = s.opponentLastClearLines;
  const whiffed = known && (clearLines === undefined || clearLines === 0);
  const vuln = whiffed && combo === 0 && btb === 0 ? 1 : 0;
  return { danger, vuln };
}
