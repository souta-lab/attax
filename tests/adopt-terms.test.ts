/**
 * Adopt candidates (ADOPT-SURVEY-2026-11-15 §4): each new term defaults to 0 / off, and off
 * must be bit-identical to the search without it. These tests pin both halves: the off
 * identity (absent vs explicit 0 vs DEFAULT_WEIGHTS) and the term's mechanics when on.
 */
import { describe, expect, test } from "bun:test";
import { tSlotDonations } from "../src/ai/bot/features.js";
import { spawnPosition } from "../src/ai/bot/movegen.js";
import { adoptContext, type SearchInput, search, tAvailable } from "../src/ai/bot/search.js";
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

describe("unified tree: adopt C2/C4 terms are guideline-only", () => {
  // Item 97 chunk 4 ports the adopt terms onto the shared search. The C2 (tSlotChain)
  // and C4 (holdT/holdI) terms live only in the guideline path, so turning them on must
  // leave every S2 result bit-identical. The C1 term is the exception by design: its S2
  // dimension (b2bState x [chain >= 1], ported in chunk 4 from 78a8eff) IS read by
  // expandS2 — its S2 behaviour is pinned in tools/s2-lab/adopt.test.ts, so b2bState is
  // deliberately excluded from the weights switched on here.
  const S2_IGNORED: Weights = {
    ...DEFAULT_WEIGHTS,
    tSlotChain2: 100,
    tSlotChain3: -50,
    holdT: 40,
    holdI: 20,
  };
  for (const b2b of [false, true]) {
    test(`s2 profile ignores the C2/C4 adopt weights (b2b=${b2b})`, () => {
      const i = input(MIDGAME, "T", ["I", "L", "O"], {
        b2b,
        hold: "T",
        speculativePieces: ["S", "Z", "J"],
      });
      const options = { width: 24, profile: "s2" as const };
      same(
        search(i, { ...options, weights: S2_IGNORED }),
        search(i, { ...options, weights: DEFAULT_WEIGHTS }),
      );
    });
  }
});

const mirrorRow = (row: number): number => {
  let out = 0;
  for (let x = 0; x < 10; x += 1) if (row & (1 << x)) out |= 1 << (9 - x);
  return out;
};
const TSD_ROWS = [0b100, FULL ^ 0b111, FULL ^ 0b10, FULL ^ (1 << 9)];
const TST_ROWS = [0b100, FULL ^ 0b111, FULL ^ 0b100, FULL ^ 0b110, FULL ^ 0b100, FULL ^ (1 << 9)];
const STACKED = [
  (1 << 2) | (1 << 8),
  FULL ^ (0b111 << 6),
  FULL ^ (1 << 7),
  FULL ^ 0b111,
  FULL ^ 0b10,
  FULL ^ (1 << 9),
];

describe("C2 T-slot donations", () => {
  test("TSD/TST both chiralities, gate, chain, early stop, and immutability", () => {
    expect(tSlotDonations(board(...TSD_ROWS), 1)).toEqual([0, 0, 1, 0]);
    expect(tSlotDonations(board(...TSD_ROWS.map(mirrorRow)), 1)).toEqual([0, 0, 1, 0]);
    expect(tSlotDonations(board(...TST_ROWS), 1)).toEqual([0, 0, 0, 1]);
    expect(tSlotDonations(board(...TST_ROWS.map(mirrorRow)), 1)).toEqual([0, 0, 0, 1]);
    expect(tSlotDonations(board(...TSD_ROWS), 0)).toEqual([0, 0, 0, 0]);
    const b = board(...STACKED);
    expect(tSlotDonations(b, 1)).toEqual([0, 0, 1, 0]);
    expect(tSlotDonations(b, 2)).toEqual([0, 0, 2, 0]);
    expect(tSlotDonations(b, 3)).toEqual([0, 0, 2, 0]);
    const short = [...TSD_ROWS];
    short[2] = FULL ^ 0b10 ^ (1 << 9);
    expect(tSlotDonations(board(...short), 3)).toEqual([0, 1, 0, 0]);
    const before = Array.from(b);
    tSlotDonations(b, 3);
    expect(Array.from(b)).toEqual(before);
  });
  test("availability follows queue, bag credit, hold, and chance boundary", () => {
    const w = { ...DEFAULT_WEIGHTS, tSlotChain2: 1 };
    const seq = ["O", "T", "I", "T"] as const;
    const plain = adoptContext(w, seq, []);
    expect([
      tAvailable(plain, 0, null),
      tAvailable(plain, 2, null),
      tAvailable(plain, 4, null),
      tAvailable(plain, 4, "T"),
      tAvailable(plain, 0, "T"),
    ]).toEqual([2, 1, 0, 1, 3]);
    const bag = adoptContext(w, seq, ["T", "S"]);
    expect([
      tAvailable(bag, 4, null),
      tAvailable(bag, 2, "T"),
      tAvailable(bag, 5, null),
      tAvailable(bag, 5, "T"),
    ]).toEqual([2, 3, 0, 1]);
    expect(tAvailable(adoptContext(w, seq, ["I", "O", "T", "S", "Z", "J", "L"]), 4, null)).toBe(1);
    expect(adoptContext(DEFAULT_WEIGHTS, seq, []).tSlotChain).toBeNull();
  });
  test("default/absent/zero weights are identical, and enabled held T values an intact slot", () => {
    const absent = withoutKey("tSlotChain0");
    const allAbsent: Weights = Object.fromEntries(
      Object.entries(absent).filter(([k]) => !k.startsWith("tSlotChain")),
    ) as unknown as Weights;
    const i = input(board(...STACKED), "T", ["I", "L", "O"], {
      speculativePieces: ["S", "Z", "T"],
    });
    const base = search(i, { weights: DEFAULT_WEIGHTS, width: 24, guideline: true });
    same(search(i, { weights: allAbsent, width: 24, guideline: true }), base);
    same(
      search(i, {
        weights: {
          ...DEFAULT_WEIGHTS,
          tSlotChain0: 0,
          tSlotChain1: 0,
          tSlotChain2: 0,
          tSlotChain3: 0,
        },
        width: 24,
        guideline: true,
      }),
      base,
    );
    const held = input(board(...TSD_ROWS), "O", [], { hold: "T", canHold: false });
    const off = search(held, { weights: DEFAULT_WEIGHTS, width: 64 });
    const on = search(held, { weights: { ...DEFAULT_WEIGHTS, tSlotChain2: 100 }, width: 64 });
    if (!off || !on) throw new Error("no move");
    expect(
      on.candidates.some(
        (c) =>
          Math.abs(
            c.value -
              (off.candidates.find(
                (o) => JSON.stringify(o.placement) === JSON.stringify(c.placement),
              )?.value ?? 0) -
              97,
          ) < 1e-9,
      ),
    ).toBe(true);
    const noT = input(board(...TSD_ROWS), "O", ["I"], { hold: "I", canHold: false });
    same(
      search(noT, { weights: { ...DEFAULT_WEIGHTS, tSlotChain2: 100 }, width: 64 }),
      search(noT, { weights: DEFAULT_WEIGHTS, width: 64 }),
    );
  });
});

describe("C4 hold-piece terminal value (holdT / holdI)", () => {
  test("defaults are 0", () => {
    expect(DEFAULT_WEIGHTS.holdT).toBe(0);
    expect(DEFAULT_WEIGHTS.holdI).toBe(0);
  });

  for (const hold of [null, "T", "I"] as const) {
    for (const speculate of [false, true]) {
      test(`absent, explicit 0 and DEFAULT are bit-identical (hold=${hold}, chance=${speculate})`, () => {
        const i = input(MIDGAME, "T", ["I", "L", "O"], {
          hold,
          speculativePieces: speculate ? ["S", "Z", "T"] : [],
        });
        const options = { width: 24, guideline: true };
        const base = search(i, { ...options, weights: DEFAULT_WEIGHTS });
        const copy: Record<string, unknown> = { ...DEFAULT_WEIGHTS };
        delete copy.holdT;
        delete copy.holdI;
        same(search(i, { ...options, weights: copy as unknown as Weights }), base);
        same(search(i, { ...options, weights: { ...DEFAULT_WEIGHTS, holdT: 0, holdI: 0 } }), base);
      });
    }
  }

  test("adds gamma * holdT / holdI by the piece left in hold", () => {
    const on = { ...DEFAULT_WEIGHTS, holdT: 40, holdI: 25 };
    for (const [held, gain] of [
      ["T", 40],
      ["I", 25],
      ["O", 0],
    ] as const) {
      const i = input(new Uint16Array(40), "J", [], { hold: held, canHold: false });
      const off = search(i, { weights: DEFAULT_WEIGHTS, width: 64 });
      const r = search(i, { weights: on, width: 64 });
      if (!off || !r) throw new Error("no move");
      expect(r.best).toEqual(off.best);
      for (const [k, c] of r.candidates.entries())
        expect(c.value - (off.candidates[k]?.value as number)).toBeCloseTo(0.97 * gain, 9);
    }
  });

  test("a large holdT keeps the T in hold instead of placing it", () => {
    const i = input(new Uint16Array(40), "T", ["O"], {});
    const r = (w: Weights) => {
      const out = search(i, { weights: w, width: 64 });
      if (!out) throw new Error("no move");
      return out.line.map((s) => s.placement.kind).join("");
    };
    expect(r({ ...DEFAULT_WEIGHTS, holdT: 5000 })).toBe("O");
  });
});
