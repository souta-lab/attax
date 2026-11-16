/**
 * Capture pre-port golden results for the chunk 3b battery.
 * Run BEFORE the single-core port: bun tools/unify/capture-s2-golden.ts
 * Writes tools/unify/s2-golden.json. Do not re-run after the port — the
 * fixture is the pre-port behaviour record.
 */
import { writeFileSync } from "node:fs";
import { search as srcSearch } from "../../src/ai/bot/search.js";
import { search as s2Search } from "../s2-lab/search.js";
import { guidelineBattery, s2Battery } from "./s2-battery.js";

const out: Record<string, unknown> = { s2: {}, guideline: {} };
for (const c of s2Battery()) {
  (out.s2 as Record<string, unknown>)[c.name] = s2Search(c.input, c.options);
}
for (const c of guidelineBattery()) {
  (out.guideline as Record<string, unknown>)[c.name] = srcSearch(c.input, c.options);
}
const path = new URL("./s2-golden.json", import.meta.url).pathname;
writeFileSync(path, `${JSON.stringify(out, null, 1)}\n`);
console.log(`wrote ${path}`);
