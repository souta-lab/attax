/**
 * Chunk 3b parity: the shared src search under profile "s2" IS the lab search,
 * and the guideline path is unchanged. Every battery case must reproduce the
 * pre-port golden result EXACTLY (deep equality, floats included).
 *
 * The second block runs the PLAYER (attax-player's public-decision projection,
 * its input mapping onto the shared core, and its profile/mechanism wiring)
 * over every battery case a public decision can express — the mapping is the
 * risk of the rewire, so the check goes through it rather than around it. The
 * player always searches at the production default width (BOT_DEFAULTS.width,
 * 96 since the 2026-11-16 width decision), while the battery and its goldens
 * stay at the pre-port record's width 48, so the player block's baseline is
 * the shared search itself run at the player's width on the reference
 * conversion. The goldens remain the pre-port record, checked by the first
 * block through the battery's explicit options.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOT_DEFAULTS } from "../../src/ai/bot/fighter.js";
import { spawnPosition } from "../../src/ai/bot/movegen.js";
import { type SearchInput, type SearchOptions, search } from "../../src/ai/bot/search.js";
import { DEFAULT_WEIGHTS } from "../../src/ai/bot/weights.js";
import { guidelineBattery, type S2Case, s2Battery } from "../unify/s2-battery.js";
import {
  createAttaxDecider,
  decideAttax,
  type PublicDecision,
  projectAttax,
} from "./attax-player.js";
import { toSharedInput } from "./s2-input.js";
import { DEFAULT_SOLVENCY_PARAMS } from "./solvency.js";
import { DEFAULT_STOCK_PARAMS } from "./stock.js";

const golden = JSON.parse(
  readFileSync(new URL("../unify/s2-golden.json", import.meta.url), "utf8"),
) as { s2: Record<string, unknown>; guideline: Record<string, unknown> };

/** Compare in the golden's JSON space: JSON cannot encode -0, doubles round-trip exactly. */
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/**
 * The battery's S2 inputs use the lab input shape, whose `b2b` is the exact
 * chain number. The src input keeps `b2b` boolean and carries the chain in
 * `b2bChain`; every other field is shared verbatim. This is the reference
 * conversion, written out independently of the lab's toSharedInput.
 */
function srcInput(c: S2Case): SearchInput {
  const { b2b, ...rest } = c.input;
  return { ...rest, b2b: b2b > 0, b2bChain: b2b };
}

describe("shared search reproduces the pre-port goldens", () => {
  for (const c of s2Battery()) {
    test(`s2: ${c.name}`, () => {
      const options: SearchOptions = { ...c.options, profile: "s2" };
      const result = search(srcInput(c), options);
      // Breakdown terms like 0 × negative weight are -0, which JSON stores as 0.
      expect(asJson(result)).toEqual(golden.s2[c.name]);
    });
  }
  for (const c of guidelineBattery()) {
    test(`guideline: ${c.name}`, () => {
      const result = search(c.input, c.options);
      // Same JSON space as above (-0 breakdown terms).
      expect(asJson(result)).toEqual(golden.guideline[c.name]);
    });
  }
  test("the lab's toSharedInput is exactly the reference conversion", () => {
    for (const c of s2Battery()) expect(toSharedInput(c.input)).toEqual(srcInput(c));
  });
});

/** Battery cases outside the public-decision surface (the player always passes
 * no speculation, no diverse beam, no exposure term). */
const NOT_A_PUBLIC_DECISION = ["speculative", "diverse", "exposure"];

function expressible(c: S2Case): boolean {
  const o = c.options;
  return (
    o.diverse === undefined &&
    o.exposure === undefined &&
    (c.input.speculativePieces ?? []).length === 0
  );
}

/** Rebuild the referee's public decision that projects onto the battery input. */
function publicDecision(c: S2Case): PublicDecision {
  const input = c.input;
  const cells = Array<string>(400).fill("_");
  for (let y = 0; y < 40; y += 1) {
    const row = 39 - y;
    const bits = input.board[row] as number;
    for (let x = 0; x < 10; x += 1) {
      if ((bits & (1 << x)) !== 0) cells[y * 10 + x] = input.garbageRows?.[row] ? "G" : "X";
    }
  }
  return {
    ...(input.frame !== undefined ? { lockTime: { logicalFrame: input.frame } } : {}),
    board: { width: 10, height: 40, cells: cells.join("") },
    pieces: {
      current: input.active.kind,
      known: [...input.preview],
      hold: input.hold,
      holdAvailable: input.canHold,
    },
    chain: { b2b: input.b2b, combo: input.combo + 1 },
    incoming: { pendingRows: input.pending, dueThisLockRows: input.dueThisLock },
  };
}

describe("the player reproduces the pre-port goldens through its own mapping", () => {
  const ENV = [
    "ATTAX_S2_PROFILE",
    "ATTAX_S2_STOCK_POTENTIAL",
    "ATTAX_S2_SOLVENCY",
    "ATTAX_S2_SOLVENCY_MODE",
  ];
  const saved = new Map<string, string | undefined>();
  const dir = mkdtempSync(join(tmpdir(), "s2-player-parity-"));
  const profilePath = (name: string, body: unknown) => {
    const path = join(dir, `${name}.json`);
    writeFileSync(path, JSON.stringify(body));
    return path;
  };
  beforeAll(() => {
    for (const key of ENV) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });
  afterAll(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** The shared-search result the player must reproduce for a battery case:
   * the case's options at the player's own (production default) width. */
  function expectedFor(c: S2Case): { best: unknown } {
    return asJson(
      search(srcInput(c), { ...c.options, width: BOT_DEFAULTS.width, profile: "s2" }),
    ) as { best: unknown };
  }

  /** The player profile whose options equal the battery case's search options. */
  function deciderFor(c: S2Case) {
    const o = c.options;
    expect(o.weights).toBe(DEFAULT_WEIGHTS);
    const mechanisms: { stock?: object; solvency?: object; solvencyMode?: "hard" } = {};
    if (o.stock !== undefined) {
      expect(o.stock).toEqual(DEFAULT_STOCK_PARAMS);
      mechanisms.stock = {};
    }
    if (o.solvency !== undefined) {
      expect(o.solvency).toEqual(DEFAULT_SOLVENCY_PARAMS);
      mechanisms.solvency = {};
    }
    if (o.rootVeto) mechanisms.solvencyMode = "hard";
    return Object.keys(mechanisms).length === 0
      ? createAttaxDecider(undefined)
      : createAttaxDecider(profilePath(c.name, { mechanisms }));
  }

  test("exactly the non-public battery cases are out of the player's reach", () => {
    expect(
      s2Battery()
        .filter((c) => !expressible(c))
        .map((c) => c.name),
    ).toEqual(NOT_A_PUBLIC_DECISION);
  });

  for (const c of s2Battery().filter(expressible)) {
    test(`player s2: ${c.name}`, () => {
      const d = publicDecision(c);
      // The decision really is this case: the player's projection returns the
      // battery input (empty speculation, all-zero flags when none are given).
      const { acceptRoot, ...battery } = c.input;
      expect(projectAttax(d)).toEqual({
        ...battery,
        active: { kind: c.input.active.kind, ...spawnPosition(c.input.active.kind, 40) },
        garbageRows: c.input.garbageRows ?? Array<number>(40).fill(0),
        speculativePieces: [],
      });
      expect(c.input.active).toEqual({
        kind: c.input.active.kind,
        ...spawnPosition(c.input.active.kind, 40),
      });
      const decided = deciderFor(c).decide(d, acceptRoot);
      const want = expectedFor(c);
      // The chosen move first (clearest failure), then the whole result.
      expect(asJson(decided?.best)).toEqual(want.best);
      expect(asJson(decided)).toEqual(want);
    });
  }

  test("decideAttax (run-match's entry point) takes the same path", () => {
    for (const name of ["plain", "accept-root", "pending-frame", "all-fatal"]) {
      const c = s2Battery().find((x) => x.name === name) as S2Case;
      const decided = decideAttax(publicDecision(c), c.input.acceptRoot);
      expect(asJson(decided)).toEqual(expectedFor(c));
    }
  });
});
