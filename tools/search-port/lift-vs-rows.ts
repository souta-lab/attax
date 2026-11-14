/**
 * Audit 2026-11-14 (b): concrete positions where planning with a scalar garbage `lift`
 * differs from planning on a board with the garbage rows actually inserted.
 * Measurement only — no change to the garbage model.
 *
 * Usage: bun tools/search-port/lift-vs-rows.ts
 */
import { boardFeatures } from "../../src/ai/bot/features.js";
import { type BitBoard, generatePlacements, lockPlacement } from "../../src/ai/bot/movegen.js";
import { search } from "../../src/ai/bot/search.js";
import { DEFAULT_WEIGHTS } from "../../src/ai/bot/weights.js";
import { attackForClear } from "../../src/core/garbage.js";

const FULL = 0x3ff;
/** 20-row engine board (index 0 = top); `rows` are the bottom rows, lowest last. */
function board(rows: number[], height = 20): Uint16Array {
  const b = new Uint16Array(height);
  rows.forEach((r, i) => {
    b[height - rows.length + i] = r;
  });
  return b;
}
/** What the engine does: shift the stack up and add `n` aligned garbage rows (hole `hole`). */
function insertGarbage(b: BitBoard, n: number, hole: number): Uint16Array {
  const out = new Uint16Array(b.length);
  for (let i = 0; i < b.length - n; i += 1) out[i] = b[i + n] as number;
  for (let i = b.length - n; i < b.length; i += 1) out[i] = FULL & ~(1 << hole);
  return out;
}
const show = (b: BitBoard) => {
  const first = b.findIndex((r) => r !== 0);
  return [...b]
    .slice(first < 0 ? b.length - 1 : first)
    .map((r) => `   ${[...Array(10)].map((_, x) => ((r >> x) & 1 ? "#" : ".")).join("")}`)
    .join("\n");
};

// --- A. Perfect clear on a board that still has garbage under it ----------------------
// Two half rows; pieces O, O. Hoiko-benchmark options (no guideline, width 48).
// Root pending 2: the first O cancels nothing, so 2 garbage rows land after it.
{
  const b = board([0x3f0, 0x3f0]);
  const r = search(
    {
      board: b,
      active: { kind: "O", rotation: 0, x: 3, y: 1 },
      hold: null,
      canHold: false,
      preview: ["O"],
      b2b: false,
      combo: -1,
      pending: 2,
    },
    { weights: DEFAULT_WEIGHTS, width: 48 },
  );
  console.log(`A. lift model, pending 2, queue O O, board:\n${show(b)}`);
  for (const s of r?.line ?? [])
    console.log(
      `   step ${s.placement.kind} x=${s.placement.x} y=${s.placement.y}: lines ${s.linesCleared}, attack ${s.attack}, reward ${s.reward.toFixed(1)}`,
    );
  // Same line, but with the 2 garbage rows inserted after the first lock.
  const first = r?.line[0];
  const second = r?.line[1];
  if (first && second) {
    const afterFirst = lockPlacement(b, first.placement).board;
    const lifted = insertGarbage(afterFirst, 2, 0);
    const s2 = { ...second.placement, y: second.placement.y - 2 };
    const out = lockPlacement(lifted, s2);
    const attack = attackForClear({
      lines: out.linesCleared,
      tspinLines: 0,
      combo: 0,
      b2bActive: false,
      perfectClear: out.perfectClear,
      tspinKind: "none",
    });
    console.log(
      `   inserted rows: same second placement -> lines ${out.linesCleared}, perfectClear ${out.perfectClear}, attack ${attack}; board left:\n${show(out.board)}`,
    );
  }
}

// --- B. Reachability / top-out under a tall stack ------------------------------------
// A two-wide wall at columns 4-5 of height h on a 20-row board, then `lift` garbage rows.
// h + lift < 20, so the lift model's top-out test (maxHeight >= rows) calls it alive.
for (const [h, lift] of [
  [16, 2],
  [17, 2],
  [15, 3],
] as const) {
  const rows: number[] = [];
  for (let i = 0; i < h; i += 1) rows.push(0x030);
  const b = board(rows);
  const lifted = insertGarbage(b, lift, 0);
  const f = boardFeatures(b, lift);
  const parts: string[] = [];
  for (const kind of ["I", "O", "T", "L", "J", "S", "Z"] as const) {
    const unl = generatePlacements(b, kind);
    const lif = generatePlacements(lifted, kind);
    parts.push(`${kind} ${unl.length}->${lif.length}`);
  }
  console.log(
    `B. wall h=${h}, lift ${lift} (lift-model maxHeight ${f.maxHeight} < 20): placements lift-model -> inserted rows: ${parts.join(", ")}`,
  );
}

// --- C. Holes over the garbage well ---------------------------------------------------
{
  const b = board([0x001, 0x3fe]); // a block over column 0 sitting on a row
  const lifted = insertGarbage(b, 2, 0);
  console.log(
    `C. holes: lift model ${boardFeatures(b, 2).holes}, inserted rows ${boardFeatures(lifted, 0).holes} (the stack covers the aligned garbage well at column 0)`,
  );
}
