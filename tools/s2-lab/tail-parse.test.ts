import { describe, expect, test } from "bun:test";

import { parseServeBlock, parseServeBlockLight } from "./gpu-codec.js";
import {
  buildSyntheticServeBlock,
  checkReconciliation,
  checkSelectionConsistency,
  corpusMeanProfile,
  countMaterialized,
  measureCorpus,
  profileNodeCount,
} from "./tail-parse-harness.ts";

describe("tail instrument stage 1: synthetic corpus", () => {
  test("builder emits blocks whose full-parse node count matches the profile", () => {
    for (let seed = 1; seed <= 4; seed++) {
      const profile = corpusMeanProfile(seed);
      const block = buildSyntheticServeBlock(profile, seed);
      const parsed = parseServeBlock(block);
      expect(countMaterialized(parsed)).toBe(profileNodeCount(profile));
      expect(parsed.plies.length).toBe(15);
      // Corpus-mean band from the audit: ≈1,565 nodes/decision ± jitter.
      expect(profileNodeCount(profile)).toBeGreaterThan(1300);
      expect(profileNodeCount(profile)).toBeLessThan(1850);
    }
  });

  test("truncated synthetic blocks throw in both parse shapes", () => {
    const block = buildSyntheticServeBlock(corpusMeanProfile(1), 1);
    const cut = block.subarray(0, block.byteLength - 500);
    expect(() => parseServeBlock(cut)).toThrow();
    expect(() => parseServeBlockLight(cut)).toThrow();
  });
});

describe("tail instrument stage 1: gates", () => {
  const blocks = Array.from({ length: 6 }, (_, i) =>
    buildSyntheticServeBlock(corpusMeanProfile(i + 1), i + 1),
  );

  test("selection consistency: light and full agree on best and substituted candidates", () => {
    const gate = checkSelectionConsistency(blocks);
    expect(gate.failures).toEqual([]);
    expect(gate.ok).toBe(true);
    // Per block: best head + both candidates (candidate 1 restates the
    // best; candidate 2's node sits in ply 0's finished list).
    expect(gate.resultsCompared).toBe(blocks.length * 3);
  });

  test("reconciliation: measured records cover the corpus exactly once", () => {
    const records = measureCorpus(blocks, { reps: 3, warmup: 1, sclkRef: 0 });
    const gate = checkReconciliation(records, blocks, 3);
    expect(gate.failures).toEqual([]);
    expect(gate.ok).toBe(true);
    expect(records.length).toBe(blocks.length * 3);
    for (const r of records) {
      expect(r.parse_full_ns).toBeGreaterThan(0);
      expect(r.parse_light_ns).toBeGreaterThan(0);
      expect(r.nodes_skipped_plies).toBe(14);
    }
  });
});
