import { describe, expect, test } from "bun:test";
import { FAITHFUL_HOIKO, resolveFaithfulHoikoOptions } from "../src/ai/hoiko-faithful.js";
import { createRustHoiko } from "../tools/hoiko-rust/loader.js";

describe("faithful Hoiko opponent config (shipping binary)", () => {
  test("constant carries the binary config + derived search bounds", () => {
    expect(FAITHFUL_HOIKO).toEqual({
      weightPreset: "we",
      beamSizeLimit: 150,
      maxBeamSize: 50,
      adapt: true,
      depthLimit: 14,
      viewNext: 2,
    });
  });

  test("engine defaults to the faithful constant when constructed without options", () => {
    const fighter = createRustHoiko();

    expect(fighter.engine.adapt).toBe(true);
    expect(fighter.engine.depthLimit).toBe(14);
    expect(fighter.engine.viewNext).toBe(2);
    expect(fighter.engine.searchState).toEqual({
      maxBeamSize: 50,
      beamSizeLimit: 150,
      timerLimitMs: 1000,
    });
  });

  test("gate resolver defaults to the faithful constant when env is empty", () => {
    expect(resolveFaithfulHoikoOptions({})).toEqual({ ...FAITHFUL_HOIKO });
  });

  test("gate resolver keeps faithful beam and adaptation when HOIKO_BEAM overrides the cap", () => {
    expect(resolveFaithfulHoikoOptions({ HOIKO_BEAM: "1500" })).toEqual({
      ...FAITHFUL_HOIKO,
      beamSizeLimit: 1500,
    });
  });

  test("gate resolver disables adaptation when HOIKO_ADAPT=0", () => {
    expect(resolveFaithfulHoikoOptions({ HOIKO_ADAPT: "0" })).toEqual({
      ...FAITHFUL_HOIKO,
      adapt: false,
    });
  });

  test("gate resolver honors an explicit preset without touching the faithful bounds", () => {
    expect(resolveFaithfulHoikoOptions({}, "wo")).toEqual({
      ...FAITHFUL_HOIKO,
      weightPreset: "wo",
    });
  });

  test("gate resolver rejects malformed env values", () => {
    expect(() => resolveFaithfulHoikoOptions({ HOIKO_BEAM: "wide" })).toThrow(
      "HOIKO_BEAM must be an integer",
    );
    expect(() => resolveFaithfulHoikoOptions({ HOIKO_ADAPT: "yes" })).toThrow(
      "HOIKO_ADAPT must be 0 or 1",
    );
  });
});
