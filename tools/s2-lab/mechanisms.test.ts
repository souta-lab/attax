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

test("garbageScenarios: profile key parses non-empty non-negative integer arrays", () => {
  const off = decider(undefined);
  expect(off.out.settings.garbageScenarios).toBeNull();
  const on = decider({ mechanisms: { garbageScenarios: [0, 4, 8] } });
  expect(on.status).toBe(0);
  expect(on.out.mechanisms).toEqual({ garbageScenarios: [0, 4, 8] });
  expect(on.out.settings.garbageScenarios).toEqual([0, 4, 8]);
  for (const bad of [[], [-1], [1.5], ["4"], 4, null, { 0: 4 }]) {
    const r = decider({ mechanisms: { garbageScenarios: bad } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("mechanisms.garbageScenarios");
  }
});

test("garbageScenarios: ATTAX_S2_GARBAGE_SCENARIOS precedence and validation", () => {
  const profile = { mechanisms: { garbageScenarios: [4] } };
  expect(decider(profile).out.settings.garbageScenarios).toEqual([4]);
  expect(
    decider(profile, { ATTAX_S2_GARBAGE_SCENARIOS: "" }).out.settings.garbageScenarios,
  ).toEqual([4]);
  expect(
    decider(profile, { ATTAX_S2_GARBAGE_SCENARIOS: "off" }).out.settings.garbageScenarios,
  ).toBeNull();
  expect(
    decider(profile, { ATTAX_S2_GARBAGE_SCENARIOS: "0,6,12" }).out.settings.garbageScenarios,
  ).toEqual([0, 6, 12]);
  expect(
    decider(undefined, { ATTAX_S2_GARBAGE_SCENARIOS: "3" }).out.settings.garbageScenarios,
  ).toEqual([3]);
  for (const bad of ["4,", ",4", "-1", "1.5", "on", "4 8", "a"]) {
    const r = decider(undefined, { ATTAX_S2_GARBAGE_SCENARIOS: bad });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("ATTAX_S2_GARBAGE_SCENARIOS");
  }
});

test("garbageScenarios: identity includes the key only when present", () => {
  const base = decider({ attack: 5 });
  const withKey = decider({ attack: 5, mechanisms: { garbageScenarios: [4] } });
  const other = decider({ attack: 5, mechanisms: { garbageScenarios: [4, 8] } });
  expect(new Set([base, withKey, other].map((r) => r.out.profileId)).size).toBe(3);
  expect(decider({ attack: 5 }, { ATTAX_S2_GARBAGE_SCENARIOS: "4" }).out.profileId).toBe(
    base.out.profileId,
  );
});

test("garbageScenarios: a Rust-engine decider refuses at construction", () => {
  // A stand-in binary that passes the handshake, so the refusal (not a missing
  // binary) is what fails — independent of whether the real CLI is built.
  const fake = join(directory, "fake-attax-agree");
  writeFileSync(fake, `#!/bin/sh\necho '{"engine":"rust","build":"test"}'\n`, { mode: 0o755 });
  const refused = decider(
    { mechanisms: { garbageScenarios: [4] } },
    { ATTAX_ENGINE: "rust", ATTAX_RUST_CLI: fake },
  );
  expect(refused.status).not.toBe(0);
  expect(refused.stderr).toContain("not implemented on the Rust engine");
  const viaEnv = decider(undefined, {
    ATTAX_ENGINE: "rust",
    ATTAX_RUST_CLI: fake,
    ATTAX_S2_GARBAGE_SCENARIOS: "4",
  });
  expect(viaEnv.status).not.toBe(0);
  // Off (or turned off by env) constructs fine on Rust.
  expect(
    decider(
      { mechanisms: { garbageScenarios: [4] } },
      { ATTAX_ENGINE: "rust", ATTAX_RUST_CLI: fake, ATTAX_S2_GARBAGE_SCENARIOS: "off" },
    ).status,
  ).toBe(0);
});

test("garbageScenarios: the TS decider runs the scenario search", () => {
  const path = profileFile({ mechanisms: { garbageScenarios: [6] } });
  const run = spawnSync(
    process.execPath,
    [
      "-e",
      `
    import { createAttaxDecider, projectAttax } from ${JSON.stringify(player)};
    import { toSharedInput } from ${JSON.stringify(new URL("./s2-input.ts", import.meta.url).pathname)};
    import { search } from ${JSON.stringify(new URL("../../src/ai/bot/search.ts", import.meta.url).pathname)};
    import { DEFAULT_WEIGHTS } from ${JSON.stringify(new URL("../../src/ai/bot/weights.ts", import.meta.url).pathname)};
    const rows = [767, 1019, 1007, 767, 1022, 1022];
    let cells = "";
    for (let y = 0; y < 40; y++) for (let x = 0; x < 10; x++) {
      const r = 39 - y; const i = r - 34;
      cells += i >= 0 && (rows[i] >> x) & 1 ? "G" : "_";
    }
    const decision = { lockTime: { logicalFrame: 0 }, board: { width: 10, height: 40, cells },
      pieces: { current: "S", known: ["J", "I", "S", "J", "I"], hold: null, holdAvailable: true },
      chain: { combo: 0, b2b: 0 }, incoming: { pendingRows: 2, dueThisLockRows: 0 } };
    const d = createAttaxDecider(${JSON.stringify(path)}, { width: 16 });
    const got = await d.decideAsync(decision);
    const input = toSharedInput(projectAttax(decision));
    const opts = { weights: DEFAULT_WEIGHTS, width: 16, profile: "s2" };
    console.log(JSON.stringify({
      got: got.candidates,
      want: search(input, { ...opts, garbageScenarios: [6] }).candidates,
      plain: search(input, opts).candidates,
    }));
  `,
    ],
    { env: { ...process.env, ATTAX_ENGINE: "ts-reference" }, encoding: "utf8" },
  );
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  const { got, want, plain } = JSON.parse(run.stdout);
  expect(got).toEqual(want);
  expect(got).not.toEqual(plain);
});
