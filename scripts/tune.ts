import type { Weights } from "../src/ai/weights.js";
import { DU_WEIGHTS } from "../src/ai/weights.js";
import { runBench, setBenchWeights } from "./bench.js";

const AXES: ReadonlyArray<{ readonly key: keyof Weights; readonly deltas: readonly number[] }> = [
  { key: "holes", deltas: [-4, 0, 4] },
  { key: "rowsWithHoles", deltas: [-6, 0, 6] },
  { key: "colTransitions", deltas: [-2, 0, 2] },
  { key: "wells", deltas: [-2, 0, 2] },
  { key: "holeDepth", deltas: [-1, 0, 1] },
  { key: "landingHeight", deltas: [-1, 0, 1] },
];

function withDelta(base: Weights, key: keyof Weights, delta: number): Weights {
  return { ...base, [key]: base[key] + delta };
}

const seeds = [1, 2, 3, 4, 5];
let best: Weights = DU_WEIGHTS;
let bestLines = runBenchWithWeights(best, "base");

for (const axis of AXES) {
  let improved = false;
  for (const d of axis.deltas) {
    if (d === 0) continue;
    const cand = withDelta(best, axis.key, d);
    const lines = runBenchWithWeights(cand, `${String(axis.key)}${d > 0 ? "+" : ""}${d}`);
    if (lines > bestLines) {
      bestLines = lines;
      best = cand;
      improved = true;
    }
  }
  console.log(
    `axis ${String(axis.key)}: improved=${improved} best=${best[axis.key]} lines=${bestLines.toFixed(1)}`,
  );
}

console.log(`FINAL lines=${bestLines.toFixed(1)} weights=${JSON.stringify(best)}`);

function runBenchWithWeights(w: Weights, label: string): number {
  setBenchWeights(w);
  try {
    const r = runBench(label, "beam16", seeds, 2000);
    console.log(`  cand lines=${r.avgLines.toFixed(1)} pieces=${r.avgPieces.toFixed(0)}`);
    return r.avgLines;
  } finally {
    setBenchWeights(null);
  }
}
