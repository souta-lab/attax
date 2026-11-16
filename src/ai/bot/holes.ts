/** C3 garbage-aligned hole geometry for the S2 terminal evaluator. */
import type { BitBoard } from "./movegen.js";

export interface HoleGeometry {
  readonly runs: number;
  readonly shifts: number;
}

/**
 * Count vertical runs of covered empty cells and changes between successive nonempty hole
 * masks. Rows are in engine order (top first); bits identify columns.
 */
export function holeGeometry(board: BitBoard): HoleGeometry {
  let covered = 0;
  let previousHoles = 0;
  let previousMask = -1;
  let runs = 0;
  let shifts = 0;
  for (let row = 0; row < board.length; row += 1) {
    const holes = covered & ~(board[row] as number);
    let fresh = holes & ~previousHoles;
    while (fresh !== 0) {
      runs += 1;
      fresh &= fresh - 1;
    }
    if (holes !== 0) {
      if (previousMask !== -1 && holes !== previousMask) shifts += 1;
      previousMask = holes;
    }
    previousHoles = holes;
    covered |= board[row] as number;
  }
  return { runs, shifts };
}
