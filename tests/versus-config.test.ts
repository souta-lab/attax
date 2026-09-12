import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { GARBAGE_DELAY } from "../src/core/garbage.js";
import { resolveVersusConfig, VERSUS_MATCH_CONFIG } from "../src/versus/config.js";
import {
  createVersusController,
  VERSUS_DEFAULTS,
  type VersusControllerConfig,
  type VersusFighter,
} from "../src/versus/controller.js";

const CALL_SITE_FILES = [
  "src/main.ts",
  "scripts/gate-v2.ts",
  "scripts/hoiko-gate.ts",
  "src/ai/fitness.ts",
  "src/tuner/match.ts",
  "scripts/render.ts",
] as const;

function readSource(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function controllerCalls(source: string): string[] {
  const marker = "createVersusController(";
  const calls: string[] = [];
  let index = source.indexOf(marker);
  while (index !== -1) {
    let depth = 0;
    let end = index + marker.length - 1;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    calls.push(source.slice(index, end));
    index = source.indexOf(marker, end);
  }
  return calls;
}

function firstLockedBoard(config?: VersusControllerConfig): string {
  const idle: VersusFighter = {
    name: "idle",
    color: "#000",
    findBestMove: () => null,
  };
  const controller =
    config === undefined
      ? createVersusController(idle, idle, 7)
      : createVersusController(idle, idle, 7, config);
  controller.left.core.receiveGarbage?.(2);
  controller.tick(VERSUS_DEFAULTS.stepIntervalMs, VERSUS_DEFAULTS);
  return controller.left.core
    .getSnapshot()
    .board.grid.map((row) => row.join(""))
    .join("|");
}

describe("versus match config (issue #25)", () => {
  test("resolver returns the fully-resolved canonical config", () => {
    expect(resolveVersusConfig()).toEqual(VERSUS_MATCH_CONFIG);
    expect(resolveVersusConfig()).toEqual({
      garbageAligned: true,
      garbageDelay: GARBAGE_DELAY,
    });
    expect(resolveVersusConfig()).not.toBe(resolveVersusConfig());
  });

  test("omitted fields fall back to the canonical config", () => {
    expect(resolveVersusConfig({ garbageDelay: 3 })).toEqual({
      garbageAligned: true,
      garbageDelay: 3,
    });
    expect(resolveVersusConfig({ garbageAligned: false })).toEqual({
      garbageAligned: false,
      garbageDelay: GARBAGE_DELAY,
    });
  });

  test("controller defaults to the canonical config for omitted or empty configs", () => {
    const canonical = firstLockedBoard(resolveVersusConfig());
    expect(firstLockedBoard()).toBe(canonical);
    expect(firstLockedBoard({})).toBe(canonical);
    expect(firstLockedBoard({ garbageAligned: false })).not.toBe(canonical);
  });

  test("every app/harness call site resolves through the shared config", () => {
    for (const file of CALL_SITE_FILES) {
      const calls = controllerCalls(readSource(file));
      expect(calls.length, `${file} should construct a versus controller`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call, `${file} must pass the shared config`).toMatch(
          /resolveVersusConfig\(|VERSUS_MATCH_CONFIG/,
        );
        expect(call, `${file} must not inline a divergent garbage config`).not.toMatch(
          /garbageAligned|garbageDelay/,
        );
      }
    }
  });
});
