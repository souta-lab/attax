/**
 * Adopt candidates (ADOPT-SURVEY-2026-11-15 §4): each new term defaults to 0 / off, and off
 * must be bit-identical to the search without it. These tests pin both halves: the off
 * identity (absent vs explicit 0 vs DEFAULT_WEIGHTS) and the term's mechanics when on.
 */
import { describe, expect, test } from "bun:test";
import { spawnPosition } from "../src/ai/bot/movegen.js";
import { type SearchInput, search } from "../src/ai/bot/search.js";
import { DEFAULT_WEIGHTS, type Weights } from "../src/ai/bot/weights.js";
import type { PieceKind } from "../src/core/pieces.js";

const FULL = 0x3ff;

/** Engine row order (index 0 = top). `rows` lists the bottom rows, lowest last. */
function board(...rows: number[]): Uint16Array {
  const b = new Uint16Array(40);
  rows.forEach((r, i) => {
    b[40 - rows.length + i] = r;
  });
  return b;
}

function input(
  b: Uint16Array,
  kind: PieceKind,
  preview: PieceKind[],
  extra: Partial<SearchInput> = {},
): SearchInput {
  return {
    board: b,
    active: { kind, ...spawnPosition(kind, b.length) },
    hold: null,
    canHold: true,
    preview,
    b2b: false,
    combo: -1,
    pending: 0,
    ...extra,
  };
}

/** A mid-game stack with a TSD slot, a hole and a well, so most terms are live. */
const MIDGAME = board(
  0b0000000000,
  0b1000000000,
  0b1100000001,
  0b1110000011,
  0b1111000111,
  0b1101101111,
  FULL ^ 0b10,
  FULL ^ 0b100,
);

const withoutKey = (key: keyof Weights): Weights => {
  const copy: Record<string, unknown> = { ...DEFAULT_WEIGHTS };
  delete copy[key];
  return copy as unknown as Weights;
};

function same(a: unknown, b: unknown) {
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
}

describe("C1 terminal B2B-alive state value (b2bState)", () => {
  test("default is 0", () => {
    expect(DEFAULT_WEIGHTS.b2bState).toBe(0);
  });

  for (const b2b of [false, true]) {
    for (const speculate of [false, true]) {
      test(`absent, explicit 0 and DEFAULT are bit-identical (b2b=${b2b}, chance=${speculate})`, () => {
        const i = input(MIDGAME, "T", ["I", "L", "O"], {
          b2b,
          speculativePieces: speculate ? ["S", "Z", "J"] : [],
        });
        const options = { width: 24, guideline: true };
        const base = search(i, { ...options, weights: DEFAULT_WEIGHTS });
        same(search(i, { ...options, weights: withoutKey("b2bState") }), base);
        same(search(i, { ...options, weights: { ...DEFAULT_WEIGHTS, b2bState: 0 } }), base);
      });
    }
  }

  test("adds gamma * b2bState to every line that ends with B2B alive", () => {
    // B2B already active and one piece on an empty board: no placement clears, so every
    // child keeps B2B and every root value moves by discount * b2bState.
    const i = input(new Uint16Array(40), "J", [], { b2b: true, canHold: false });
    const off = search(i, { weights: DEFAULT_WEIGHTS, width: 64 });
    const on = search(i, { weights: { ...DEFAULT_WEIGHTS, b2bState: 100 }, width: 64 });
    if (off === null || on === null) throw new Error("no move");
    expect(on.candidates.length).toBe(off.candidates.length);
    expect(on.best).toEqual(off.best);
    for (const [k, c] of on.candidates.entries())
      expect(c.value - (off.candidates[k]?.value as number)).toBeCloseTo(97, 9);
  });

  test("no effect where no line has B2B", () => {
    const i = input(new Uint16Array(40), "J", ["L"], { b2b: false });
    const options = { width: 64 };
    same(
      search(i, { ...options, weights: { ...DEFAULT_WEIGHTS, b2bState: 100 } }),
      search(i, { ...options, weights: DEFAULT_WEIGHTS }),
    );
  });

  test("a large B2B value keeps the chain over a plain clear", () => {
    // B2B active; an I can take a plain single in the open column (breaking B2B) or stack.
    // Without the term the single is attractive enough to take; a strong B2B state value
    // must make the bot keep the chain.
    const b = board(FULL ^ 0b1);
    const i = input(b, "I", [], { b2b: true, canHold: false });
    const breaksChain = (w: Weights) => {
      const r = search(i, { weights: w, width: 64 });
      if (r === null) throw new Error("no move");
      return r.best.linesCleared > 0;
    };
    const generous = { ...DEFAULT_WEIGHTS, clear: { ...DEFAULT_WEIGHTS.clear, single: 500 } };
    expect(breaksChain(generous)).toBe(true);
    expect(breaksChain({ ...generous, b2bState: 5000 })).toBe(false);
  });
});

/** Every adopt term switched on (extended as candidates land). */
const ADOPT_ON: Weights = { ...DEFAULT_WEIGHTS, b2bState: 100 };

describe("unified tree: adopt terms are guideline-only", () => {
  // Item 97 chunk 4 ports the adopt terms onto the shared search's guideline path. The S2
  // profile (expandS2) keeps its own terminal bracket (dot + Φ − risk) in this lane, so
  // turning the adopt weights on must leave every S2 result bit-identical.
  for (const b2b of [false, true]) {
    test(`s2 profile ignores the adopt weights (b2b=${b2b})`, () => {
      const i = input(MIDGAME, "T", ["I", "L", "O"], {
        b2b,
        hold: "T",
        speculativePieces: ["S", "Z", "J"],
      });
      const options = { width: 24, profile: "s2" as const };
      same(
        search(i, { ...options, weights: ADOPT_ON }),
        search(i, { ...options, weights: DEFAULT_WEIGHTS }),
      );
    });
  }
});
