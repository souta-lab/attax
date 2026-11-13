/** Native Hoiko MinoType codes and PieceKind mapping (shared by the Rust adapter). */

import type { PieceKind } from "../../core/pieces.js";

export const MINO_I = 0;
export const MINO_J = 1;
export const MINO_L = 2;
export const MINO_O = 3;
export const MINO_T = 4;
export const MINO_S = 5;
export const MINO_Z = 6;
export const MINO_NONE = 7;

export type MinoType = number;

const MINO_BY_KIND: Readonly<Record<PieceKind, MinoType>> = {
  I: MINO_I,
  J: MINO_J,
  L: MINO_L,
  O: MINO_O,
  T: MINO_T,
  S: MINO_S,
  Z: MINO_Z,
};

export function kindToMino(kind: PieceKind): MinoType {
  return MINO_BY_KIND[kind];
}
