import { describe, expect, test } from "bun:test";
import {
  Baby,
  addBaby,
  newBabyBuckets,
  overrideSameNode,
} from "../src/ai/native/baby.js";
import { expandTemplateNode } from "../src/ai/native/expand-template.js";
import { buildRoot, expandNode, MINO_I, MINO_NONE, MINO_O } from "../src/ai/native/index.js";
import type { NativeInput } from "../src/ai/native/index.js";

function rootBaby(m: number): Baby {
  const root = new Baby();
  root.fallingMino.m = m;
  root.fallingMino.y = 20;
  root.fallingMino.x = 3;
  root.fallingMino.r = 0;
  root.hold.m = MINO_NONE;
  return root;
}

describe("ExpandTemplateNode tables (SPEC_ExpandAI §7)", () => {
  test("I table has 33 entries and returns 34", () => {
    const root = rootBaby(MINO_I);
    const babies = [root];
    expect(expandTemplateNode(babies, root)).toBe(34);
    expect(babies.length).toBe(34);
    const e1 = babies[1];
    expect(e1?.fallingMino.x).toBe(0);
    expect(e1?.fallingMino.r).toBe(0);
    expect(e1?.commands.moveDelay).toBe(90);
    const e7 = babies[7];
    expect(e7?.fallingMino.x).toBe(-2);
    expect(e7?.fallingMino.r).toBe(1);
    expect(e7?.commands.moveDelay).toBe(150);
  });

  test("O table has 8 entries and returns 9", () => {
    const root = rootBaby(MINO_O);
    const babies = [root];
    expect(expandTemplateNode(babies, root)).toBe(9);
    expect(babies.length).toBe(9);
    expect(babies[1]?.fallingMino.x).toBe(-1);
    expect(babies[7]?.fallingMino.x).toBe(6);
  });

  test("default (SZTJL) table has 33 entries", () => {
    const root = rootBaby(4);
    const babies = [root];
    expect(expandTemplateNode(babies, root)).toBe(34);
    expect(babies[1]?.fallingMino.x).toBe(0);
    expect(babies[7]?.fallingMino.x).toBe(7);
  });
});

describe("OverrideSameNode (SPEC_ExpandAI §6.1)", () => {
  test("dedups by (r,x,y) and keeps the smaller moveDelay", () => {
    const buckets = newBabyBuckets();
    const a = rootBaby(MINO_I);
    a.commands.moveDelay = 100;
    addBaby(buckets, a);
    const bb = rootBaby(MINO_I);
    bb.commands.moveDelay = 50;
    expect(overrideSameNode(buckets, bb)).toBe(1);
    expect(a.commands.moveDelay).toBe(50);
  });

  test("different y is a new node", () => {
    const buckets = newBabyBuckets();
    const a = rootBaby(MINO_I);
    addBaby(buckets, a);
    const bb = rootBaby(MINO_I);
    bb.fallingMino.y = 21;
    expect(overrideSameNode(buckets, bb)).toBe(0);
  });
});

describe("ExpandNode children", () => {
  const input: NativeInput = {
    board: [],
    current: "I",
    queue: ["O", "T", "S", "Z", "J", "L", "I"],
    hold: null,
    combo: 0,
    btb: 0,
  };
  test("non-hold expansion has unique resulting boards and respects MAX_CHILDREN", () => {
    const root = buildRoot(input, 2, false);
    const children = expandNode(root, false);
    expect(children.length).toBeGreaterThan(0);
    expect(children.length).toBeLessThanOrEqual(100);
    const seen = new Set<string>();
    for (const c of children) {
      const key = `${Array.from(c.game.board.line).join(",")}|${c.game.board.stackHeight}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  test("hold pass adds children when the current piece differs from hold", () => {
    const root = buildRoot(input, 2, false);
    const withHold = expandNode(root, true);
    const withoutHold = expandNode(root, false);
    expect(withHold.length).toBeGreaterThanOrEqual(withoutHold.length);
    expect(withHold.some((c) => c.holdUsed)).toBe(true);
  });
});
