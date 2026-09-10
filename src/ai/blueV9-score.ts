import type { Board } from "../core/board.js";
import { blueV8CountHoles, blueV8Heights, blueV8Veto } from "./blueV8-score.js";

/** Unrecoverable stack: many holes + very tall while garbage is still queued. */
export function blueV9Hopeless(after: Board, h: readonly number[], pending: number): boolean {
  if (pending <= 0) return false;
  let max = 0;
  for (const v of h) if (v > max) max = v;
  return blueV8CountHoles(after, h) >= 10 && max >= 14;
}

/**
 * Permissive dig veto. While garbage is pending (or the root stack is already
 * tall) every non-T placement is allowed so the AI can always dig itself out;
 * the only veto that can fire is a genuinely hopeless T-spin setup.
 */
export function blueV9Veto(
  after: Board,
  lines: number,
  pending: number,
  tspin: boolean,
  tallBoard: boolean,
): boolean {
  if (lines > 0) return false;
  if (tallBoard || pending > 0) {
    const h = blueV8Heights(after);
    if (tspin && blueV9Hopeless(after, h, pending)) return true;
    return false;
  }
  return blueV8Veto(after, lines, pending, tspin);
}
