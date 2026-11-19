/**
 * Plan carry-over (item 100 chunk C2). The inner decider is a fake that
 * returns canned results; the canned result is a real TS search with
 * lineStates, so its predicted states are genuine search states. "Actual"
 * decisions are rebuilt from those predicted states, then perturbed one field
 * at a time to prove every divergence re-searches.
 */
import { describe, expect, test } from "bun:test";
import { type SearchResult, search } from "../../src/ai/bot/search.js";
import type { NodeState } from "../../src/ai/bot/state.js";
import { DEFAULT_WEIGHTS } from "../../src/ai/bot/weights.js";
import type { PieceKind } from "../../src/core/pieces.js";
import { type PublicDecision, projectAttax } from "./attax-player.js";
import { createPlanCarryoverDecider } from "./plan-carryover.js";
import { toSharedInput } from "./s2-input.js";

const SEQ: PieceKind[] = ["S", "J", "I", "S", "J", "I", "T", "O"];
const ROWS = [767, 1019, 1007, 767, 1022, 1022]; // bottom 6 rows, top row first

/** A public decision whose projection is exactly `state` (queue from SEQ). */
function decisionFrom(state: NodeState, frame: number, due = state.pending): PublicDecision {
  let cells = "";
  for (let y = 0; y < 40; y += 1) {
    const row = 39 - y;
    for (let x = 0; x < 10; x += 1) {
      const filled = ((state.board[row] as number) & (1 << x)) !== 0;
      cells += !filled ? "_" : state.garbageRows?.[row] ? "G" : "X";
    }
  }
  return {
    lockTime: { logicalFrame: frame },
    board: { width: 10, height: 40, cells },
    pieces: {
      current: SEQ[state.next] as PieceKind,
      known: SEQ.slice(state.next + 1),
      hold: state.hold,
      holdAvailable: state.canHold,
    },
    chain: { combo: state.combo + 1, b2b: state.b2bChain },
    incoming: { pendingRows: state.pending, dueThisLockRows: due },
  };
}

function rootDecision(pending = 0): PublicDecision {
  const board = new Uint16Array(40);
  const flags = new Uint8Array(40);
  ROWS.forEach((bits, i) => {
    board[34 + i] = bits;
    flags[34 + i] = 1;
  });
  const state = {
    board,
    garbageRows: flags,
    hold: null,
    canHold: true,
    next: 0,
    b2bChain: 0,
    combo: -1,
    pending,
  } as unknown as NodeState;
  // Root rows not due this lock: they carry into the plan as residual pending.
  return decisionFrom(state, 0, 0);
}

const ROOT = rootDecision();
const PLAN = search(toSharedInput(projectAttax(ROOT)), {
  weights: DEFAULT_WEIGHTS,
  width: 16,
  profile: "s2",
  lineStates: true,
}) as SearchResult;
const STATES = PLAN.lineStates as readonly NodeState[];

function fakeInner(results: (SearchResult | null)[]) {
  const calls: PublicDecision[] = [];
  return {
    calls,
    async decideAsync(decision: PublicDecision) {
      calls.push(decision);
      return results[Math.min(calls.length - 1, results.length - 1)] ?? null;
    },
  };
}

/** The actual decision the plan predicts after `k` locks (one lock per 60 frames). */
const actualAt = (k: number) => decisionFrom(STATES[k] as NodeState, 60 * k);

describe("plan carry-over", () => {
  test("the canned plan is a multi-step line with matching states", () => {
    expect(PLAN.line.length).toBeGreaterThanOrEqual(3);
    expect(STATES.length).toBe(PLAN.line.length + 1);
    // The rebuilt root decision projects to the plan's root state.
    expect(projectAttax(actualAt(0)).board).toEqual(projectAttax(ROOT).board);
  });

  test("first call searches; matching states carry the planned steps", async () => {
    const inner = fakeInner([PLAN]);
    const d = createPlanCarryoverDecider(inner);
    const first = await d.decideAsync(ROOT);
    expect(first).toBe(PLAN); // a searched decision is the inner result unchanged
    expect(inner.calls.length).toBe(1);
    for (let k = 1; k < PLAN.line.length; k += 1) {
      const carried = await d.decideAsync(actualAt(k));
      expect(inner.calls.length).toBe(1); // not searched again
      expect(carried?.carried).toBe(true);
      expect(carried?.best).toEqual(PLAN.line[k] as SearchResult["best"]);
      expect(carried?.line).toEqual(PLAN.line.slice(k));
      expect(carried?.nodes).toBe(0);
      expect(carried?.value).toBe(PLAN.value);
      expect(carried?.candidates).toBe(PLAN.candidates);
    }
    expect(d.stats).toEqual({
      searched: 1,
      carried: PLAN.line.length - 1,
      reasons: { "no-plan": 1 },
    });
    // The plan is spent: the next decision searches.
    await d.decideAsync(actualAt(PLAN.line.length));
    expect(inner.calls.length).toBe(2);
  });

  const mutations: [string, (d: PublicDecision) => PublicDecision][] = [
    [
      "board",
      (d) => ({
        ...d,
        board: { ...d.board, cells: `X${d.board.cells.slice(1)}` },
      }),
    ],
    [
      "garbageRows",
      (d) => {
        // Flip the garbage provenance of the bottom row only (same occupancy).
        // cells[0..9] is board row 39 (projectAttax: rows[39 - y]).
        const cells = d.board.cells;
        const bottom = cells.slice(0, 10);
        const flipped = bottom.includes("G")
          ? bottom.replace(/G/g, "X")
          : bottom.replace(/X/g, "G");
        return { ...d, board: { ...d.board, cells: flipped + cells.slice(10) } };
      },
    ],
    ["hold", (d) => ({ ...d, pieces: { ...d.pieces, hold: d.pieces.hold === "Z" ? "L" : "Z" } })],
    ["canHold", (d) => ({ ...d, pieces: { ...d.pieces, holdAvailable: !d.pieces.holdAvailable } })],
    ["b2bChain", (d) => ({ ...d, chain: { ...d.chain, b2b: d.chain.b2b + 3 } })],
    ["combo", (d) => ({ ...d, chain: { ...d.chain, combo: d.chain.combo + 2 } })],
    [
      "pending",
      (d) => ({
        ...d,
        incoming: { pendingRows: d.incoming.pendingRows + 2, dueThisLockRows: 0 },
      }),
    ],
    [
      "queue",
      (d) => ({
        ...d,
        pieces: {
          ...d.pieces,
          known: [d.pieces.known[0] === "Z" ? "L" : "Z", ...d.pieces.known.slice(1)],
        },
      }),
    ],
    // Far past the S2 margin the multiplier schedule differs from the plan's.
    ["multiplier", (d) => ({ ...d, lockTime: { logicalFrame: 10_800 * 4 } })],
  ];

  for (const [field, mutate] of mutations) {
    test(`divergence in ${field} re-searches`, async () => {
      const inner = fakeInner([PLAN, PLAN]);
      const d = createPlanCarryoverDecider(inner);
      await d.decideAsync(ROOT);
      const result = await d.decideAsync(mutate(actualAt(1)));
      expect(inner.calls.length).toBe(2);
      expect(result?.carried).toBeUndefined();
      expect(d.stats.searched).toBe(2);
      expect(d.stats.carried).toBe(0);
      const reasons = Object.keys(d.stats.reasons).filter((r) => r !== "no-plan");
      expect(reasons).toEqual([field]);
    });
  }

  test("dueThisLock: the plan's modeled due (all residual pending) must match", async () => {
    // A root with 3 rows pending, none due on the root lock: the plan carries
    // them as residual pending, and past the root the search lands every
    // residual row at the next non-clearing lock (due = pending).
    const root = rootDecision(3);
    const plan = search(toSharedInput(projectAttax(root)), {
      weights: DEFAULT_WEIGHTS,
      width: 16,
      profile: "s2",
      lineStates: true,
    }) as SearchResult;
    const s1 = plan.lineStates?.[1] as NodeState;
    expect(s1.pending).toBeGreaterThan(0); // fixture precondition
    const run = async (due: number) => {
      const inner = fakeInner([plan, plan]);
      const d = createPlanCarryoverDecider(inner);
      await d.decideAsync(root);
      const r = await d.decideAsync(decisionFrom(s1, 60, due));
      return { r, d };
    };
    const matching = await run(s1.pending);
    expect(matching.r?.carried).toBe(true);
    const delayed = await run(0);
    expect(delayed.r?.carried).toBeUndefined();
    expect(delayed.d.stats.reasons).toEqual({ "no-plan": 1, dueThisLock: 1 });
  });

  test("the current acceptRoot rejecting the carried step re-searches", async () => {
    const inner = fakeInner([PLAN, PLAN]);
    const d = createPlanCarryoverDecider(inner);
    await d.decideAsync(ROOT, () => true);
    const step = PLAN.line[1] as SearchResult["best"];
    const seen: string[] = [];
    const result = await d.decideAsync(actualAt(1), (p, usedHold) => {
      seen.push(`${p.kind}${p.rotation}${p.x},${p.y}`);
      return !(
        p.kind === step.placement.kind &&
        p.rotation === step.placement.rotation &&
        p.x === step.placement.x &&
        p.y === step.placement.y &&
        usedHold === step.usedHold
      );
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(inner.calls.length).toBe(2);
    expect(result?.carried).toBeUndefined();
    expect(d.stats.reasons.acceptRoot).toBe(1);
    // An accepting filter carries.
    const ok = createPlanCarryoverDecider(fakeInner([PLAN]));
    await ok.decideAsync(ROOT, () => true);
    expect((await ok.decideAsync(actualAt(1), () => true))?.carried).toBe(true);
  });

  test("results without lineStates are a pure pass-through", async () => {
    const { lineStates: _drop, ...noStates } = PLAN;
    const inner = fakeInner([noStates]);
    const d = createPlanCarryoverDecider(inner);
    for (let k = 0; k < 3; k += 1) {
      const r = await d.decideAsync(actualAt(k));
      expect(r).toBe(noStates);
    }
    expect(inner.calls.length).toBe(3);
    expect(d.stats.carried).toBe(0);
  });

  test("a null search result leaves no plan", async () => {
    const inner = fakeInner([null, PLAN]);
    const d = createPlanCarryoverDecider(inner);
    expect(await d.decideAsync(ROOT)).toBeNull();
    await d.decideAsync(actualAt(1));
    expect(inner.calls.length).toBe(2);
  });
});
