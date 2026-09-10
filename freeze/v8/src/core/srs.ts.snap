import type { PieceKind } from "./pieces.js";

export type Rotation = 0 | 1 | 2 | 3;

export interface Kick {
  readonly dx: number;
  readonly dy: number;
}

type KickTable = Readonly<Record<string, readonly Kick[]>>;

const JLSTZ: KickTable = {
  "0>1": [
    { dx: 0, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: -1, dy: 1 },
    { dx: 0, dy: -2 },
    { dx: -1, dy: -2 },
  ],
  "1>0": [
    { dx: 0, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: 1, dy: -1 },
    { dx: 0, dy: 2 },
    { dx: 1, dy: 2 },
  ],
  "1>2": [
    { dx: 0, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: 1, dy: -1 },
    { dx: 0, dy: 2 },
    { dx: 1, dy: 2 },
  ],
  "2>1": [
    { dx: 0, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: -1, dy: 1 },
    { dx: 0, dy: -2 },
    { dx: -1, dy: -2 },
  ],
  "2>3": [
    { dx: 0, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: 1, dy: 1 },
    { dx: 0, dy: -2 },
    { dx: 1, dy: -2 },
  ],
  "3>2": [
    { dx: 0, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: -1, dy: -1 },
    { dx: 0, dy: 2 },
    { dx: -1, dy: 2 },
  ],
  "3>0": [
    { dx: 0, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: -1, dy: -1 },
    { dx: 0, dy: 2 },
    { dx: -1, dy: 2 },
  ],
  "0>3": [
    { dx: 0, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: 1, dy: 1 },
    { dx: 0, dy: -2 },
    { dx: 1, dy: -2 },
  ],
};

const I_KICKS: KickTable = {
  "0>1": [
    { dx: 0, dy: 0 },
    { dx: -2, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: -2, dy: -1 },
    { dx: 1, dy: 2 },
  ],
  "1>0": [
    { dx: 0, dy: 0 },
    { dx: 2, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 2, dy: 1 },
    { dx: -1, dy: -2 },
  ],
  "1>2": [
    { dx: 0, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 2, dy: 0 },
    { dx: -1, dy: 2 },
    { dx: 2, dy: -1 },
  ],
  "2>1": [
    { dx: 0, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: -2, dy: 0 },
    { dx: 1, dy: -2 },
    { dx: -2, dy: 1 },
  ],
  "2>3": [
    { dx: 0, dy: 0 },
    { dx: 2, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 2, dy: 1 },
    { dx: -1, dy: -2 },
  ],
  "3>2": [
    { dx: 0, dy: 0 },
    { dx: -2, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: -2, dy: -1 },
    { dx: 1, dy: 2 },
  ],
  "3>0": [
    { dx: 0, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: -2, dy: 0 },
    { dx: 1, dy: -2 },
    { dx: -2, dy: 1 },
  ],
  "0>3": [
    { dx: 0, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 2, dy: 0 },
    { dx: -1, dy: 2 },
    { dx: 2, dy: -1 },
  ],
};

const NO_KICK: readonly Kick[] = [{ dx: 0, dy: 0 }];

export function kickTable(kind: PieceKind, from: Rotation, to: Rotation): readonly Kick[] {
  const key = `${from}>${to}`;
  if (kind === "O") return NO_KICK;
  if (kind === "I") return I_KICKS[key] ?? NO_KICK;
  return JLSTZ[key] ?? NO_KICK;
}

export function isTspinKick(kind: PieceKind, kickIndex: number): boolean {
  if (kind !== "T") return false;
  return kickIndex === 4;
}

export function asRotation(n: number): Rotation {
  return ((n % 4) + 4) % 4 as Rotation;
}
