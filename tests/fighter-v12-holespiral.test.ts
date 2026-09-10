import { describe, expect, test } from "bun:test";
import { beamBestMove } from "../src/ai/beam.js";
import { blueV8CountHoles, blueV8Heights } from "../src/ai/blueV8-score.js";

const FULL = 0x3ff;

// Flat stack (heights 5 everywhere except a col-9 well, so no row is full
// and no placement can clear except on lineBoard): rows 0-4 filled except
// col 9; row 1 cols 0-6 carved (7 holes); plus row 0 cols 7, 8, 0 for the
// 10-hole case. Row 4 stays full over every carve so heights stay equal.
function holedBoard(holes: 7 | 10): Uint16Array {
  const b = new Uint16Array(20);
  for (let y = 0; y <= 4; y += 1) b[y] = FULL & ~0x200;
  let row1 = FULL & ~0x200;
  for (let x = 0; x <= 6; x += 1) row1 &= ~(1 << x);
  b[1] = row1;
  if (holes === 10) {
    let row0 = FULL & ~0x200;
    for (const x of [7, 8, 0]) row0 &= ~(1 << x);
    b[0] = row0;
  }
  return b;
}

// Same holed stack with row 5 one O-placement away from a single line clear.
function lineBoard(holes: 7 | 10): Uint16Array {
  const b = holedBoard(holes);
  b[5] = FULL & ~0x3;
  return b;
}

function countHoles(after: Uint16Array): number {
  return blueV8CountHoles(after, blueV8Heights(after));
}

describe("REVERT-v12-holespiral", () => {
  test("seam: fighterA does not expose the reverted HOLE_SPIRAL_STEP", async () => {
    const mod = (await import("../src/ai/fighterA.js")) as Record<string, unknown>;
    expect(mod["HOLE_SPIRAL_STEP"]).toBeUndefined();
  });

  test("black-box quiet pair: deterministic 7 vs 10-hole observation", () => {
    const mv7 = beamBestMove(holedBoard(7), "O", ["O", "O"], null, false, false, -1, {
      depth: 1,
    });
    const mv10 = beamBestMove(holedBoard(10), "O", ["O", "O"], null, false, false, -1, {
      depth: 1,
    });
    if (mv7 === null || mv10 === null) throw new Error("no quiet O move found");
    expect(mv7.linesCleared).toBe(0);
    expect(mv10.linesCleared).toBe(0);
    expect(mv7.isTspin).toBe(false);
    expect(mv10.isTspin).toBe(false);
    expect(countHoles(mv7.after)).toBe(7);
    expect(countHoles(mv10.after)).toBe(10);
    // Same placement chosen on both boards; the 10-hole board scores lower.
    expect(mv7.x).toBe(mv10.x);
    expect(mv7.score - mv10.score).toBeGreaterThan(0);
  });

  test("black-box line pair: clears stay comparable", () => {
    const l7 = beamBestMove(lineBoard(7), "O", ["O", "O"], null, false, false, -1, {
      depth: 1,
    });
    const l10 = beamBestMove(lineBoard(10), "O", ["O", "O"], null, false, false, -1, {
      depth: 1,
    });
    if (l7 === null || l10 === null) throw new Error("no line-clear O move found");
    expect(l7.linesCleared).toBe(1);
    expect(l10.linesCleared).toBe(1);
    expect(l7.isTspin).toBe(false);
    expect(l10.isTspin).toBe(false);
    expect(countHoles(l7.after)).toBe(7);
    expect(countHoles(l10.after)).toBe(10);
    expect(l7.score - l10.score).toBeGreaterThan(0);
  });

  test("black-box tspin seam: tspin placements are observable", () => {
    const slot = new Uint16Array(20);
    slot[3] = 0x7f;
    slot[0] = 0x3ff;
    const seen: Array<{ readonly lines: number; readonly tspin: boolean }> = [];
    const mv = beamBestMove(slot, "T", ["I", "O"], null, false, false, -1, {
      depth: 1,
      useKick: true,
      scorer: (_after, lines, tspin) => {
        seen.push({ lines, tspin });
        return 0;
      },
    });
    expect(mv).not.toBeNull();
    expect(seen.some((s) => s.tspin && s.lines > 0)).toBe(true);
  });
});
