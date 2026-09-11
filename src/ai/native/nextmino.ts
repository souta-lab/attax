/**
 * Native NextMino / NextIterator (SPEC_Search §4, binary IL 6529-6685).
 *
 * Binary bag: `bag.remains` starts at 6; `pick(remains)` maps 6->Z, 5->S,
 * 4->T, 3->O, 2->J, 1->L, 0->I; then remains -= 1 and resets to 6 below 0.
 * `m[28]` therefore holds the repeating bag [Z,S,T,O,J,L,I].
 * `Compare(0, realNext)` pins m[0..viewNext-1] to the observable queue and
 * sets `trustEnd = (viewNext-1) + trustRange(bagRemains)`.
 */

import { MINO_I, MINO_J, MINO_L, MINO_NONE, MINO_O, MINO_S, MINO_T, MINO_Z, type MinoType } from "./shapes.js";

export const NEXT_SIZE = 28;

export function trustRange(remains: number): number {
  switch (remains) {
    case 6:
      return 2;
    case 5:
      return 1;
    case 4:
    case 3:
    case 2:
    case 1:
      return 0;
    case 0:
      return 3;
    default:
      return 0;
  }
}

function bagPick(remains: number): MinoType {
  switch (remains) {
    case 6:
      return MINO_Z;
    case 5:
      return MINO_S;
    case 4:
      return MINO_T;
    case 3:
      return MINO_O;
    case 2:
      return MINO_J;
    case 1:
      return MINO_L;
    case 0:
      return MINO_I;
    default:
      return MINO_NONE;
  }
}

export class NextMino {
  readonly m: MinoType[] = new Array<MinoType>(NEXT_SIZE).fill(MINO_NONE);
  trustEnd = 0;
  bagRemains = 6;
  viewNext = 2;

  init(realNext: readonly MinoType[]): void {
    this.bagRemains = 6;
    for (let i = 0; i < NEXT_SIZE; i += 1) {
      this.m[i] = bagPick(this.bagRemains);
      this.bagRemains -= 1;
      if (this.bagRemains < 0) this.bagRemains = 6;
    }
    this.compare(0, realNext);
  }

  at(i: number): MinoType {
    return this.m[i] ?? MINO_NONE;
  }

  compare(cmpFirst: number, nx: readonly MinoType[]): void {
    for (let i = 0; i < this.viewNext; i += 1) {
      const target = nx[i] ?? MINO_NONE;
      if (this.at(cmpFirst + i) !== target) this.swap(cmpFirst + i, target);
    }
    this.trustEnd = this.viewNext - 1 + trustRange(this.bagRemains);
  }

  private swap(cmpedIndex: number, nx: MinoType): void {
    for (let i = cmpedIndex + 1; i < NEXT_SIZE; i += 1) {
      if (this.at(i) === nx) {
        for (; i > cmpedIndex; i -= 1) this.m[i] = this.at(i - 1);
        this.m[cmpedIndex] = nx;
        return;
      }
    }
    this.m[cmpedIndex] = nx;
  }

  shiftNext(): void {
    for (let i = 0; i < NEXT_SIZE - 1; i += 1) this.m[i] = this.at(i + 1);
    this.m[NEXT_SIZE - 1] = bagPick(this.bagRemains);
    this.bagRemains -= 1;
    if (this.bagRemains < 0) this.bagRemains = 6;
  }
}

/** Pointer-pair iterator (`{m, trustEnd}`) over the shared NextMino array. */
export class NextIterator {
  base = 0;
  trustEnd = 0;
  private source: NextMino | null = null;

  setSource(next: NextMino): void {
    this.source = next;
    this.base = 0;
    this.trustEnd = next.trustEnd;
  }

  get(): MinoType {
    return this.source?.at(this.base) ?? MINO_NONE;
  }

  getAt(i: number): MinoType {
    return this.source?.at(this.base + i) ?? MINO_NONE;
  }

  advance(): void {
    this.base += 1;
  }

  /** IsTrustNext: base + i <= trustEnd (absolute pointer comparison). */
  isTrustNext(i: number): boolean {
    return this.base + i <= this.trustEnd;
  }

  copyFrom(other: NextIterator): void {
    this.source = other.source;
    this.base = other.base;
    this.trustEnd = other.trustEnd;
  }
}
