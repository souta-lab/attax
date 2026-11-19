import type { PieceKind } from "./pieces.js";
import type { TspinKind } from "./tspin.js";

export interface SpinPlacement {
  readonly kind: PieceKind;
  readonly rotation: number;
  /** Top-left of the engine's 3x3 T box, in top-down coordinates. */
  readonly x: number;
  readonly y: number;
  /** 0 = no rotation evidence; 1..5 = successful quarter-turn kick ordinal. */
  readonly lastSrs: number;
}

/** S2-SPEC: Spin detection: All-Mini versus All-Mini+ (post-1.5 All-Mini+). */
export function classifyS2Spin(
  a: SpinPlacement,
  occupied: (x: number, y: number) => boolean,
  canTranslate: (dx: number, dy: number) => boolean,
): TspinKind {
  if (a.lastSrs === 0) return "none";
  if (a.kind === "T") {
    const corners = [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ] as const;
    const filled = corners.map(([dx, dy]) => occupied(a.x + dx, a.y + dy));
    if (filled.filter(Boolean).length >= 3) {
      const r = ((a.rotation % 4) + 4) % 4;
      return (filled[r] && filled[(r + 1) % 4]) || a.lastSrs === 5 ? "full" : "mini";
    }
  }
  return [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ].every(([dx, dy]) => !canTranslate(dx ?? 0, dy ?? 0))
    ? "mini"
    : "none";
}

// TODO S2-SPEC Unpinned #5: failed inputs, zero/moving hard drop, 180 kick IDs,
// and executable T immobility precedence fixtures. Existing input history is provisional.
