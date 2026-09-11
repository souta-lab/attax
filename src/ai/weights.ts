/** DU-controller weights (35M lines). Score = dot(w, features). */

import type { FeatureVector, FireFeatures } from "./features.js";

export interface Weights {
  readonly landingHeight: number;
  readonly erodedCells: number;
  readonly rowTransitions: number;
  readonly colTransitions: number;
  readonly holes: number;
  readonly wells: number;
  readonly holeDepth: number;
  readonly rowsWithHoles: number;
  readonly bumpiness: number;
  readonly maxHeight: number;
  readonly linesCleared: number;
}

export interface FireWeights {
  readonly tetris: number;
  readonly tspin: number;
  readonly tspinSingle: number;
  readonly tspinDouble: number;
  readonly tspinTriple: number;
  readonly b2bBonus: number;
  readonly comboStep: number;
  readonly perfectClear: number;
}

export const DU_WEIGHTS: Weights = {
  landingHeight: -4.5,
  erodedCells: 3.4,
  rowTransitions: -3.2,
  colTransitions: -9.35,
  holes: -13.0,
  wells: -10.0,
  holeDepth: -2.0,
  rowsWithHoles: -24.0,
  bumpiness: -1.5,
  maxHeight: -3.0,
  linesCleared: 200,
} as const;

export const FIRE_WEIGHTS: FireWeights = {
  tetris: 390,
  tspin: 121,
  tspinSingle: 0,
  tspinDouble: 289,
  tspinTriple: 481,
  b2bBonus: 104,
  comboStep: 150,
  perfectClear: 999,
} as const;

export function scoreFeatures(f: FeatureVector, w: Weights = DU_WEIGHTS): number {
  return (
    f.landingHeight * w.landingHeight +
    f.erodedCells * w.erodedCells +
    f.rowTransitions * w.rowTransitions +
    f.colTransitions * w.colTransitions +
    f.holes * w.holes +
    f.wells * w.wells +
    f.holeDepth * w.holeDepth +
    f.rowsWithHoles * w.rowsWithHoles +
    f.bumpiness * w.bumpiness +
    f.maxHeight * w.maxHeight
  );
}

export function scorePlacement(
  f: FeatureVector,
  linesCleared: number,
  w: Weights = DU_WEIGHTS,
): number {
  return scoreFeatures(f, w) + linesCleared * w.linesCleared;
}

export function scoreFire(f: FireFeatures, w: FireWeights = FIRE_WEIGHTS): number {
  return (
    (f.isTetris ? w.tetris : 0) +
    (f.isTspin ? w.tspin : 0) +
    (f.isTspinSingle ? w.tspinSingle : 0) +
    (f.isTspinDouble ? w.tspinDouble : 0) +
    (f.isTspinTriple ? w.tspinTriple : 0) +
    (f.b2bBonus ? w.b2bBonus : 0) +
    f.comboCount * w.comboStep +
    (f.isPerfectClear ? w.perfectClear : 0)
  );
}
