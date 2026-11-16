/** Tests for the unified rules-profile table and NodeState infrastructure (chunk 3a). */
import { describe, expect, test } from "bun:test";
import { boardFeatures } from "../src/ai/bot/features.js";
import { solvencyStateFrom } from "../src/ai/bot/solvency.js";
import { evaluatorView, type NodeState, rootState, type SearchInput } from "../src/ai/bot/state.js";
import { stockStateFrom } from "../src/ai/bot/stock.js";
import { RULES_PROFILE_TABLE, rulesProfile, type UnifiedProfileId } from "../src/core/profile.js";

describe("rules profile table", () => {
  test("guideline and s2 profiles differ", () => {
    const guideline = rulesProfile("guideline");
    const s2 = rulesProfile("s2");
    expect(guideline.id).not.toBe(s2.id);
    expect(guideline.boardRows).not.toBe(s2.boardRows);
    expect(guideline.surge).not.toBe(s2.surge);
    expect(guideline.garbageSemantics).not.toBe(s2.garbageSemantics);
    expect(guideline.rotate180).not.toBe(s2.rotate180);
    expect(guideline.spinEvidence).not.toBe(s2.spinEvidence);
    expect(guideline.spinClassifier).not.toBe(s2.spinClassifier);
    expect(guideline.dedupe).not.toBe(s2.dedupe);
  });

  test("guideline profile has pinned values", () => {
    const profile = rulesProfile("guideline");
    expect(profile.id).toBe("guideline");
    expect(profile.boardRows).toBe(20);
    expect(profile.visibleRows).toBe(20);
    expect(profile.deathHeight).toBe("boardLength");
    expect(profile.attackRules).toBe("guideline");
    expect(profile.surge).toBe(false);
    expect(profile.comboInAttack).toBe(false);
    expect(profile.garbageSemantics).toBe("root-lift");
    expect(profile.rotate180).toBe(false);
    expect(profile.spinEvidence).toBe(false);
    expect(profile.spinClassifier).toBe("engine");
    expect(profile.dedupe).toBe("guideline");
  });

  test("s2 profile has pinned values", () => {
    const profile = rulesProfile("s2");
    expect(profile.id).toBe("s2");
    expect(profile.boardRows).toBe(40);
    expect(profile.visibleRows).toBe(20);
    expect(profile.deathHeight).toBe(21);
    expect(profile.attackRules).toBe("tetrio-s2");
    expect(profile.surge).toBe(true);
    expect(profile.comboInAttack).toBe(true);
    expect(profile.garbageSemantics).toBe("materialized-carried");
    expect(profile.rotate180).toBe(true);
    expect(profile.spinEvidence).toBe(true);
    expect(profile.spinClassifier).toBe("s2");
    expect(profile.dedupe).toBe("s2");
  });

  test("RULES_PROFILE_TABLE contains both profiles", () => {
    const ids: UnifiedProfileId[] = ["guideline", "s2"];
    for (const id of ids) {
      expect(RULES_PROFILE_TABLE[id]).toBeDefined();
      expect(RULES_PROFILE_TABLE[id].id).toBe(id);
    }
  });
});

describe("NodeState and rootState", () => {
  const board = new Uint16Array(20);
  board[19] = 0b1111111110; // bottom row almost full

  const input: SearchInput = {
    board,
    active: { kind: "T", rotation: 0, x: 3, y: 0 },
    hold: "I",
    canHold: true,
    preview: ["S", "Z"],
    b2b: true,
    combo: 2,
    pending: 4,
  };

  const features = boardFeatures(board, 0);

  test("rootState builds a NodeState from SearchInput", () => {
    const state = rootState(input, features, ["L", "J"]);

    expect(state.board).toBe(board);
    expect(state.hold).toBe("I");
    expect(state.canHold).toBe(true);
    expect(state.next).toBe(0);
    expect(state.b2bChain).toBe(1); // true → 1
    expect(state.b2bActive).toBe(true);
    expect(state.combo).toBe(2);
    expect(state.pending).toBe(4);
    expect(state.lift).toBe(0);
    expect(state.dueThisLock).toBe(0);
    expect(state.bagRemaining).toEqual(["L", "J"]);
    expect(state.tSlot).toBe(features.tSlot);
    expect(state.garbageRows).toBe(null);
  });

  test("rootState with b2b false stores b2bChain as 0", () => {
    const inputNoB2b: SearchInput = { ...input, b2b: false };
    const state = rootState(inputNoB2b, features, null);

    expect(state.b2bChain).toBe(0);
    expect(state.b2bActive).toBe(false);
  });
});

describe("evaluatorView", () => {
  test("evaluatorView extracts b2b, hold, canHold, bag, combo and pending", () => {
    const state: NodeState = {
      board: new Uint16Array(20),
      garbageRows: null,
      hold: "J",
      canHold: false,
      next: 3,
      b2bChain: 5,
      b2bActive: true,
      combo: 7,
      pending: 2,
      lift: 1,
      dueThisLock: 0,
      bagRemaining: ["O", "S"],
      tSlot: 2,
    };

    const view = evaluatorView(state);

    expect(view.b2bActive).toBe(true);
    expect(view.b2bChain).toBe(5);
    expect(view.hold).toBe("J");
    expect(view.canHold).toBe(false);
    expect(view.bagRemaining).toEqual(["O", "S"]);
    expect(view.combo).toBe(7);
    expect(view.pending).toBe(2);
  });
});

describe("stockStateFrom", () => {
  test("reads chain, combo, pending from NodeState", () => {
    const state: NodeState = {
      board: new Uint16Array(20),
      garbageRows: null,
      hold: null,
      canHold: true,
      next: 0,
      b2bChain: 3,
      b2bActive: true,
      combo: 5,
      pending: 6,
      lift: 0,
      dueThisLock: 0,
      bagRemaining: null,
      tSlot: 1,
    };
    const features = boardFeatures(state.board, 0);

    const stockState = stockStateFrom(state, features, 1.5);

    expect(stockState.chain).toBe(3);
    expect(stockState.combo).toBe(5);
    expect(stockState.pending).toBe(6);
    expect(stockState.maxHeight).toBe(features.maxHeight);
    expect(stockState.tSlot).toBe(features.tSlot);
    expect(stockState.wellDepth).toBe(features.wellDepth);
    expect(stockState.multiplier).toBe(1.5);
  });
});

describe("solvencyStateFrom", () => {
  test("reads maxHeight and pending from NodeState", () => {
    const board = new Uint16Array(20);
    // Stack of 8 rows
    for (let i = 12; i < 20; i++) board[i] = 0b1111111110;

    const state: NodeState = {
      board,
      garbageRows: null,
      hold: "T",
      canHold: true,
      next: 2,
      b2bChain: 0,
      b2bActive: false,
      combo: -1,
      pending: 3,
      lift: 0,
      dueThisLock: 0,
      bagRemaining: null,
      tSlot: 0,
    };
    const features = boardFeatures(board, 0);

    const solvencyState = solvencyStateFrom(state, features);

    expect(solvencyState.maxHeight).toBe(features.maxHeight);
    expect(solvencyState.pending).toBe(3);
  });
});
