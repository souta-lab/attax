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
};
const { values } = parseArgs({
  options: {
    ...Object.fromEntries(
      Object.entries(defaults).map(([k, v]) => [k, { type: "string", default: v }]),
    ),
    league: { type: "boolean", default: false },
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
function flatten(profile) {
  return Object.fromEntries(
    Object.entries(profile).flatMap(([key, value]) =>
      typeof value === "object"
        ? Object.entries(value).map(([k, v]) => [`${key}.${k}`, v])
        : [[key, value]],
    ),
  );
}
function expand(flat) {
  const profile = { board: {}, clear: {} };
  for (const [path, value] of Object.entries(flat)) {
    const [a, b] = path.split(".");
    if (b) profile[a][b] = value;
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
let state = {
  iteration: 0,
  thetaU: Object.fromEntries(
    Object.entries(seedFlat).map(([p, v]) => [p, v / Math.max(1, Math.abs(v))]),
  ),
  seedProfile,
  scales: Object.fromEntries(
    Object.entries(seedFlat).map(([p, v]) => [p, Math.max(1, Math.abs(v))]),
  ),
  history: [],
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
if (state.halted) {
  console.error(`SPSA HALTED: ${state.halted.reason}`);
  process.exit(3);
}
const serialize = (u) =>
  `${JSON.stringify(expand(Object.fromEntries(Object.entries(u).map(([p, v]) => [p, v * state.scales[p]]))), null, 2)}\n`;
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
  let records = [],
    excluded = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await rm(output, { force: true });
    const code = await new Promise((accept, reject) => {
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
          String(games),
          "--seed",
          String(blockStart),
          "--out",
          output,
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
    champAPP = 0;
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
  }
  attaxAPP /= records.length;
  champAPP /= records.length;
  return {
    opponentId: opponent.id,
    games,
    J: (wins - losses) / records.length + attaxAPP - champAPP,
    excluded,
    wins,
    losses,
    draws,
    attaxAPP,
    champAPP,
  };
}
function describe(e) {
  return `${e.J.toFixed(6)} (${e.wins}-${e.losses}-${e.draws}; APP ${e.attaxAPP.toFixed(6)}/${e.champAPP.toFixed(6)})${e.excluded > 0 ? ` excl=${e.excluded}` : ""}`;
}
try {
  for (let k = values.league ? state.leagueIteration : state.iteration; k < iterations; k++) {
    const j = k + 1;
    let opponent = { id: "champion", kind: "champion" };
    if (values.league) {
      const sample = mulberry32(20251115 + j);
      if (sample() >= 0.5) {
        const members = state.pool.filter((p) => p.active && p.kind === "attax-profile");
        if (!members.length) throw new Error("league has no active profile opponents");
        opponent = members[Math.floor(sample() * members.length)];
      }
    }
    // Checkpoint before launching either child, including the very first evaluation.
    await atomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const rng = mulberry32(987654321 + (values.league ? 5000 + j : k));
    const delta = groups.map(() => (rng() < 0.5 ? -1 : 1));
    const c = c0 / (k + 1) ** 0.101;
    const a = a0 / (k + 11) ** 0.602;
    const plus = { ...state.thetaU },
      minus = { ...state.thetaU };
    groups.forEach((paths, i) => {
      for (const p of paths) {
        plus[p] += c * delta[i];
        minus[p] -= c * delta[i];
      }
    });
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
      const reason =
        totals.excluded / totals.games > 0.05
          ? "rolling exclusion rate exceeds 5%"
          : jp.excluded > 0 !== jm.excluded > 0
            ? "asymmetric arm exclusions"
            : null;
      if (reason) {
        const timestamp = new Date().toISOString();
        state.halted = { reason, leagueIteration: j, timestamp };
        await atomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
        await mkdir(dirname(logPath), { recursive: true });
        await appendFile(logPath, `| HALT | ${timestamp} | ${reason} |\n`);
        console.error(`SPSA LEAGUE HALT L${j}: ${reason}`);
        process.exitCode = 3;
        break;
      }
      for (const [arm, evaluation, u] of [
        ["plus", jp, plus],
        ["minus", jm, minus],
      ]) {
        if (!state.bestEval || evaluation.J > state.bestEval.J) {
          const profilePath = "tools/s2-lab/profiles/league/best-eval.json";
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
    const contents = serialize(state.thetaU);
    await atomic(profileOut, contents);
    const sha = createHash("sha256").update(contents).digest("hex").slice(0, 12);
    const signs = delta.map((d) => (d > 0 ? "+" : "-")).join("");
    const timestamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Tokyo" });
    if (values.league) {
      state.leagueIteration = j;
      if (j % 10 === 0) {
        const profile = `tools/s2-lab/profiles/league/snap-L${j}.json`;
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
