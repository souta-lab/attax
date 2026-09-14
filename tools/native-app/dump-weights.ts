/**
 * Native-app Phase 2 fixture generator: the faithful Hoiko VS weight list.
 *
 *   bun tools/native-app/dump-weights.ts
 *
 * Dumps `hoikoWeightList("we")` (the four VS weight files `we`, `wo`, `wd`,
 * `wr`, in `TransitionWeight` index order) to
 * `evidence/native-app/hoiko-weights.json`. `rust/ai-fighters` embeds the same
 * tables and its `presets` test asserts they match this fixture, so the native
 * search inputs cannot silently drift from the TS adapter's.
 */

import { writeFileSync } from "node:fs";
import { hoikoPresetWeights, hoikoWeightList } from "../../src/ai/hoiko-weights.js";

const list = hoikoWeightList("we");
const index: Record<string, number> = {};
for (const name of ["we", "wo", "wd", "wr"] as const) {
  const weights = hoikoPresetWeights(name);
  const found = list.findIndex((entry) => entry === weights);
  if (found < 0) throw new Error(`${name} missing from hoikoWeightList("we")`);
  index[name] = found;
}

const out = new URL("../../evidence/native-app/hoiko-weights.json", import.meta.url);
writeFileSync(out, `${JSON.stringify({ index, weightList: list })}\n`);
console.log(`wrote evidence/native-app/hoiko-weights.json (${list.length} entries)`);
