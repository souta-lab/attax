/**
 * Regression pin for the 180° kick tables.
 *
 * Background (2026-11-16, intetrigence's audit — their commit 575ba18,
 * evidence scripts/evidence/attax-s2-10/): attax's SRS+ JLSTZ 180 table has
 * a sixth candidate that the TETR.IO S2 table does not. Under the S2
 * profile, a placement reachable only through that sixth candidate is
 * candidate-unreachable for an S2 referee and forfeits the game (their
 * seeds 9003 / 9007). The S2 profile must therefore use the five-candidate
 * S2 table; the guideline side never requests 180° and stays untouched.
 * These tests pin both tables' exact contents, the profile wiring, and the
 * behavioural difference, so the tables cannot silently drift again.
 */
import { describe, expect, test } from "bun:test";
import {
  FULL_ROW,
  generatePlacements,
  KICKS_180_I,
  KICKS_180_JLSTZ,
  KICKS_180_JLSTZ_S2,
  type Placement,
} from "../src/ai/bot/movegen.js";
import { rulesProfile } from "../src/core/profile.js";

const pairs = (
  table: Readonly<Record<number, readonly { dx: number; dy: number }[]>>,
  from: number,
) => (table[from] as readonly { dx: number; dy: number }[]).map((k) => [k.dx, k.dy]);

describe("S2 180 kick table contents (pinned)", () => {
  test("JLSTZ S2 table is exactly five candidates per transition, in S2 order", () => {
    expect(pairs(KICKS_180_JLSTZ_S2, 0)).toEqual([
      [0, 0],
      [0, 1],
      [1, 1],
      [-1, 1],
      [1, 0],
    ]);
    expect(pairs(KICKS_180_JLSTZ_S2, 2)).toEqual([
      [0, 0],
      [0, -1],
      [-1, -1],
      [1, -1],
      [-1, 0],
    ]);
    expect(pairs(KICKS_180_JLSTZ_S2, 1)).toEqual([
      [0, 0],
      [1, 0],
      [1, 2],
      [1, 1],
      [0, 2],
    ]);
    expect(pairs(KICKS_180_JLSTZ_S2, 3)).toEqual([
      [0, 0],
      [-1, 0],
      [-1, 2],
      [-1, 1],
      [0, 2],
    ]);
  });

  test("S2 table is the SRS+ table minus its sixth candidate, per transition", () => {
    for (const from of [0, 1, 2, 3]) {
      expect(pairs(KICKS_180_JLSTZ_S2, from)).toEqual(pairs(KICKS_180_JLSTZ, from).slice(0, 5));
    }
  });

  test("SRS+ JLSTZ table keeps its six candidates (frozen guideline-side data)", () => {
    expect(pairs(KICKS_180_JLSTZ, 0)).toEqual([
      [0, 0],
      [0, 1],
      [1, 1],
      [-1, 1],
      [1, 0],
      [-1, 0],
    ]);
    expect(pairs(KICKS_180_JLSTZ, 2)).toEqual([
      [0, 0],
      [0, -1],
      [-1, -1],
      [1, -1],
      [-1, 0],
      [1, 0],
    ]);
    expect(pairs(KICKS_180_JLSTZ, 1)).toEqual([
      [0, 0],
      [1, 0],
      [1, 2],
      [1, 1],
      [0, 2],
      [0, 1],
    ]);
    expect(pairs(KICKS_180_JLSTZ, 3)).toEqual([
      [0, 0],
      [-1, 0],
      [-1, 2],
      [-1, 1],
      [0, 2],
      [0, 1],
    ]);
  });

  test("I 180 table is two candidates per transition, shared by both rulesets", () => {
    expect(pairs(KICKS_180_I, 0)).toEqual([
      [0, 0],
      [0, 1],
    ]);
    expect(pairs(KICKS_180_I, 2)).toEqual([
      [0, 0],
      [0, -1],
    ]);
    expect(pairs(KICKS_180_I, 1)).toEqual([
      [0, 0],
      [1, 0],
    ]);
    expect(pairs(KICKS_180_I, 3)).toEqual([
      [0, 0],
      [-1, 0],
    ]);
  });

  test("profile wiring selects the table", () => {
    expect(rulesProfile("guideline").kicks180).toBe("srs+");
    expect(rulesProfile("s2").kicks180).toBe("s2");
  });
});

describe("180 kick behaviour on a sealed board", () => {
  // A T at rotation 0, (4, 10), entombed in a full board. The only cavity
  // besides its own cells is the rotation-2 T at (3, 10), which from the
  // start is reachable solely through the sixth SRS+ kick (-1, 0): the
  // first five kicks collide, every shift and quarter turn collides (no
  // column of the cavity is three cells tall, so no vertical T fits), and
  // both states are grounded. Under the S2 table the rotated placement
  // must not be generated at all.
  const board = new Uint16Array(20).fill(FULL_ROW);
  const cavity: readonly (readonly [number, number])[] = [
    [5, 10],
    [4, 11],
    [5, 11],
    [6, 11],
    [3, 11],
    [4, 12],
  ];
  for (const [col, row] of cavity) board[row] = (board[row] as number) & ~(1 << col);
  const start = { rotation: 0, x: 4, y: 10 };
  const key = (p: Placement) => `${p.rotation},${p.x},${p.y}`;

  test("SRS+ table reaches the placement through the sixth kick (lastSrs 6)", () => {
    const out = generatePlacements(board, "T", start, { rotate180: true, spinEvidence: true });
    const target = out.find((p) => key(p) === "2,3,10");
    expect(target).toBeDefined();
    expect(target?.lastSrs).toBe(6);
    expect(out.map(key).sort()).toEqual(["0,4,10", "2,3,10"]);
  });

  test("S2 table does not generate the sixth-kick placement", () => {
    const out = generatePlacements(board, "T", start, {
      rotate180: true,
      spinEvidence: true,
      kicks180: "s2",
    });
    expect(out.map(key)).toEqual(["0,4,10"]);
  });
});
