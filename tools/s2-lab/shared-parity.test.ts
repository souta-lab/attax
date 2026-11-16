/**
 * Chunk 3b parity: the shared src search under profile "s2" IS the lab search,
 * and the guideline path is unchanged. Every battery case must reproduce the
 * pre-port golden result EXACTLY (deep equality, floats included).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { type SearchInput, type SearchOptions, search } from "../../src/ai/bot/search.js";
import { guidelineBattery, type S2Case, s2Battery } from "../unify/s2-battery.js";

const golden = JSON.parse(
  readFileSync(new URL("../unify/s2-golden.json", import.meta.url), "utf8"),
) as { s2: Record<string, unknown>; guideline: Record<string, unknown> };

/**
 * The battery's S2 inputs use the lab input shape, whose `b2b` is the exact
 * chain number. The src input keeps `b2b` boolean and carries the chain in
 * `b2bChain`; every other field is shared verbatim. (Lane B re-points the
 * battery's types at src once the lab search is deleted.)
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
      // Compare in the golden's JSON space: JSON cannot encode -0 (breakdown
      // terms like 0 × negative weight), and doubles round-trip exactly.
      expect(JSON.parse(JSON.stringify(result))).toEqual(golden.s2[c.name]);
    });
  }
  for (const c of guidelineBattery()) {
    test(`guideline: ${c.name}`, () => {
      const result = search(c.input, c.options);
      // Same JSON space as above (-0 breakdown terms).
      expect(JSON.parse(JSON.stringify(result))).toEqual(golden.guideline[c.name]);
    });
  }
});
