import { describe, expect, test } from "bun:test";
import { BAG_ORDER, type BagKind, BagTracker } from "../tbp/bag-tracker.js";

const Q = (s: string) => [...s] as BagKind[];

describe("deterministic 7-bag continuation", () => {
  test("nothing seen yet fills nothing", () => {
    expect(new BagTracker().continuation(8)).toEqual([]);
  });

  test("six revealed pieces: the one remaining bag piece, then a full bag", () => {
    const t = new BagTracker();
    t.startFresh(Q("TIOLJS")); // current bag has only Z left
    expect(t.continuation(8)).toEqual(["Z", ...BAG_ORDER]);
    expect(t.continuation(1)).toEqual(["Z"]);
  });

  test("a fully dealt bag continues with the next bag in canonical order", () => {
    const t = new BagTracker();
    t.startFresh(Q("ZSTOJLI"));
    expect(t.continuation(7)).toEqual([...BAG_ORDER]);
  });

  test("bag rollover: window is the partial second bag, not the tail of the first", () => {
    const t = new BagTracker();
    t.startFresh(Q("ZSTOJLI")); // bag 1 complete
    t.noteNewPiece("T");
    t.noteNewPiece("I"); // bag 2 so far: T, I
    expect(t.continuation(5)).toEqual(Q("ZSOJL"));
  });

  test("consumption does not move the bag phase; resync keeps it", () => {
    const t = new BagTracker();
    t.startFresh(Q("TIOLJS"));
    t.noteConsumed();
    t.noteConsumed(); // consumed T, I; queue tail is O, L, J, S
    t.startResync(Q("OLJSZ")); // resync queue: same tail + newly dealt Z
    // Dealt sequence is T,I,O,L,J,S,Z — bag 1 complete, so the fill is a
    // fresh bag in canonical order.
    expect(t.continuation(3)).toEqual(Q("ZST"));
  });

  test("fresh start resets the phase", () => {
    const t = new BagTracker();
    t.startFresh(Q("ZSTOJLI"));
    t.startFresh(Q("TIO")); // new match: bag has T, I, O dealt
    expect(t.continuation(4)).toEqual(Q("ZSJL"));
  });

  test("duplicate inside a bag window self-heals on the distinct suffix", () => {
    const t = new BagTracker();
    t.startFresh(Q("TIT")); // impossible under a real 7-bag: desync
    // Distinct suffix is T, I — the fill treats exactly those as dealt.
    expect(t.continuation(5)).toEqual(Q("ZSOJL"));
  });

  test("fill is deterministic across identical message streams", () => {
    const run = () => {
      const t = new BagTracker();
      t.startFresh(Q("LJO"));
      t.noteNewPiece("S");
      t.noteConsumed();
      t.startResync(Q("JOSZ"));
      return t.continuation(13);
    };
    expect(run()).toEqual(run());
    expect(run()).toHaveLength(13);
  });
});
