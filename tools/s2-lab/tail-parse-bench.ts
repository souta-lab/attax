/**
 * Tail instrument stage 1 — offline S10 parse bench (GPU-free).
 *
 * Usage:
 *   bun tools/s2-lab/tail-parse-bench.ts [--blocks N] [--reps N]
 *       [--warmup N] [--out records.jsonl] [--recorded file.bin ...]
 *
 * Default corpus: synthetic serve blocks in the corpus-mean profile
 * (≈1,565 nodes/decision). With --recorded, the given raw serve-block
 * files are measured instead. Raw records (one JSONL row per measured
 * block, measured values only) go to --out when given; the printed
 * summary is the aggregation layer and is the only place clock
 * conversion ([見積]) appears (design §5.4).
 */

import { writeFileSync } from "node:fs";

import {
  buildSyntheticServeBlock,
  checkReconciliation,
  checkSelectionConsistency,
  corpusMeanProfile,
  loadRecordedBlocks,
  measureCorpus,
  profileNodeCount,
  sampleSclkMHz,
  segmentStats,
  threePointSet,
  timestampCostNs,
} from "./tail-parse-harness.ts";

function argInt(name: string, fallback: number): number {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = Number.parseInt(process.argv[i + 1], 10);
  if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`${name} needs a positive integer`);
  return v;
}

const nBlocks = argInt("--blocks", 24);
const reps = argInt("--reps", 15);
const warmup = argInt("--warmup", 3);
const outIdx = process.argv.indexOf("--out");
const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : null;
const recordedPaths: string[] = [];
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === "--recorded") {
    for (let j = i + 1; j < process.argv.length && !process.argv[j].startsWith("--"); j++) {
      recordedPaths.push(process.argv[j]);
    }
  }
}

const sclkStart = sampleSclkMHz();
const blocks =
  recordedPaths.length > 0
    ? loadRecordedBlocks(recordedPaths)
    : Array.from({ length: nBlocks }, (_, i) =>
        buildSyntheticServeBlock(corpusMeanProfile(i + 1), i + 1),
      );
const profileNodes = blocks.map((_b, i) =>
  recordedPaths.length > 0 ? null : profileNodeCount(corpusMeanProfile(i + 1)),
);

const selection = checkSelectionConsistency(blocks);
const tsCost = timestampCostNs();
const records = measureCorpus(blocks, { reps, warmup, sclkRef: 0 });
const sclkEnd = sampleSclkMHz();
const sclk = sclkStart ?? sclkEnd;
const reconciliation = checkReconciliation(records, blocks, reps);

if (outPath) {
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "header",
      instrument: "tail-stage1-offline-parse",
      definition_label: "tail_s10_offline",
      corpus: recordedPaths.length > 0 ? "recorded" : "synthetic-corpus-mean",
      blocks: blocks.length,
      reps,
      warmup,
      sclk_samples_mhz: [sclkStart, sclkEnd],
      timestamp_cost_ns: tsCost,
      nodes_per_block: profileNodes,
    }),
  );
  for (const r of records) lines.push(JSON.stringify({ type: "record", ...r }));
  writeFileSync(outPath, `${lines.join("\n")}\n`);
}

const fullStats = segmentStats(records.map((r) => r.parse_full_ns));
const lightStats = segmentStats(records.map((r) => r.parse_light_ns));
const avgNodes = records.reduce((a, r) => a + r.nodes_materialized, 0) / records.length;
const avgLightNodes = records.reduce((a, r) => a + r.nodes_materialized_light, 0) / records.length;
const avgBytes = records.reduce((a, r) => a + r.blockBytes, 0) / records.length;

const fmt = (ns: number) => `${(ns / 1000).toFixed(1)} µs`;
console.log(
  `corpus: ${blocks.length} blocks × ${reps} reps (warmup ${warmup}), avg ${avgNodes.toFixed(0)} nodes/block full, ${avgLightNodes.toFixed(0)} light, avg blockBytes ${avgBytes.toFixed(0)}`,
);
console.log(
  `sclk samples (MHz): start=${sclkStart} end=${sclkEnd}; performance.now() cost ${tsCost.toFixed(1)} ns/call`,
);
for (const [label, stats] of [
  ["S10f full parse ", fullStats],
  ["S10l light parse", lightStats],
] as const) {
  const tp = threePointSet(stats, sclk);
  console.log(
    `${label} [tail_s10]: measured median ${fmt(tp.measured.median_ns)} mean ${fmt(tp.measured.mean_ns)} p95 ${fmt(tp.measured.p95_ns)} (n=${tp.measured.n}) @ sclk ${tp.sclk_mhz} MHz, multiplier ${tp.clock_multiplier?.toFixed(3)} -> converted [見積] median ${tp.converted_estimate_ns.median_ns !== null ? fmt(tp.converted_estimate_ns.median_ns) : "n/a"}`,
  );
}
console.log(
  `gate selection-consistency: ${selection.ok ? "PASS" : "FAIL"} (${selection.blocksChecked} blocks, ${selection.resultsCompared} SearchResults compared)${selection.failures.length ? ` failures: ${selection.failures.join("; ")}` : ""}`,
);
console.log(
  `gate reconciliation: ${reconciliation.ok ? "PASS" : "FAIL"} (${records.length} records)${reconciliation.failures.length ? ` failures: ${reconciliation.failures.join("; ")}` : ""}`,
);
if (!selection.ok || !reconciliation.ok) process.exit(1);
