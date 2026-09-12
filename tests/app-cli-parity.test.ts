import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FAITHFUL_HOIKO, resolveFaithfulHoikoOptions } from "../src/ai/hoiko-faithful.js";
import { VERSUS_DEFAULTS } from "../src/versus/controller.js";
import { isSpeed, speedOptions } from "../src/versus/speed.js";
import { createRustDeepSeekV2 } from "../tools/deepseek-rust/loader.js";
import { createRustHoiko, makeRustHoiko } from "../tools/hoiko-rust/loader.js";
import {
  captureDecisionSnapshots,
  capturedGroup,
  deepSeekDecision,
  deepSeekEngineSettings,
  hoikoDecision,
  hoikoEngineSettings,
  readGateV2Defaults,
  readSource,
  requireSnapshot,
} from "./support/app-cli-parity-fixtures.js";

const BROWSER_LOADER_URL = new URL("../src/ai/hoiko-rust.ts", import.meta.url);
const CLI_LOADER_URL = new URL("../tools/hoiko-rust/loader.ts", import.meta.url);

const snapshots = captureDecisionSnapshots(20, 1234);

describe("app vs CLI/gate parity", () => {
  test("browser and CLI Hoiko loaders resolve to the same wasm bytes", () => {
    const browserSource = readSource(BROWSER_LOADER_URL);
    const cliSource = readSource(CLI_LOADER_URL);

    const browserSpecifier = capturedGroup(
      browserSource,
      /import wasmUrl from "([^"]+)"/,
      "browser wasm import",
    );
    const browserUrl = new URL(browserSpecifier, BROWSER_LOADER_URL);
    browserUrl.search = "";
    const browserWasmPath = fileURLToPath(browserUrl);

    const cliSpecifier = capturedGroup(
      cliSource,
      /new URL\("([^"]+)", import\.meta\.url\)/,
      "CLI wasm path",
    );
    const cliWasmPath = fileURLToPath(new URL(cliSpecifier, CLI_LOADER_URL));

    expect(browserWasmPath.endsWith("/src/ai/wasm/hoiko_core.wasm")).toBe(true);
    expect(realpathSync(browserWasmPath)).toBe(realpathSync(cliWasmPath));

    const bytes = readFileSync(browserWasmPath);
    expect(WebAssembly.validate(bytes)).toBe(true);
    expect(createHash("sha256").update(bytes).digest("hex")).toHaveLength(64);
    const exported = WebAssembly.Module.exports(new WebAssembly.Module(bytes)).map(
      (entry) => entry.name,
    );
    expect(exported).toEqual(
      expect.arrayContaining([
        "h_alloc",
        "h_search",
        "h_search_input_size",
        "h_search_output_size",
      ]),
    );

    expect(browserSource).toMatch(/makeRustHoiko\(instance, options\)/);
    expect(cliSource).toMatch(/makeRustHoiko\(instance, options\)/);

    const direct = makeRustHoiko(new WebAssembly.Instance(new WebAssembly.Module(bytes)), {
      adapt: false,
    });
    const viaLoader = createRustHoiko({ adapt: false });
    const snapshot = requireSnapshot(snapshots[0], "wasm identity");
    expect(hoikoDecision(direct, snapshot).out).toEqual(hoikoDecision(viaLoader, snapshot).out);
  });

  test("default app Hoiko config equals the gate resolver output", () => {
    const appDefault = createRustHoiko();
    const gateDefault = createRustHoiko(resolveFaithfulHoikoOptions({}));

    expect(resolveFaithfulHoikoOptions({})).toEqual({ ...FAITHFUL_HOIKO });
    expect(hoikoEngineSettings(appDefault)).toEqual(hoikoEngineSettings(gateDefault));
    expect(hoikoEngineSettings(appDefault)).toEqual({
      adapt: true,
      depthLimit: 14,
      viewNext: 2,
      isEvenBoard: true,
      framesPerThink: 20,
      offsetEnabled: 1,
      searchState: { maxBeamSize: 50, beamSizeLimit: 150, timerLimitMs: 1000 },
    });
  });

  test("engine decisions match on identical snapshots (deterministic beam)", () => {
    expect(snapshots.length).toBeGreaterThanOrEqual(8);
    const appPath = createRustHoiko({ adapt: false });
    const gatePath = createRustHoiko({ ...resolveFaithfulHoikoOptions({}), adapt: false });

    for (const [index, snapshot] of snapshots.entries()) {
      const appResult = hoikoDecision(appPath, snapshot);
      const gateResult = hoikoDecision(gatePath, snapshot);
      const appTuple = [
        appResult.out.x,
        appResult.out.firstRRaw,
        appResult.out.firstM,
        appResult.out.garbageWait,
      ];
      const gateTuple = [
        gateResult.out.x,
        gateResult.out.firstRRaw,
        gateResult.out.firstM,
        gateResult.out.garbageWait,
      ];
      expect(gateTuple, `snapshot #${index}`).toEqual(appTuple);
      expect(gateResult.out, `snapshot #${index} full out`).toEqual(appResult.out);
      expect(gateResult.move, `snapshot #${index} move`).toEqual(appResult.move);
    }
  });

  test("app Rust DeepSeek path equals the gate's DSV2_RUST=1 option set", () => {
    const appPath = createRustDeepSeekV2();
    const gatePath = createRustDeepSeekV2(readGateV2Defaults());

    expect(deepSeekEngineSettings(appPath)).toEqual({
      depth: 7,
      width: 24,
      topK: 16,
      useKicks: true,
      useOpponent: true,
      useGarbageDefense: true,
      useDownstack: true,
    });
    expect(deepSeekEngineSettings(gatePath)).toEqual(deepSeekEngineSettings(appPath));

    for (const [index, snapshot] of snapshots.entries()) {
      const appResult = deepSeekDecision(appPath, snapshot);
      const gateResult = deepSeekDecision(gatePath, snapshot);
      expect(gateResult.out, `snapshot #${index}`).toEqual(appResult.out);
      expect(gateResult.move, `snapshot #${index} move`).toEqual(appResult.move);
    }
  });

  test("app 1x speed options equal the gate/controller defaults", () => {
    expect(speedOptions(1)).toEqual(VERSUS_DEFAULTS);
    expect(speedOptions(2)).toEqual({
      ...VERSUS_DEFAULTS,
      stepIntervalMs: VERSUS_DEFAULTS.stepIntervalMs / 2,
      gravityMs: VERSUS_DEFAULTS.gravityMs / 2,
    });
    expect(isSpeed(1)).toBe(true);
    expect(isSpeed(3)).toBe(false);
  });

  test("app and gate call sites construct the same fighters, config and speed", () => {
    const app = readSource(new URL("../src/main.ts", import.meta.url));
    const gate = readSource(new URL("../scripts/gate-v2.ts", import.meta.url));

    expect(app).toMatch(/createRustHoiko\(\)/);
    expect(app).toMatch(/from "\.\/versus\/speed\.js"/);
    expect(app).toMatch(/speedOptions\(speed\)/);
    expect(app).toMatch(/createVersusController\(\s*hoiko,/);
    expect(app).toMatch(/resolveVersusConfig\(\)/);

    expect(gate).toMatch(/resolveFaithfulHoikoOptions\(process\.env, preset\)/);
    expect(gate).toMatch(/createRustHoiko\(hoiko\)/);
    expect(gate).toMatch(
      /createVersusController\(\s*ourFighter,\s*hoikoFighter,\s*seed,\s*resolveVersusConfig\(\)/,
    );
    expect(gate).toMatch(/VERSUS_DEFAULTS/);
  });
});
