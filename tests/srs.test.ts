import { describe, expect, test } from "bun:test";
import { asRotation, isTspinKick, kickTable } from "../src/core/srs.js";

describe("SRS kick tables", () => {
  test("JLSTZ 0>1 has 5 kicks starting with 0,0", () => {
    const k = kickTable("T", 0, 1);
    expect(k.length).toBe(5);
    expect(k[0]).toEqual({ dx: 0, dy: 0 });
    expect(k[1]).toEqual({ dx: -1, dy: 0 });
  });
  test("I 0>1 differs from JLSTZ", () => {
    const i = kickTable("I", 0, 1);
    const t = kickTable("T", 0, 1);
    expect(i.length).toBe(5);
    expect(i[1]).not.toEqual(t[1]);
  });
  test("O has no kicks", () => {
    expect(kickTable("O", 0, 1).length).toBe(1);
  });
  test("TST kick is 5th entry", () => {
    expect(isTspinKick("T", 4)).toBe(true);
    expect(isTspinKick("T", 0)).toBe(false);
    expect(isTspinKick("S", 4)).toBe(false);
  });
  test("asRotation wraps", () => {
    expect(asRotation(-1)).toBe(3);
    expect(asRotation(4)).toBe(0);
  });
});
