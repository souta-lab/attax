/**
 * Native EvaluateAI.SearchPcBoard + lambdas (SPEC_EvaluateAI §3, binary 11618).
 * `usePCstack=false` disables lambda1; the `minHeight==-1` PcChance branch always
 * runs (gated only by `isEvenBoard`). `lambda2_searchPc` matches the native
 * per-piece geometry; `lambda3_pcSetup` is the O-lock inventory probe the C++
 * source omits.
 */

import { FULL_ROW } from "./board.js";
import type { GamePack } from "./gamepack.js";
import { MINO_I, MINO_J, MINO_L, MINO_O, type MinoType } from "./shapes.js";
import { WI, weightAt } from "./weight-index.js";

function searchPc(g: GamePack, m: MinoType): boolean {
  const line = (y: number): number => g.board.rowAt(y);
  const sh = g.board.stackHeight;
  if (m === MINO_I) {
    if (sh === 0) {
      for (let x = 0; x < 7; x += 1) if (((line(0) ^ (960 >> x)) | 0) === FULL_ROW) return true;
    } else if (sh === 3) {
      for (let x = 0; x < 10; x += 1) {
        if (((line(3) ^ (512 >> x)) | 0) === FULL_ROW) {
          const t = line(3);
          if (line(2) !== t || line(1) !== t || line(0) !== t) break;
          return true;
        }
      }
    }
  } else if (m === MINO_J) {
    if (sh === 1) {
      for (let x = 0; x < 8; x += 1) {
        if (((line(1) ^ (896 >> x)) | 0) === FULL_ROW) {
          if (((line(0) ^ (128 >> x)) | 0) !== FULL_ROW) break;
          return true;
        }
      }
      for (let x = 0; x < 8; x += 1) {
        if (((line(0) ^ (896 >> x)) | 0) === FULL_ROW) {
          if (((line(1) ^ (512 >> x)) | 0) !== FULL_ROW) break;
          return true;
        }
      }
    } else if (sh === 2) {
      for (let x = 0; x < 9; x += 1) {
        if (((line(2) ^ (768 >> x)) | 0) === FULL_ROW) {
          if (((line(1) ^ (512 >> x)) | 0) !== FULL_ROW) break;
          if (((line(0) ^ (512 >> x)) | 0) !== FULL_ROW) break;
          return true;
        }
      }
    }
  } else if (m === MINO_L) {
    if (sh === 1) {
      for (let x = 0; x < 8; x += 1) {
        if (((line(1) ^ (896 >> x)) | 0) === FULL_ROW) {
          if (((line(0) ^ (512 >> x)) | 0) !== FULL_ROW) break;
          return true;
        }
      }
      for (let x = 0; x < 8; x += 1) {
        if (((line(0) ^ (896 >> x)) | 0) === FULL_ROW) {
          if (((line(1) ^ (128 >> x)) | 0) !== FULL_ROW) break;
          return true;
        }
      }
    } else if (sh === 2) {
      for (let x = 0; x < 9; x += 1) {
        if (((line(2) ^ (768 >> x)) | 0) === FULL_ROW) {
          if (((line(1) ^ (256 >> x)) | 0) !== FULL_ROW) break;
          if (((line(0) ^ (256 >> x)) | 0) !== FULL_ROW) break;
          return true;
        }
      }
    }
  } else if (m === MINO_O) {
    if (sh === 1) {
      for (let x = 0; x < 9; x += 1) {
        if (((line(1) ^ (768 >> x)) | 0) === FULL_ROW) {
          if (((line(0) ^ (768 >> x)) | 0) !== FULL_ROW) break;
          return true;
        }
      }
    }
  } else if (m === 4) {
    if (sh === 1) {
      for (let x = 0; x < 8; x += 1) {
        if (((line(1) ^ (896 >> x)) | 0) === FULL_ROW) {
          if (((line(0) ^ (256 >> x)) | 0) !== FULL_ROW) break;
          return true;
        }
      }
    }
  } else if (m === 5) {
    if (sh === 1) {
      for (let x = 0; x < 8; x += 1) {
        if (((line(1) ^ (384 >> x)) | 0) === FULL_ROW) {
          if (((line(0) ^ (768 >> x)) | 0) !== FULL_ROW) break;
          return true;
        }
      }
    }
  } else if (m === 6) {
    if (sh === 1) {
      for (let x = 0; x < 8; x += 1) {
        if (((line(1) ^ (768 >> x)) | 0) === FULL_ROW) {
          if (((line(0) ^ (384 >> x)) | 0) !== FULL_ROW) break;
          return true;
        }
      }
    }
  }
  return false;
}

function pcSetup(g: GamePack): boolean {
  if (g.board.stackHeight > 1) return false;
  if (g.lockedMino.m !== MINO_O) return false;
  let cI = 0;
  let cJ = 0;
  let cL = 0;
  let cO = 1;
  switch (g.hold.m) {
    case MINO_O:
      cO = 2;
      break;
    case MINO_L:
      cL = 1;
      break;
    case MINO_J:
      cJ = 1;
      break;
    case MINO_I:
      cI = 1;
      break;
    default:
      break;
  }
  for (let i = 0; i < 4; i += 1) {
    switch (g.nextIt.getAt(i)) {
      case MINO_O:
        cO += 1;
        break;
      case MINO_L:
        cL += 1;
        break;
      case MINO_J:
        cJ += 1;
        break;
      case MINO_I:
        cI += 1;
        break;
      default:
        break;
    }
  }
  const v = g.lockedMino.x;
  const vOk = v !== 2 && v !== 3 && v !== 4;
  if (cI >= 1 && cJ >= 1 && cL >= 1 && cO >= 2) {
    return vOk ? g.board.rowAt(0) === (768 >> (v + 1)) : false;
  }
  if ((cI >= 2 && (cJ >= 2 || cL >= 2)) || (cJ >= 2 && cL >= 2)) {
    return vOk ? g.board.rowAt(0) === (768 >> (v + 1)) : false;
  }
  return false;
}

/** SearchPcBoard (SPEC_EvaluateAI §3); returns a weight term, not a boolean. */
export function searchPcBoard(
  g: GamePack,
  minHeight: number,
  ew: { readonly weight: readonly number[] },
  isEvenBoard: boolean,
): number {
  if (!isEvenBoard) return 0;
  if (minHeight === -1) {
    if (searchPc(g, g.fallingMino.m)) return weightAt(ew, WI.PcChance);
    if (g.fallingMino.m !== g.hold.m && searchPc(g, g.hold.m)) return weightAt(ew, WI.PcChance);
    if (pcSetup(g)) return weightAt(ew, WI.PcChance);
  }
  return 0;
}
