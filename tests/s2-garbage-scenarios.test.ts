/**
 * Item 100 chunk B/C1: garbage-scenario root scoring (canonical §C2) and the
 * opt-in best-line predicted states. Both are default-off: without the
 * options, search() is the unchanged core (the S2 golden parity tests and the
 * decision-corpus digest pin the off path byte for byte).
 */
import { describe, expect, test } from "bun:test";
import { spawnPosition } from "../src/ai/bot/movegen.js";
import {
  type Candidate,
  type SearchInput,
  type SearchOptions,
  type SearchResult,
  search,
  searchWithGarbageScenarios,
} from "../src/ai/bot/search.js";
import { DEFAULT_WEIGHTS } from "../src/ai/bot/weights.js";
import type { PieceKind } from "../src/core/pieces.js";

/** Bottom `rows` (top row first) as fully-garbage rows of a 10x40 board. */
function makeInput(
  rows: readonly number[],
  seq: readonly PieceKind[],
  pending: number,
  dueThisLock = 0,
): SearchInput {
  const board = new Uint16Array(40);
  const garbageRows = Array<number>(40).fill(0);
  rows.forEach((bits, i) => {
    board[40 - rows.length + i] = bits;
    garbageRows[40 - rows.length + i] = 1;
  });
  const active = seq[0] as PieceKind;
  return {
    board,
    garbageRows,
    frame: 0,
    active: { kind: active, ...spawnPosition(active, 40) },
    hold: null,
    canHold: true,
    preview: seq.slice(1),
    b2b: false,
    b2bChain: 0,
    combo: -1,
    pending,
    dueThisLock,
    speculativePieces: [],
  };
}

// Found by a scripted scan: with 6 extra rows the worst-case-best root differs
// from the actual-input best root.
const FLIP = makeInput([767, 1019, 1007, 767, 1022, 1022], ["S", "J", "I", "S", "J", "I"], 2);
const OPTS: SearchOptions = { weights: DEFAULT_WEIGHTS, width: 16, profile: "s2" };

const key = (c: Pick<Candidate, "placement" | "usedHold">) =>
  `${c.placement.kind}|${c.placement.rotation}|${c.placement.x}|${c.placement.y}|${c.placement.lastSrs}|${c.placement.tspin}|${c.usedHold}`;

/** Independent re-derivation from plain search() calls: min over scenarios per root. */
function expectedScores(input: SearchInput, options: SearchOptions, extras: readonly number[]) {
  const base = search(input, options) as SearchResult;
  const scores = new Map(base.candidates.map((c) => [key(c), c.value]));
  for (const extra of extras) {
    const pending = input.pending + extra;
    const run = search(
      { ...input, pending, dueThisLock: Math.min(input.dueThisLock ?? 0, pending) },
      options,
    );
    const values = new Map((run?.candidates ?? []).map((c) => [key(c), c.value]));
    for (const [k, v] of scores) scores.set(k, Math.min(v, values.get(k) ?? -Infinity));
  }
  return { base, scores };
}

describe("garbage-scenario root scoring", () => {
  test("off: the option absent leaves search() and the wrapper on the plain core", () => {
    const plain = search(FLIP, OPTS);
    expect(searchWithGarbageScenarios(FLIP, OPTS)).toEqual(plain);
    // Scenario set {0} is the actual input alone: identical ranking and move.
    const zero = search(FLIP, { ...OPTS, garbageScenarios: [0] }) as SearchResult;
    expect(zero.best).toEqual((plain as SearchResult).best);
    expect(zero.candidates).toEqual((plain as SearchResult).candidates);
    expect(zero.value).toBe((plain as SearchResult).value);
  });

  test("min-aggregation over a shared scenario set picks the robust root", () => {
    const { base, scores } = expectedScores(FLIP, OPTS, [6]);
    const result = search(FLIP, { ...OPTS, garbageScenarios: [6] }) as SearchResult;
    // Every base root is scored, and scored by its worst case.
    expect(result.candidates.length).toBe(base.candidates.length);
    for (const c of result.candidates) expect(c.value).toBe(scores.get(key(c)) as number);
    // Candidates are sorted by scenario score; the winner is the max-min root.
    for (let i = 1; i < result.candidates.length; i += 1)
      expect(result.candidates[i - 1]?.value).toBeGreaterThanOrEqual(
        result.candidates[i]?.value as number,
      );
    const robust = result.candidates[0] as Candidate;
    expect(key({ placement: result.best.placement, usedHold: result.best.usedHold })).toBe(
      key(robust),
    );
    // On this input the scenario changes the decision.
    expect(key(robust)).not.toBe(key(base.best));
    // best/line/value are the base search's best line of the winning root.
    expect(result.line[0]).toEqual(result.best);
    const baseValue = base.candidates.find((c) => key(c) === key(robust))?.value;
    expect(result.value).toBe(baseValue as number);
    // The work of every scenario run is counted.
    expect(result.nodes).toBeGreaterThan(base.nodes);
  });

  test("the scenario set is shared: order and duplicates do not matter", () => {
    const a = search(FLIP, { ...OPTS, garbageScenarios: [3, 6] });
    const b = search(FLIP, { ...OPTS, garbageScenarios: [6, 0, 3, 6] });
    expect(b?.best).toEqual(a?.best as SearchResult["best"]);
    expect(b?.candidates).toEqual(a?.candidates as Candidate[]);
    const { scores } = expectedScores(FLIP, OPTS, [3, 6]);
    for (const c of a?.candidates ?? []) expect(c.value).toBe(scores.get(key(c)) as number);
  });

  test("roots pruned out of a scenario run score -Infinity there", () => {
    const narrow: SearchOptions = { ...OPTS, width: 3 };
    const { scores } = expectedScores(FLIP, narrow, [6]);
    const result = search(FLIP, { ...narrow, garbageScenarios: [6] }) as SearchResult;
    expect(result.candidates.some((c) => c.value === -Infinity)).toBe(true);
    for (const c of result.candidates) expect(c.value).toBe(scores.get(key(c)) as number);
    // A surviving root still wins over the -Infinity ones.
    expect(result.candidates[0]?.value).toBeGreaterThan(-Infinity);
  });

  test("a null base search propagates", () => {
    // Spawn area filled: the active piece has no placement at all.
    const full = makeInput(Array<number>(40).fill(1023), ["T", "I"], 0);
    expect(search(full, OPTS)).toBeNull();
    expect(search(full, { ...OPTS, garbageScenarios: [4] })).toBeNull();
  });

  test("S2 only; bad scenario values fail loudly", () => {
    expect(() =>
      search(FLIP, { weights: DEFAULT_WEIGHTS, width: 16, garbageScenarios: [4] }),
    ).toThrow(/S2-only/);
    expect(() => search(FLIP, { ...OPTS, profile: "guideline", garbageScenarios: [4] })).toThrow(
      /S2-only/,
    );
    for (const bad of [-1, 1.5, Number.NaN])
      expect(() => search(FLIP, { ...OPTS, garbageScenarios: [bad] })).toThrow(/non-negative/);
  });
});

describe("lineStates (opt-in)", () => {
  test("absent by default; with the option it is the best line's state chain", () => {
    const plain = search(FLIP, OPTS) as SearchResult;
    expect("lineStates" in plain).toBe(false);
    const withStates = search(FLIP, { ...OPTS, lineStates: true }) as SearchResult;
    const { lineStates, ...rest } = withStates;
    expect(rest).toEqual(plain);
    const states = lineStates ?? [];
    expect(states.length).toBe(plain.line.length + 1);
    expect(Array.from(states[0]?.board ?? [])).toEqual(Array.from(FLIP.board));
    expect(states[0]?.pending).toBe(FLIP.pending);
    // Each state consumed one or two queue pieces (two when hold was empty).
    for (let k = 1; k < states.length; k += 1)
      expect((states[k]?.next as number) - (states[k - 1]?.next as number)).toBeGreaterThanOrEqual(
        1,
      );
  });

  test("the scenario wrapper carries the winning root's base line states", () => {
    const r = search(FLIP, { ...OPTS, garbageScenarios: [6], lineStates: true }) as SearchResult;
    expect(r.lineStates?.length).toBe(r.line.length + 1);
    expect(r.lineStates?.[0]?.pending).toBe(FLIP.pending);
  });
});
