import { describe, expect, test } from "bun:test";
import { NEXT_SIZE, NextState, trustRange } from "../src/ai/hoiko/next.js";
import { MINO_NONE } from "../src/ai/hoiko/mino-codes.js";

describe("native NextMino state machine", () => {
  test("fresh bag order + trust range table", () => {
    const n = new NextState(2);
    n.init([]);
    expect(n.m.slice(0, 10)).toEqual([MINO_NONE, MINO_NONE, 4, 3, 1, 2, 0, 6, 5, 4]);
    expect(n.bagRemains).toBe(6);
    expect(n.trustEnd).toBe(3);
    expect([trustRange(6), trustRange(5), trustRange(4), trustRange(0), trustRange(7)]).toEqual([
      2, 1, 0, 3, 0,
    ]);
  });

  test("shift + compare matches the exe stub NEXTDUMP", () => {
    // Input `next=0..6` x4 and `shiftnext=2` produced, from the shipping
    // Hoiko.exe stub: m=0,1,6,5,4,3,2,6,5,4 trustEnd=1 remains=4.
    const seq = Array.from({ length: NEXT_SIZE }, (_, i) => i % 7);
    const n = new NextState(2);
    n.init(seq);
    n.shiftNext();
    n.shiftNext();
    n.compare(0, seq);
    expect(n.m.slice(0, 10)).toEqual([0, 1, 6, 5, 4, 3, 2, 6, 5, 4]);
    expect(n.trustEnd).toBe(1);
    expect(n.bagRemains).toBe(4);
  });

  test("full-array carry matches the exe for every shift (incl. trustEnd=4 wrap)", () => {
    // Empty board, next=Z,S,T,O,J,L,I x4; exe `shiftnext=N` NEXTDUMP values.
    const live = [6, 5, 4, 3, 1, 2, 0, 6, 5, 4, 3, 1, 2, 0, 6, 5, 4, 3, 1, 2, 0, 6, 5, 4, 3, 1, 2];
    const n = new NextState(2);
    n.init(live);
    const at = (): readonly number[] => [...n.m];
    expect(at().slice(0, 10)).toEqual([6, 5, 4, 3, 1, 2, 0, 6, 5, 4]);
    expect([n.trustEnd, n.bagRemains]).toEqual([3, 6]);
    const steps = [
      { trust: 2, remains: 5, m: [6, 5, 4, 3, 1, 2, 0, 5, 4, 3] },
      { trust: 1, remains: 4, m: [6, 5, 4, 3, 1, 2, 0, 5, 4, 3] },
      { trust: 1, remains: 3, m: [6, 5, 4, 3, 1, 2, 0, 5, 4, 3] },
    ];
    for (const step of steps) {
      n.shiftNext();
      n.compare(0, live);
      expect(at().slice(0, 10)).toEqual(step.m);
      expect([n.trustEnd, n.bagRemains]).toEqual([step.trust, step.remains]);
    }
    for (let i = 4; i <= 6; i += 1) {
      n.shiftNext();
      n.compare(0, live);
    }
    expect([n.trustEnd, n.bagRemains]).toEqual([4, 0]);
    expect(at()).toEqual([
      6, 5, 4, 3, 1, 2, 0, 4, 3, 1, 2, 0, 4, 3, 1, 2, 0, 5, 4, 3, 1, 2, 0, 5, 4, 3, 1, 2,
    ]);
  });

  test("per-turn SetPPTData composition matches exe shiftiter dumps", () => {
    // `next=0,3,4,5,6,1,2` x4, `shiftiter=1..4` (each iteration = the per-turn
    // `ShiftNext; Compare(0, nx)` pair) from the shipping Hoiko.exe stub.
    const seq = [
      0, 3, 4, 5, 6, 1, 2, 0, 3, 4, 5, 6, 1, 2, 0, 3, 4, 5, 6, 1, 2, 0, 3, 4, 5, 6, 1, 2,
    ];
    const golden: {
      readonly n: number;
      readonly m: number[];
      readonly trust: number;
      readonly rem: number;
    }[] = [
      {
        n: 1,
        m: [0, 3, 6, 5, 4, 1, 2, 6, 5, 4, 3, 1, 2, 6, 5, 4, 3, 1, 2, 0, 6, 5, 4, 3, 1, 2, 0, 6],
        trust: 2,
        rem: 5,
      },
      {
        n: 4,
        m: [0, 3, 6, 5, 4, 1, 2, 6, 5, 4, 1, 2, 6, 5, 4, 3, 1, 2, 6, 5, 4, 3, 1, 2, 6, 5, 4, 3],
        trust: 1,
        rem: 2,
      },
    ];
    for (const g of golden) {
      const n = new NextState(2);
      n.init(seq);
      for (let s = 0; s < g.n; s += 1) {
        n.shiftNext();
        n.compare(0, seq);
      }
      expect(n.m).toEqual(g.m);
      expect(n.trustEnd).toBe(g.trust);
      expect(n.bagRemains).toBe(g.rem);
    }
  });

  test("bag cursor cycles through all seven positions", () => {
    const n = new NextState(2);
    n.init([0, 1, 2, 3]);
    const remains: number[] = [];
    for (let i = 0; i < 14; i += 1) {
      n.shiftNext();
      remains.push(n.bagRemains);
    }
    expect(remains).toEqual([5, 4, 3, 2, 1, 0, 6, 5, 4, 3, 2, 1, 0, 6]);
  });
});
