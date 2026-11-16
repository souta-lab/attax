import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
