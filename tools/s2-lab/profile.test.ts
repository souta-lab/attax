import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WEIGHTS } from "../../src/ai/bot/weights.js";

let directory: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.ATTAX_S2_PROFILE;
  delete process.env.ATTAX_S2_PROFILE;
  directory = mkdtempSync(join(tmpdir(), "s2-profile-test-"));
});
afterEach(() => {
  if (previous === undefined) delete process.env.ATTAX_S2_PROFILE;
  else process.env.ATTAX_S2_PROFILE = previous;
  rmSync(directory, { recursive: true, force: true });
});
function load(patch?: unknown) {
  if (patch !== undefined) {
    const path = join(directory, "profile.json");
    writeFileSync(path, JSON.stringify(patch));
    process.env.ATTAX_S2_PROFILE = path;
  }
  // Each process gets its own module cache, just as the match harness does.
  return spawnSync(
    process.execPath,
    [
      "-e",
      `
    import { loadS2Weights } from ${JSON.stringify(new URL("./attax-player.ts", import.meta.url).pathname)};
    const first = loadS2Weights();
    process.env.ATTAX_S2_PROFILE = '/nonexistent/cache-check';
    if (loadS2Weights() !== first) throw new Error('load was not cached');
    console.log(JSON.stringify(first));
  `,
    ],
    { env: { ...process.env }, encoding: "utf8" },
  );
}

test("unset profile uses defaults and a stable cached identity", () => {
  const first = load();
  const second = load();
  expect(first.status).toBe(0);
  expect(second.status).toBe(0);
  const result = JSON.parse(first.stdout);
  expect(result.weights).toEqual(DEFAULT_WEIGHTS);
  expect(result.source).toBe("DEFAULT_WEIGHTS");
  expect(result.profileId).toMatch(/^[0-9a-f]{16}$/);
  expect(result.profileId).toBe(JSON.parse(second.stdout).profileId);
});

test("partial profiles merge nested keys and replace scalars", () => {
  const result = load({ board: { holes: -123 }, clear: { quad: 88 }, attack: 99 });
  expect(result.status).toBe(0);
  const profile = JSON.parse(result.stdout);
  expect(profile.weights).toEqual({
    ...DEFAULT_WEIGHTS,
    board: { ...DEFAULT_WEIGHTS.board, holes: -123 },
    clear: { ...DEFAULT_WEIGHTS.clear, quad: 88 },
    attack: 99,
  });
  expect(profile.source).toBe(join(directory, "profile.json"));
  const reordered = load({ attack: 99, clear: { quad: 88 }, board: { holes: -123 } });
  expect(reordered.status).toBe(0);
  expect(JSON.parse(reordered.stdout).profileId).toBe(profile.profileId);
});

test("unknown keys fail at every level", () => {
  for (const patch of [{ unknown: 1 }, { board: { unknown: 1 } }, { clear: { unknown: 1 } }]) {
    const result = load(patch);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("unknown weight");
  }
});
