/** Sanity of the bot's evaluation and search: it should value what it is meant to value. */
import { describe, expect, test } from "bun:test";
import { boardFeatures } from "../src/ai/bot/features.js";
import { createBot } from "../src/ai/bot/fighter.js";
import { spawnPosition } from "../src/ai/bot/movegen.js";
import { search } from "../src/ai/bot/search.js";
import { DEFAULT_WEIGHTS } from "../src/ai/bot/weights.js";
import { resolveFaithfulHoikoOptions } from "../src/ai/hoiko/faithful.js";
import { runMatch } from "../src/bench/match.js";
import type { PieceKind } from "../src/core/pieces.js";
import { createArena } from "../src/sim/arena.js";
import { createHoiko } from "../tools/hoiko-node.js";

const FULL = 0x3ff;

/** Engine row order (index 0 = top). `rows` lists the bottom rows, lowest last. */
function board(...rows: number[]): Uint16Array {
  const b = new Uint16Array(20);
  rows.forEach((r, i) => {
    b[20 - rows.length + i] = r;
  });
  return b;
}

function best(b: Uint16Array, kind: PieceKind, preview: PieceKind[] = []) {
  const result = search(
    {
      board: b,
      active: { kind, ...spawnPosition(kind) },
      hold: null,
      canHold: false,
      preview,
      b2b: false,
      combo: -1,
      pending: 0,
    },
    { weights: DEFAULT_WEIGHTS, width: 32 },
  );
  if (result === null) throw new Error("no move");
  return result;
}

describe("board features", () => {
  test("count holes, hole rows and cover", () => {
    // Column 0: two blocks stacked over two empty cells; column 1 is open from above.
    const f = boardFeatures(board(0b1, 0b1, 0, 0, FULL ^ 0b10), 0);
    expect(f.holes).toBe(2);
    expect(f.holeRows).toBe(2);
    expect(f.holeCover).toBe(4);
  });

  test("garbage that will land counts toward height and danger", () => {
    const b = board(
      FULL ^ 1,
      FULL ^ 1,
      FULL ^ 1,
      FULL ^ 1,
      FULL ^ 1,
      FULL ^ 1,
      FULL ^ 1,
      FULL ^ 1,
      FULL ^ 1,
      FULL ^ 1,
    );
    expect(boardFeatures(b, 0).danger).toBe(0);
    expect(boardFeatures(b, 4).maxHeight).toBe(14);
    expect(boardFeatures(b, 4).danger).toBe(16);
  });

  test("recognises a ready T-spin double slot", () => {
    // Stem hole at column 4, flat row open at 3-5, roof over column 3.
    const slot = board(0b0000001111, FULL ^ (0b111 << 3), FULL ^ (1 << 4));
    expect(boardFeatures(slot, 0).tSlot).toBe(2);
    const open = board(FULL ^ (0b111 << 3), FULL ^ (1 << 4));
    expect(boardFeatures(open, 0).tSlot).toBe(0);
  });
});

describe("search", () => {
  test("spins a T into a ready T-spin double", () => {
    const slot = board(0b0000001111, FULL ^ (0b111 << 3), FULL ^ (1 << 4));
    const r = best(slot, "T");
    expect(r.best.placement.tspin).toBe("full");
    expect(r.best.linesCleared).toBe(2);
    expect(r.best.attack).toBe(4);
  });

  test("burns an I into a four-deep well", () => {
    const well = board(FULL ^ 1, FULL ^ 1, FULL ^ 1, FULL ^ 1);
    const r = best(well, "I");
    expect(r.best.linesCleared).toBe(4);
  });

  test("does not bury a hole when a clean placement exists", () => {
    const flat = board(FULL ^ 0b11);
    const r = best(flat, "O");
    expect(r.best.linesCleared).toBe(1);
  });

  test("reports candidates best-first with the chosen move on top", () => {
    const r = best(board(), "T", ["I", "O"]);
    expect(r.candidates.length).toBeGreaterThan(3);
    expect(r.candidates[0]?.value).toBe(r.value);
    for (let i = 1; i < r.candidates.length; i += 1) {
      expect((r.candidates[i - 1]?.value ?? 0) >= (r.candidates[i]?.value ?? 0)).toBe(true);
    }
  });
});

describe("live arena", () => {
  test("replays a benchmark game move for move", () => {
    const hoikoOptions = resolveFaithfulHoikoOptions({ HOIKO_ADAPT: "0" });
    const seed = 1001;
    const recorded = runMatch(createBot(), createHoiko(hoikoOptions), seed);
    const arena = createArena(createBot(), createHoiko(hoikoOptions), seed, "left");
    while (arena.step(50)) {
      // keep stepping until decided
    }
    const live = arena.frame();
    expect(live.winner).toBe(recorded.winner === "cap" ? null : recorded.winner);
    expect(live.ticks).toBe(recorded.ticks);
    expect(live.left.sent).toBe(recorded.left.sent);
    expect(live.right.sent).toBe(recorded.right.sent);
  }, 120_000);
});
