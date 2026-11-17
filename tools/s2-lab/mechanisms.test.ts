/**
 * Item 100 mechanism keys on the S2 decider: profile parsing, env override
 * precedence, profile-identity stability, and engine forwarding.
 * Every case runs in its own process (fresh module cache + env), as the match
 * harness does.
 */
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "s2-mechanisms-test-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const player = new URL("./attax-player.ts", import.meta.url).pathname;
let counter = 0;

function profileFile(patch: unknown): string {
  const path = join(directory, `profile-${counter++}.json`);
  writeFileSync(path, JSON.stringify(patch));
  return path;
}

/** Build a decider in a fresh process and print its resolved identity/settings. */
function decider(profile: unknown, env: Record<string, string> = {}) {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("ATTAX_S2_") && k !== "ATTAX_ENGINE") base[k] = v;
  }
  const path = profile === undefined ? undefined : profileFile(profile);
  const run = spawnSync(
    process.execPath,
    [
      "-e",
      `
    import { createAttaxDecider } from ${JSON.stringify(player)};
    const d = createAttaxDecider(${JSON.stringify(path)});
    console.log(JSON.stringify({ profileId: d.profileId, mechanisms: d.mechanisms, settings: d.settings }));
    d.close();
  `,
    ],
    { env: { ...base, ATTAX_ENGINE: "ts-reference", ...env }, encoding: "utf8" },
  );
  return {
    status: run.status,
    stderr: run.stderr,
    out: run.status === 0 ? JSON.parse(run.stdout) : null,
  };
}

test("diverse: profile key accepts booleans and defaults off", () => {
  const off = decider(undefined);
  expect(off.status).toBe(0);
  expect(off.out.settings.diverse).toBe(false);
  const on = decider({ mechanisms: { diverse: true } });
  expect(on.status).toBe(0);
  expect(on.out.mechanisms).toEqual({ diverse: true });
  expect(on.out.settings.diverse).toBe(true);
  const explicitOff = decider({ mechanisms: { diverse: false } });
  expect(explicitOff.status).toBe(0);
  expect(explicitOff.out.settings.diverse).toBe(false);
});

test("diverse: non-boolean values and unknown mechanism keys are rejected", () => {
  for (const value of [1, 0, "true", null, {}]) {
    const r = decider({ mechanisms: { diverse: value } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("expected a boolean at mechanisms.diverse");
  }
  const unknown = decider({ mechanisms: { diversity: true } });
  expect(unknown.status).not.toBe(0);
  expect(unknown.stderr).toContain("unknown mechanism: mechanisms.diversity");
});

test("diverse: ATTAX_S2_DIVERSE overrides the profile; bad values fail loudly", () => {
  expect(decider(undefined, { ATTAX_S2_DIVERSE: "1" }).out.settings.diverse).toBe(true);
  expect(
    decider({ mechanisms: { diverse: true } }, { ATTAX_S2_DIVERSE: "0" }).out.settings.diverse,
  ).toBe(false);
  expect(
    decider({ mechanisms: { diverse: false } }, { ATTAX_S2_DIVERSE: "1" }).out.settings.diverse,
  ).toBe(true);
  for (const bad of ["true", "yes", "2", ""]) {
    const r = decider(undefined, { ATTAX_S2_DIVERSE: bad });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("ATTAX_S2_DIVERSE");
  }
});

test("identity: profiles without the key keep their identity; the key moves it", () => {
  const plainDefault = decider(undefined);
  const emptyPatch = decider({});
  expect(emptyPatch.out.profileId).toBe(plainDefault.out.profileId);
  // The env switch is a run setting, not a profile identity change.
  expect(decider(undefined, { ATTAX_S2_DIVERSE: "1" }).out.profileId).toBe(
    plainDefault.out.profileId,
  );
  const weightsOnly = decider({ attack: 7 });
  const stockOnly = decider({ attack: 7, mechanisms: { solvencyMode: "hard" } });
  const withDiverse = decider({ attack: 7, mechanisms: { solvencyMode: "hard", diverse: true } });
  expect(new Set([weightsOnly, stockOnly, withDiverse].map((r) => r.out.profileId)).size).toBe(3);
  // Key order in the file does not matter.
  const reordered = decider({ mechanisms: { diverse: true, solvencyMode: "hard" }, attack: 7 });
  expect(reordered.out.profileId).toBe(withDiverse.out.profileId);
});

test("diverse: the Rust payload carries diverse only when on", () => {
  const run = spawnSync(
    process.execPath,
    [
      "-e",
      `
    import { rustPayload } from ${JSON.stringify(player)};
    import { toSharedInput } from ${JSON.stringify(new URL("./s2-input.ts", import.meta.url).pathname)};
    import { DEFAULT_WEIGHTS } from ${JSON.stringify(new URL("../../src/ai/bot/weights.ts", import.meta.url).pathname)};
    const input = toSharedInput({ board: new Uint16Array(40), active: { kind: "T", rotation: 0, x: 3, y: 18 },
      hold: null, canHold: true, preview: ["I"], b2b: 0, combo: -1, pending: 0, dueThisLock: 0 });
    const base = { weights: DEFAULT_WEIGHTS, width: 8, rootVeto: false };
    console.log(JSON.stringify([
      JSON.parse(rustPayload(input, { ...base, diverse: false })).options,
      JSON.parse(rustPayload(input, { ...base, diverse: true })).options,
    ]));
  `,
    ],
    { env: { ...process.env, ATTAX_ENGINE: "ts-reference" }, encoding: "utf8" },
  );
  expect(run.status).toBe(0);
  const [off, on] = JSON.parse(run.stdout);
  expect(off).toEqual({ width: 8 });
  expect(on).toEqual({ width: 8, diverse: true });
});
