/**
 * Native `NextMino` state machine — the persistent queue the versus game
 * mutates once per piece through `RootNode.SetPPTData` (IL 7045):
 * `NextMino.ShiftNext` consumes one piece, `NextMino.Compare(0, live)` re-pins
 * the first `viewNext` entries, and
 * `trustEnd = viewNext - 1 + trustRange(bagRemains)` (IL 6567-6599).
 *
 * The versus harness rebuilds the search root from the live snapshot every
 * turn, so it must carry this state explicitly; otherwise `bagRemains` resets
 * to 6 and the engine trusts a different bag tail than the real game (the
 * exe oracle changes its first move for 13/13 probe positions when the carry
 * state changes — see `evidence/hoiko-inputs/nextcarry/`).
 */

import { MINO_NONE, type MinoType } from "./mino-codes.js";

export const NEXT_SIZE = 28;
export const BAG_START = 6;
const DEFAULT_VIEW_NEXT = 2;

export function trustRange(remains: number): number {
  switch (remains) {
    case 6:
      return 2;
    case 5:
      return 1;
    case 0:
      return 3;
    default:
      return 0;
  }
}

function bagPick(remains: number): MinoType {
  switch (remains) {
    case 6:
      return 6;
    case 5:
      return 5;
    case 4:
      return 4;
    case 3:
      return 3;
    case 2:
      return 1;
    case 1:
      return 2;
    case 0:
      return 0;
    default:
      return MINO_NONE;
  }
}

export class NextState {
  readonly m: MinoType[];
  trustEnd = 0;
  bagRemains = BAG_START;
  readonly viewNext: number;

  constructor(viewNext: number = DEFAULT_VIEW_NEXT) {
    this.viewNext = viewNext;
    this.m = new Array<MinoType>(NEXT_SIZE).fill(MINO_NONE);
  }

  init(realNext: readonly MinoType[]): void {
    this.bagRemains = BAG_START;
    for (let i = 0; i < NEXT_SIZE; i += 1) {
      this.m[i] = bagPick(this.bagRemains);
      this.bagRemains -= 1;
      if (this.bagRemains < 0) this.bagRemains = BAG_START;
    }
    this.compare(0, realNext);
  }

  at(index: number): MinoType {
    const value = this.m[index];
    return value === undefined ? MINO_NONE : value;
  }

  compare(cmpFirst: number, nx: readonly MinoType[]): void {
    for (let i = 0; i < this.viewNext; i += 1) {
      const target = nx[i] ?? MINO_NONE;
      if (this.at(cmpFirst + i) !== target) this.swap(cmpFirst + i, target);
    }
    this.trustEnd = this.viewNext - 1 + trustRange(this.bagRemains);
  }

  shiftNext(): void {
    for (let i = 0; i < NEXT_SIZE - 1; i += 1) this.m[i] = this.at(i + 1);
    this.m[NEXT_SIZE - 1] = bagPick(this.bagRemains);
    this.bagRemains -= 1;
    if (this.bagRemains < 0) this.bagRemains = BAG_START;
  }

  private swap(cmpedIndex: number, nx: MinoType): void {
    for (let i = cmpedIndex + 1; i < NEXT_SIZE; i += 1) {
      if (this.at(i) !== nx) continue;
      for (let j = i; j > cmpedIndex; j -= 1) this.m[j] = this.at(j - 1);
      this.m[cmpedIndex] = nx;
      return;
    }
    this.m[cmpedIndex] = nx;
  }
}
