import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardFeatures } from "../../src/ai/bot/features.js";
import { holeGeometry } from "../../src/ai/bot/holes.js";
import { lockPlacement } from "../../src/ai/bot/movegen.js";
import { search } from "../../src/ai/bot/search.js";
import { DEFAULT_WEIGHTS, type Weights } from "../../src/ai/bot/weights.js";
import { createAttaxDecider, type PublicDecision, projectAttax } from "./attax-player.js";
import { toSharedInput } from "./s2-input.js";
import { DEFAULT_STOCK_PARAMS } from "./stock.js";

const GAMMA = DEFAULT_WEIGHTS.discount;
function decision(chain = 6): PublicDecision {
  return {
    board: { width: 10, height: 40, cells: "_".repeat(400) },
    pieces: { current: "I", known: [], hold: null, holdAvailable: false },
    chain: { b2b: chain, combo: 0 },
    incoming: { pendingRows: 0, dueThisLockRows: 0 },
  };
}
const withWeights = (patch: Partial<Weights>): Weights => ({ ...DEFAULT_WEIGHTS, ...patch });
const fingerprint = (r: ReturnType<typeof search>) => JSON.stringify(r);

function cellsFrom(rowsFromFloor: readonly number[]): string {
  const cells = Array<string>(400).fill("_");
  rowsFromFloor.forEach((bits, i) => {
    for (let x = 0; x < 10; x += 1) if ((bits & (1 << x)) !== 0) cells[i * 10 + x] = "G";
  });
  return cells.join("");
}

describe("S2 C1 b2bState", () => {
  test("absent, zero and default are bit-identical with and without stock", () => {
    const { b2bState: _drop, ...absent } = DEFAULT_WEIGHTS;
    const input = toSharedInput(projectAttax(decision()));
    for (const stock of [undefined, DEFAULT_STOCK_PARAMS]) {
      const base = search(input, { profile: "s2", width: 48, weights: absent as Weights, stock });
      expect(
        fingerprint(
          search(input, { profile: "s2", width: 48, weights: withWeights({ b2bState: 0 }), stock }),
        ),
      ).toBe(fingerprint(base));
      expect(
        fingerprint(search(input, { profile: "s2", width: 48, weights: DEFAULT_WEIGHTS, stock })),
      ).toBe(fingerprint(base));
    }
  });

  test("adds gamma times b2bState per child whose exact chain remains alive", () => {
    const input = toSharedInput(projectAttax(decision()));
    const off = search(input, { profile: "s2", width: 48, weights: DEFAULT_WEIGHTS });
    const on = search(input, { profile: "s2", width: 48, weights: withWeights({ b2bState: 100 }) });
    expect(on?.best.placement).toEqual(off?.best.placement);
    expect(on?.candidates.length).toBe(off?.candidates.length);
    on?.candidates.forEach((candidate, i) => {
      expect(candidate.value - (off?.candidates[i]?.value ?? 0)).toBeCloseTo(GAMMA * 100, 9);
    });
    const dead = toSharedInput(projectAttax(decision(0)));
    expect(
      fingerprint(
        search(dead, { profile: "s2", width: 48, weights: withWeights({ b2bState: 100 }) }),
      ),
    ).toBe(fingerprint(search(dead, { profile: "s2", width: 48, weights: DEFAULT_WEIGHTS })));
  });

  test("off profiles retain identity; nonzero C1 separates and loads", () => {
    const dir = mkdtempSync(join(tmpdir(), "s2-adopt-test-"));
    const profile = (name: string, body: object) => {
      const path = join(dir, `${name}.json`);
      writeFileSync(path, JSON.stringify(body));
      return path;
    };
    const plain = createAttaxDecider(profile("plain", {}));
    const zero = createAttaxDecider(profile("zero", { b2bState: 0 }));
    const on = createAttaxDecider(profile("on", { b2bState: 40 }));
    expect(createAttaxDecider(undefined).weights).toEqual(DEFAULT_WEIGHTS);
    expect(createAttaxDecider(undefined).profileId).toBe("8cb9ead8c4451fc0");
    expect(plain.profileId).toBe(createAttaxDecider(undefined).profileId);
    expect(zero.profileId).toBe(plain.profileId);
    expect(on.profileId).not.toBe(plain.profileId);
    expect(on.weights.b2bState).toBe(40);
  });
});

describe("S2 C3 hole geometry", () => {
  const messy = [0x3ff ^ 1, 0x3ff ^ 1, 0x3ff ^ 8, 0x3ff ^ 8, 0x3ff ^ 0x80, 0x82];
  const boardFor = (rows: readonly number[]) =>
    projectAttax({ ...decision(), board: { width: 10, height: 40, cells: cellsFrom(rows) } });

  test("aligned, messy, split, and empty geometry", () => {
    const aligned = boardFor([0x3ff ^ 0x10, 0x3ff ^ 0x10, 0x3ff ^ 0x10, 0x3ff ^ 0x10, 0x10]);
    expect(boardFeatures(aligned.board, 0).holes).toBe(4);
    expect(holeGeometry(aligned.board)).toEqual({ runs: 1, shifts: 0 });
    const mixed = boardFor(messy);
    expect(boardFeatures(mixed.board, 0).holes).toBe(5);
    expect(boardFeatures(mixed.board, 0).holeRows).toBe(5);
    expect(holeGeometry(mixed.board)).toEqual({ runs: 3, shifts: 2 });
    expect(holeGeometry(boardFor([0x3ff ^ 0x20, 0x3ff, 0x3ff ^ 0x20, 0x20]).board)).toEqual({
      runs: 2,
      shifts: 0,
    });
    expect(holeGeometry(new Uint16Array(40))).toEqual({ runs: 0, shifts: 0 });
  });

  test("absent and zero preserve search identity, including with stock", () => {
    const input = toSharedInput(boardFor(messy));
    for (const stock of [undefined, DEFAULT_STOCK_PARAMS]) {
      const base = search(input, { profile: "s2", width: 48, weights: DEFAULT_WEIGHTS, stock });
      const zero = search(input, {
        profile: "s2",
        width: 48,
        weights: { ...DEFAULT_WEIGHTS, holeRuns: 0, holeShifts: 0 },
        stock,
      });
      expect(fingerprint(zero)).toBe(fingerprint(base));
    }
  });

  test("each root receives C3 value from its own post-lock board", () => {
    const input = toSharedInput(boardFor(messy));
    const off = search(input, { profile: "s2", width: 200, weights: DEFAULT_WEIGHTS });
    const on = search(input, {
      profile: "s2",
      width: 200,
      weights: { ...DEFAULT_WEIGHTS, holeRuns: -70, holeShifts: -30 },
    });
    if (!off || !on) throw new Error("no move");
    expect(on.candidates.length).toBe(off.candidates.length);
    for (const candidate of on.candidates) {
      const before = off.candidates.find(
        (item) => JSON.stringify(item.placement) === JSON.stringify(candidate.placement),
      );
      if (!before) throw new Error("candidate sets differ");
      const geom = holeGeometry(lockPlacement(input.board, candidate.placement).board);
      expect(candidate.value - before.value).toBeCloseTo(
        GAMMA * (geom.runs * -70 + geom.shifts * -30),
        6,
      );
    }
  });

  test("profiles load C3 and omit zero keys from identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "s2-c3-test-"));
    const write = (name: string, body: object) => {
      const path = join(dir, name);
      writeFileSync(path, JSON.stringify(body));
      return path;
    };
    const baseId = createAttaxDecider(undefined).profileId;
    expect(createAttaxDecider(write("zero.json", { holeRuns: 0, holeShifts: 0 })).profileId).toBe(
      baseId,
    );
    const on = createAttaxDecider(write("on.json", { holeRuns: -70, holeShifts: -30 }));
    expect(on.profileId).not.toBe(baseId);
    expect(on.weights.holeRuns).toBe(-70);
    expect(() => createAttaxDecider(write("bad.json", { board: { holeRuns: 1 } }))).toThrow(
      "unknown weight",
    );
    expect(() => createAttaxDecider(write("nan.json", { holeShifts: "x" }))).toThrow("finite");
  });
});
