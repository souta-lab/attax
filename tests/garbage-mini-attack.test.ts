import { describe, expect, test } from "bun:test";
import { attackForClear } from "../src/core/garbage.js";

describe("mini T-spin attack table", () => {
  const base = { combo: 0, b2bActive: false, perfectClear: false } as const;

  test("mini T-spin single attacks for 0", () => {
    expect(attackForClear({ ...base, lines: 1, tspinLines: 0, tspinKind: "mini" })).toBe(0);
  });

  test("mini T-spin double attacks for 1", () => {
    expect(attackForClear({ ...base, lines: 2, tspinLines: 0, tspinKind: "mini" })).toBe(1);
  });

  test("full T-spin double still attacks for 4", () => {
    expect(attackForClear({ ...base, lines: 2, tspinLines: 2, tspinKind: "full" })).toBe(4);
  });

  test("a plain double is unaffected", () => {
    expect(attackForClear({ ...base, lines: 2, tspinLines: 0 })).toBe(1);
  });
});
