/**
 * Capture golden results for the chunk 3b battery.
 *
 * The committed tools/unify/s2-golden.json was originally captured BEFORE the
 * single-core port, against the former private lab search (since deleted) for
 * S2 and src/ai/bot/search.ts for guideline, at width 48 — the pre-port
 * behaviour record. On 2026-11-17 the width-48 reproduction path was retired
 * and the goldens were re-captured from the shared core at the shipped
 * standard width 96, which is what the committed file now holds. The S2 side
 * runs the shared search under profile "s2" (the lab input mapped through
 * toSharedInput, as the player does); write to a scratch path and compare
 * bytes to re-verify the record:
 *
 *   bun tools/unify/capture-s2-golden.ts /tmp/s2-golden.check.json
 *   cmp /tmp/s2-golden.check.json tools/unify/s2-golden.json
 *
 * With no argument it writes tools/unify/s2-golden.json (the original capture
 * command).
 */
import { writeFileSync } from "node:fs";
import { search } from "../../src/ai/bot/search.js";
import { toSharedInput } from "../s2-lab/s2-input.js";
import { guidelineBattery, s2Battery } from "./s2-battery.js";

const out: Record<string, unknown> = { s2: {}, guideline: {} };
for (const c of s2Battery()) {
  (out.s2 as Record<string, unknown>)[c.name] = search(toSharedInput(c.input), {
    ...c.options,
    profile: "s2",
  });
}
for (const c of guidelineBattery()) {
  (out.guideline as Record<string, unknown>)[c.name] = search(c.input, c.options);
}
const path = process.argv[2] ?? new URL("./s2-golden.json", import.meta.url).pathname;
writeFileSync(path, `${JSON.stringify(out, null, 1)}\n`);
console.log(`wrote ${path}`);
