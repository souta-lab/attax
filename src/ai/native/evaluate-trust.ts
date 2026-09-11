/** EvaluateAI shared `trustNext` lambda (SPEC_EvaluateAI §5.1, binary 12706). */

import type { GamePack } from "./gamepack.js";
import { MINO_T } from "./shapes.js";

export function trustNext(g: GamePack): number {
  if (g.hold.m === MINO_T) {
    let result = 1;
    for (let i = 0; i < 7; i += 1) {
      if (g.nextIt.getAt(i) === MINO_T) {
        result = 2;
        break;
      }
    }
    return result;
  }
  let i = 0;
  while (g.nextIt.getAt(i) !== MINO_T) {
    i += 1;
    if (i >= 6) return 0;
  }
  if (!g.nextIt.isTrustNext(i)) return 0;
  let result = 1;
  for (let j = i + 1; j < i + 1 + 6; j += 1) {
    if (g.nextIt.getAt(j) === MINO_T) {
      result = 2;
      break;
    }
  }
  return result;
}
