import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../../", import.meta.url));
const defaults = {
  iterations: "60",
  "games-per-eval": "4",
  "seed-base": "20011",
  "eval-stride": "10",
  "profile-out": "tools/s2-lab/profiles/s2-tuned.json",
  state: "/tmp/s2-spsa-state.json",
  log: "/home/hatch/workspace/attax-s2/S2-TUNING-LOG.md",
  a0: "0.3",
  c0: "0.12",
  "start-profile": "tools/s2-lab/profiles/s2-seed.json",
  concurrency: "2",
  "eval-runner": "",
  // Campaign 2 (S2-CAMPAIGN2-DESIGN.md): dense survival term weight
  // (0 = campaign-1 objective, byte-identical), frozen SPSA group
  // indices (comma-separated), best-eval/snapshot profile namespace.
  "survival-weight": "0",
  "frozen-groups": "",
  "profile-namespace": "league",
  "adopt-groups": "",
  "adopt-scale": "1",
  // Item 98 (2026-11-16): per-successful-update profile snapshots for the
  // frozen late-iterate-average candidate, and a dry-run mode that builds
  // the iteration-1 arms, asserts every non-frozen coordinate (including
  // zero-initialised ones) differs between them, and exits.
  "iterate-dir": "",
  "dry-run-out": "",
};
const { values } = parseArgs({
  options: {
    ...Object.fromEntries(
      Object.entries(defaults).map(([k, v]) => [k, { type: "string", default: v }]),
    ),
    league: { type: "boolean", default: false },
    // Campaign 2: opponent is always the champion (no pool sampling,
    // no snapshot cadence); all league error/stop machinery applies.
    "champion-only": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});
function number(key, min, integer = true) {
  const n = Number(values[key]);
  if (!Number.isFinite(n) || n < min || (integer && !Number.isSafeInteger(n)))
    throw new Error(`invalid --${key}`);
  return n;
}
const iterations = number("iterations", 0);
const games = number("games-per-eval", 2);
if (games % 2) throw new Error("--games-per-eval must be even");
const seedBase = number("seed-base", 0);
const stride = number("eval-stride", 1);
const concurrency = number("concurrency", 1);
const a0 = number("a0", Number.MIN_VALUE, false);
const c0 = number("c0", Number.MIN_VALUE, false);
const survivalWeight = number("survival-weight", 0, false);
const profileNamespace = values["profile-namespace"];
if (!/^[a-z0-9-]+$/.test(profileNamespace)) throw new Error("invalid --profile-namespace");
if (seedBase + stride * Math.max(0, iterations - 1) + games - 1 > 0xffffffff)
  throw new Error("seed range overflows uint32");
const profileOut = resolve(root, values["profile-out"]);
const statePath = resolve(root, values.state);
const logPath = resolve(root, values.log);
const groups = [
  ["attack"],
  ["conversion"],
  ["clear.quad", "clear.tspinMini", "clear.tspinSingle", "clear.tspinDouble", "clear.tspinTriple"],
  ["b2bBreak"],
  ["clear.single", "clear.double", "clear.triple"],
  ["board.holes", "board.holeCover", "board.holeRows"],
  ["board.maxHeight", "board.danger"],
  ["board.bumpiness", "board.bumpinessSq", "board.rowTransitions"],
  ["board.wellDepth", "board.extraWells"],
  ["board.tSlot", "wastedT"],
  ["clear.perfectClear"],
];
const adoptGroupTags = {
  c1: ["b2bState"],
  c3: ["holeRuns", "holeShifts"],
  c5: ["miniSingleDelta", "miniDoubleDelta", "miniTripleDelta"],
};
const adoptScale = number("adopt-scale", 1, false);
const adoptPaths = new Set();
for (const tag of (values["adopt-groups"] || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)) {
  const paths = adoptGroupTags[tag];
  if (!paths) throw new Error(`unknown --adopt-groups tag ${tag}`);
  for (const path of paths) {
    if (adoptPaths.has(path)) continue;
    adoptPaths.add(path);
    groups.push([path]);
  }
}
// Item 98: the Φ (stock potential) parameters are joint SPSA dimensions
// with γ (Fable GO condition: γ tested jointly with Φ). They ride in the
// profile's mechanisms.stock section and are appended as singleton groups;
// the start profile must carry the section (config O values), and every
// arm profile the driver writes carries its own perturbed copy.
const PHI_PATHS = ["stock.scale", "stock.betaB", "stock.betaR"];
for (const path of PHI_PATHS) groups.push([path]);
const COORD_CLAMPS = {
  "stock.scale": [0, 2],
  "stock.betaB": [0, 1.5],
  "stock.betaR": [0, 1.5],
};
// γ (the profile's discount) is a raw-space SPSA coordinate with its own
// gains and the Fable clamp [0.95, 0.995]; it is not part of the u-space
// groups (its seed scale is 1, so u and raw coincide, but its perturbation
// and step sizes are absolute, not relative).
const GAMMA_CLAMP = [0.95, 0.995];
const gammaC = (k) => 0.005 / (k + 1) ** 0.101;
const gammaA = (k) => 0.0005 / (k + 11) ** 0.602;
const frozenGroups = new Set(
  (values["frozen-groups"] || "")
    .split(",")
    .filter((s) => s.trim() !== "")
    .map((s) => Number(s.trim())),
);
for (const i of frozenGroups)
  if (!Number.isSafeInteger(i) || i < 0 || i >= groups.length)
    throw new Error(`invalid frozen group index ${i}`);
function flatten(profile) {
  const entries = [];
  for (const [key, value] of Object.entries(profile)) {
    if (key === "mechanisms") {
      // Only the Φ (stock) section is a tuning coordinate set; any other
      // mechanism section in a start profile is a configuration error.
      for (const section of Object.keys(value))
        if (section !== "stock") throw new Error(`unsupported mechanisms section ${section}`);
      for (const [k, v] of Object.entries(value.stock ?? {})) entries.push([`stock.${k}`, v]);
    } else if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) entries.push([`${key}.${k}`, v]);
    } else entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}
function expand(flat) {
  const profile = { board: {}, clear: {} };
  for (const [path, value] of Object.entries(flat)) {
    const [a, b] = path.split(".");
    if (a === "stock") {
      profile.mechanisms ??= { stock: {} };
      profile.mechanisms.stock[b] = value;
    } else if (b) profile[a][b] = value;
    else profile[a] = value;
  }
  return profile;
}
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
async function atomic(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, contents);
  await rename(temp, path);
}
const seedProfile = JSON.parse(await readFile(resolve(root, values["start-profile"]), "utf8"));
const seedFlat = flatten(seedProfile);
const expected = [...groups.flat(), "discount"];
if (
  Object.keys(seedFlat).length !== expected.length ||
  expected.some((p) => !Number.isFinite(seedFlat[p]))
)
  throw new Error("start profile must contain all weights and no unknown keys");
const seedScales = Object.fromEntries(
  Object.entries(seedFlat).map(([p, v]) => [
    p,
    Math.max(adoptPaths.has(p) ? adoptScale : 1, Math.abs(v)),
  ]),
);
let state = {
  iteration: 0,
  thetaU: Object.fromEntries(Object.entries(seedFlat).map(([p, v]) => [p, v / seedScales[p]])),
  seedProfile,
  scales: { ...seedScales },
  history: [],
  successfulUpdates: 0,
};
if (values.league) {
  delete state.iteration;
  Object.assign(state, {
    league: true,
    leagueIteration: 0,
    pool: [
      { id: "champion", kind: "champion", active: true },
      {
        id: "seed",
        kind: "attax-profile",
        profile: resolve(root, values["start-profile"]),
        active: true,
      },
      {
        id: "iter12",
        kind: "attax-profile",
        profile: "tools/s2-lab/profiles/s2-iter12.json",
        active: true,
      },
    ],
    snapshotCount: 0,
    evalWindow: [],
    bestEval: null,
  });
}
try {
  state = JSON.parse(await readFile(statePath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (!!state.league !== values.league) throw new Error("state mode does not match --league");
for (const p of groups.flat())
  if (!Number.isFinite(state.thetaU[p]))
    throw new Error(`state has no coordinate for ${p} (adopt groups must match the state)`);
if (state.halted) {
  console.error(`SPSA HALTED: ${state.halted.reason}`);
  process.exit(3);
}
const serialize = (u) =>
  `${JSON.stringify(expand(Object.fromEntries(Object.entries(u).map(([p, v]) => [p, v * state.scales[p]]))), null, 2)}\n`;
if (state.scales.discount !== 1)
  throw new Error("γ (discount) raw-space gains assume a seed scale of 1");
function buildArms(k) {
  const j = k + 1;
  const rng = mulberry32(987654321 + (values.league ? 5000 + j : k));
  const delta = groups.map(() => (rng() < 0.5 ? -1 : 1));
  // Frozen groups (campaign 2: sparse-event perfectClear, audit J2):
  // zero perturbation in both arms, so the coordinates never move.
  for (const i of frozenGroups) delta[i] = 0;
  const deltaGamma = rng() < 0.5 ? -1 : 1;
  const c = c0 / (k + 1) ** 0.101;
  const plus = { ...state.thetaU },
    minus = { ...state.thetaU };
  groups.forEach((paths, i) => {
    for (const p of paths) {
      plus[p] += c * delta[i];
      minus[p] -= c * delta[i];
    }
  });
  // γ perturbation is absolute (raw space; its seed scale is 1).
  plus.discount += gammaC(k) * deltaGamma;
  minus.discount -= gammaC(k) * deltaGamma;
  return { delta, deltaGamma, c, plus, minus };
}
if (values["dry-run"]) {
  const { plus, minus } = buildArms(0);
  const raw = (u) =>
    Object.fromEntries(Object.entries(u).map(([p, v]) => [p, v * state.scales[p]]));
  const plusRaw = raw(plus),
    minusRaw = raw(minus);
  const frozenPaths = new Set([...frozenGroups].flatMap((i) => groups[i]));
  const rows = [];
  for (const p of [...groups.flat(), "discount"]) {
    const differs = plusRaw[p] !== minusRaw[p];
    if (frozenPaths.has(p) && differs)
      throw new Error(`dry run: frozen coordinate ${p} differs between arms`);
    if (!frozenPaths.has(p) && !differs)
      throw new Error(
        `dry run: coordinate ${p} does not differ between arms (zero-init perturbation failure)`,
      );
    rows.push(`${p}\t${minusRaw[p]}\t${plusRaw[p]}${frozenPaths.has(p) ? "\t(frozen)" : ""}`);
  }
  if (values["dry-run-out"]) {
    await mkdir(values["dry-run-out"], { recursive: true });
    await writeFile(resolve(values["dry-run-out"], "plus.json"), serialize(plus));
    await writeFile(resolve(values["dry-run-out"], "minus.json"), serialize(minus));
  }
  console.log(rows.join("\n"));
  console.log(
    `DRY RUN OK: ${rows.length} coordinates (${rows.filter((r) => !r.includes("(frozen)")).length} perturbed), arms ${values["dry-run-out"] || "not written"}`,
  );
  process.exit(0);
}
const children = new Set();
async function evaluate(
  u,
  blockStart,
  directory,
  label,
  opponent = { id: "champion", kind: "champion" },
) {
  const profile = resolve(directory, `${label}.json`);
  const output = resolve(directory, `${label}.jsonl`);
  await writeFile(profile, serialize(u));
  const opponentPath =
    opponent.kind === "attax-profile" ? resolve(directory, `${label}-opponent.json`) : null;
  if (opponentPath)
    await writeFile(opponentPath, await readFile(resolve(root, opponent.profile), "utf8"));
  const env = { ...process.env, ATTAX_S2_PROFILE: profile };
  delete env.ATTAX_S2_OPPONENT_ID;
  delete env.ATTAX_S2_OPPONENT_PROFILE;
  if (opponentPath && values["eval-runner"]) {
    env.ATTAX_S2_OPPONENT_ID = opponent.id;
    env.ATTAX_S2_OPPONENT_PROFILE = opponentPath;
  }
  const runEvalJob = (outFile, seedStart, nGames) =>
    new Promise((accept, reject) => {
      const child = spawn(
        values["eval-runner"] || "bun",
        [
          ...(values["eval-runner"]
            ? []
            : [
                "tools/s2-lab/run-match.mjs",
                ...(opponentPath
                  ? ["--opponent-profile", opponentPath, "--opponent-id", opponent.id]
                  : []),
              ]),
          "--games",
          String(nGames),
          "--seed",
          String(seedStart),
          "--out",
          outFile,
        ],
        {
          cwd: root,
          env,
          stdio: "inherit",
        },
      );
      children.add(child);
      child.on("error", reject);
      child.on("close", (code) => {
        children.delete(child);
        accept(code);
      });
    });
  // 4-way split (amendment 2026-11-15 03:13 JST): with S2_SPLIT_EVAL=1 an
  // eval runs as two concurrent sub-jobs of games/2 (seed offsets 0 and
  // games/2 — an even offset, so run-match's gameIndex-parity seat
  // assignment is unchanged) whose records are concatenated in seed order
  // before the unchanged checks below. Scheduling only.
  const splitEval = process.env.S2_SPLIT_EVAL === "1" && games >= 4 && games % 2 === 0;
  let records = [],
    excluded = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await rm(output, { force: true });
    let code;
    if (splitEval) {
      const half = games / 2;
      const outA = resolve(directory, `${label}-a.jsonl`);
      const outB = resolve(directory, `${label}-b.jsonl`);
      await rm(outA, { force: true });
      await rm(outB, { force: true });
      const [codeA, codeB] = await Promise.all([
        runEvalJob(outA, blockStart, half),
        runEvalJob(outB, blockStart + half, half),
      ]);
      let combined = "";
      for (const file of [outA, outB]) {
        try {
          combined += await readFile(file, "utf8");
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      await writeFile(output, combined);
      code = codeA === 75 || codeB === 75 ? 75 : codeA !== 0 ? codeA : codeB;
    } else {
      code = await runEvalJob(output, blockStart, games);
    }
    records = [];
    try {
      records = (await readFile(output, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (code === 0) throw error;
    }
    // Transport failure (runner exit 75; amendment 2026-11-15 03:00 JST):
    // retry once with identical inputs, then report transport exhaustion
    // so the league loop can exclude the iteration instead of dying.
    if (code === 75) {
      if (attempt === 0) continue;
      const error = new Error(`${label} evaluation transport failure persisted after one retry`);
      error.transportExhausted = true;
      throw error;
    }
    for (const record of records) {
      if (
        record.settings?.wasmSha256 !==
          "facb773f18feb041868e21022442e52754fbc5972c813577bc56586b1c653731" ||
        record.settings?.championProfileSha256 !==
          "b3d8686a4faa786746ed5b57d8bd09cdd30f88f1735b548e619b9ed63d498d6c"
      )
        throw new Error("campaign artifact integrity mismatch");
    }
    const compat = records.filter(
      (r) =>
        r.status === "error" &&
        typeof r.error === "string" &&
        r.error.startsWith("public compat error"),
    );
    const invalid = records.filter(
      (r) => (r.status === "error" || r.protocolErrors > 0) && !compat.includes(r),
    );
    if (invalid.length || (code !== 0 && !compat.length)) {
      console.error(JSON.stringify(invalid.length ? invalid : records, null, 2));
      throw new Error(`${label} evaluation failed (exit ${code})`);
    }
    if (records.length !== games)
      throw new Error(`expected ${games} records, got ${records.length}`);
    if (compat.length && attempt === 0) continue;
    excluded = compat.length;
    records = records.filter((r) => r.status !== "error");
    if (!records.length) throw new Error(`${label} evaluation has no finished records`);
    break;
  }
  let wins = 0,
    losses = 0,
    draws = 0,
    attaxAPP = 0,
    champAPP = 0,
    survival = 0,
    locksSum = 0;
  for (const r of records) {
    const side =
      r.contestants.left === "attax" ? "left" : r.contestants.right === "attax" ? "right" : null;
    if (!side) throw new Error("record has no attax contestant");
    const other = side === "left" ? "right" : "left";
    if (r.winner === null) draws++;
    else if (r.winner === side) wins++;
    else if (r.winner === other) losses++;
    else throw new Error("invalid winner");
    for (const seat of [side, other]) {
      if (!(r.locks[seat] > 0) || !Number.isFinite(r.attack[seat]))
        throw new Error("invalid APP inputs");
    }
    attaxAPP += r.attack[side] / r.locks[side];
    champAPP += r.attack[other] / r.locks[other];
    // Campaign-2 survival term (S2-CAMPAIGN2-DESIGN.md): attax's
    // absolute locks survived, log-scaled. At paced 1 PPS the game
    // ends at the loser's top-out, so the opponent's lock count is
    // near-equal by construction and carries no survival signal.
    survival += Math.log2(r.locks[side] + 1);
    locksSum += r.locks[side];
  }
  attaxAPP /= records.length;
  champAPP /= records.length;
  survival /= records.length;
  return {
    opponentId: opponent.id,
    games,
    J: (wins - losses) / records.length + attaxAPP - champAPP + survivalWeight * survival,
    excluded,
    wins,
    losses,
    draws,
    attaxAPP,
    champAPP,
    survivalTerm: survival,
    meanLocks: locksSum / records.length,
  };
}
function describe(e) {
  return `${e.J.toFixed(6)} (${e.wins}-${e.losses}-${e.draws}; APP ${e.attaxAPP.toFixed(6)}/${e.champAPP.toFixed(6)}${Number.isFinite(e.meanLocks) ? `; L ${e.meanLocks.toFixed(1)}` : ""})${e.excluded > 0 ? ` excl=${e.excluded}` : ""}`;
}
try {
  for (let k = values.league ? state.leagueIteration : state.iteration; k < iterations; k++) {
    const j = k + 1;
    let opponent = { id: "champion", kind: "champion" };
    if (values.league && !values["champion-only"]) {
      const sample = mulberry32(20251115 + j);
      if (sample() >= 0.5) {
        const members = state.pool.filter((p) => p.active && p.kind === "attax-profile");
        if (!members.length) throw new Error("league has no active profile opponents");
        opponent = members[Math.floor(sample() * members.length)];
      }
    }
    // Checkpoint before launching either child, including the very first evaluation.
    await atomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const { delta, deltaGamma, c, plus, minus } = buildArms(k);
    const a = a0 / (k + 11) ** 0.602;
    const block = seedBase + stride * k;
    const directory = await mkdtemp(resolve(tmpdir(), "s2-spsa-"));
    let jp, jm;
    try {
      if (concurrency >= 2)
        [jp, jm] = await Promise.all([
          evaluate(plus, block, directory, "plus", opponent),
          evaluate(minus, block, directory, "minus", opponent),
        ]);
      else {
        jp = await evaluate(plus, block, directory, "plus", opponent);
        jm = await evaluate(minus, block, directory, "minus", opponent);
      }
    } catch (error) {
      // League transport exclusion (amendment 2026-11-15 03:00 JST): the
      // eval transport failed after the registered retry, so this
      // iteration is excluded — logged, no SPSA step, theta/bestEval/
      // snapshot cadence untouched, C3 compat window untouched.
      if (values.league && error?.transportExhausted) {
        const timestamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" });
        state.transportExclusions = [
          ...(state.transportExclusions ?? []),
          { leagueIteration: j, opponentId: opponent.id, blockStart: block, timestamp },
        ];
        state.leagueIteration = j;
        state.history.push({
          leagueIteration: j,
          opponentId: opponent.id,
          timestamp,
          blockStart: block,
          transportExcluded: true,
        });
        await atomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
        await mkdir(dirname(logPath), { recursive: true });
        await appendFile(
          logPath,
          `| L${j} | ${timestamp} | ${block}-${block + games - 1} | opp=${opponent.id} | EXCLUDED | transport failure after one retry (no step) | transport failure after one retry (no step) | - |\n`,
        );
        console.error(`SPSA L${j} transport-excluded (no step)`);
        const recent = state.history.slice(-3);
        if (recent.length === 3 && recent.every((entry) => entry.transportExcluded))
          throw new Error(
            "three consecutive transport-excluded iterations; handing to supervision",
          );
        continue;
      }
      throw error;
    } finally {
      if (children.size === 0) await rm(directory, { recursive: true, force: true });
    }
    if (values.league) {
      state.evalWindow.push(...[jp, jm].map((e) => ({ games: e.games, excluded: e.excluded })));
      state.evalWindow = state.evalWindow.slice(-20);
      const totals = state.evalWindow.reduce(
        (a, e) => ({ games: a.games + e.games, excluded: a.excluded + e.excluded }),
        { games: 0, excluded: 0 },
      );
      if (totals.excluded / totals.games > 0.05) {
        const reason = "rolling exclusion rate exceeds 5%";
        const timestamp = new Date().toISOString();
        state.halted = { reason, leagueIteration: j, timestamp };
        await atomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
        await mkdir(dirname(logPath), { recursive: true });
        await appendFile(logPath, `| HALT | ${timestamp} | ${reason} |\n`);
        console.error(`SPSA LEAGUE HALT L${j}: ${reason}`);
        process.exitCode = 3;
        break;
      }
      if (jp.excluded > 0 !== jm.excluded > 0) {
        // Asymmetric arm exclusions (amendment 2026-11-15 03:52 JST): the
        // iteration is excluded — no step, no bestEval update — and the
        // campaign continues; three consecutive asymmetric iterations
        // halt for supervision. Stop rule 1 above is unchanged.
        const timestamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" });
        state.leagueIteration = j;
        state.history.push({
          leagueIteration: j,
          opponentId: opponent.id,
          timestamp,
          blockStart: block,
          asymExcluded: true,
          plusExcluded: jp.excluded,
          minusExcluded: jm.excluded,
        });
        await atomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
        await mkdir(dirname(logPath), { recursive: true });
        await appendFile(
          logPath,
          `| L${j} | ${timestamp} | ${block}-${block + games - 1} | opp=${opponent.id} | ASYM-EXCLUDED | plus excl=${jp.excluded} (no step) | minus excl=${jm.excluded} (no step) | - |\n`,
        );
        console.error(`SPSA L${j} asym-excluded (no step)`);
        const recent = state.history.slice(-3);
        if (recent.length === 3 && recent.every((entry) => entry.asymExcluded)) {
          const haltTimestamp = new Date().toISOString();
          state.halted = {
            reason: "three consecutive asymmetric arm exclusions",
            leagueIteration: j,
            timestamp: haltTimestamp,
          };
          await atomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
          await appendFile(
            logPath,
            `| HALT | ${haltTimestamp} | three consecutive asymmetric arm exclusions |\n`,
          );
          console.error(`SPSA LEAGUE HALT L${j}: three consecutive asymmetric arm exclusions`);
          process.exitCode = 3;
          break;
        }
        continue;
      }
      for (const [arm, evaluation, u] of [
        ["plus", jp, plus],
        ["minus", jm, minus],
      ]) {
        if (!state.bestEval || evaluation.J > state.bestEval.J) {
          const profilePath = `tools/s2-lab/profiles/${profileNamespace}/best-eval.json`;
          await atomic(resolve(root, profilePath), serialize(u));
          state.bestEval = { leagueIteration: j, arm, J: evaluation.J, profilePath };
        }
      }
    }
    const gradient = (jp.J - jm.J) / (2 * c);
    groups.forEach((paths, i) => {
      for (const p of paths) state.thetaU[p] += a * gradient * delta[i];
    });
    for (const p of groups.flat()) {
      const value = state.thetaU[p] * state.scales[p];
      state.thetaU[p] =
        Math.max(p === "attack" ? 5 : -600, Math.min(p === "attack" ? 600 : 900, value)) /
        state.scales[p];
    }
    // Φ coordinate clamps (tighter than the generic weight clamp).
    for (const [p, [lo, hi]] of Object.entries(COORD_CLAMPS)) {
      const value = state.thetaU[p] * state.scales[p];
      state.thetaU[p] = Math.max(lo, Math.min(hi, value)) / state.scales[p];
    }
    // γ update: raw-space SPSA step with its own gains, Fable clamp.
    state.thetaU.discount += gammaA(k) * ((jp.J - jm.J) / (2 * gammaC(k))) * deltaGamma;
    state.thetaU.discount =
      Math.max(
        GAMMA_CLAMP[0],
        Math.min(GAMMA_CLAMP[1], state.thetaU.discount * state.scales.discount),
      ) / state.scales.discount;
    const contents = serialize(state.thetaU);
    await atomic(profileOut, contents);
    state.successfulUpdates = (state.successfulUpdates ?? 0) + 1;
    if (values["iterate-dir"])
      await atomic(
        resolve(
          values["iterate-dir"],
          `iter-${String(state.successfulUpdates).padStart(4, "0")}.json`,
        ),
        contents,
      );
    const sha = createHash("sha256").update(contents).digest("hex").slice(0, 12);
    const signs = delta.map((d) => (d > 0 ? "+" : "-")).join("");
    const timestamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" });
    if (values.league) {
      state.leagueIteration = j;
      if (j % 10 === 0 && !values["champion-only"]) {
        const profile = `tools/s2-lab/profiles/${profileNamespace}/snap-L${j}.json`;
        await atomic(resolve(root, profile), contents);
        state.pool.push({ id: `snap-L${j}`, kind: "attax-profile", profile, active: true });
        state.snapshotCount++;
        const dynamic = state.pool.filter((p) => p.active && p.id.startsWith("snap-"));
        if (dynamic.length > 5) dynamic[0].active = false;
      }
    } else state.iteration = j;
    state.history.push({
      ...(values.league ? { leagueIteration: j, opponentId: opponent.id } : { iteration: j }),
      timestamp,
      blockStart: block,
      delta,
      deltaGamma,
      discount: state.thetaU.discount * state.scales.discount,
      plus: jp,
      minus: jm,
      profileSha: sha,
    });
    await atomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(
      logPath,
      `| ${values.league ? `L${j}` : j} | ${timestamp} | ${block}-${block + games - 1} | ${values.league ? `opp=${opponent.id} | ` : ""}${signs} | ${describe(jp)} | ${describe(jm)} | ${sha} |\n`,
    );
    console.log(
      `SPSA iteration=${k + 1} seeds=${block}-${block + games - 1} delta=${signs} Jplus=${describe(jp)} Jminus=${describe(jm)} sha=${sha}`,
    );
  }
  if (!state.halted) console.log(`SPSA DONE iterations=${iterations} finalProfile=${profileOut}`);
} catch (error) {
  for (const child of children) child.kill("SIGTERM");
  console.error(error);
  process.exitCode = 1;
}
