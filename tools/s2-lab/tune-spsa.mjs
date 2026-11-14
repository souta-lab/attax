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
};
const { values } = parseArgs({
  options: Object.fromEntries(
    Object.entries(defaults).map(([k, v]) => [k, { type: "string", default: v }]),
  ),
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
try {
  state = JSON.parse(await readFile(statePath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const serialize = (u) =>
  `${JSON.stringify(expand(Object.fromEntries(Object.entries(u).map(([p, v]) => [p, v * state.scales[p]]))), null, 2)}\n`;
const children = new Set();
async function evaluate(u, blockStart, directory, label) {
  const profile = resolve(directory, `${label}.json`);
  const output = resolve(directory, `${label}.jsonl`);
  await writeFile(profile, serialize(u));
  let records = [],
    excluded = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await rm(output, { force: true });
    const code = await new Promise((accept, reject) => {
      const child = spawn(
        "bun",
        [
          "tools/s2-lab/run-match.mjs",
          "--games",
          String(games),
          "--seed",
          String(blockStart),
          "--out",
          output,
        ],
        {
          cwd: root,
          env: { ...process.env, ATTAX_S2_PROFILE: profile },
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
  for (let k = state.iteration; k < iterations; k++) {
    // Checkpoint before launching either child, including the very first evaluation.
    await atomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
    const rng = mulberry32(987654321 + k);
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
          evaluate(plus, block, directory, "plus"),
          evaluate(minus, block, directory, "minus"),
        ]);
      else {
        jp = await evaluate(plus, block, directory, "plus");
        jm = await evaluate(minus, block, directory, "minus");
      }
    } finally {
      if (children.size === 0) await rm(directory, { recursive: true, force: true });
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
    state.iteration = k + 1;
    state.history.push({
      iteration: k + 1,
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
      `| ${k + 1} | ${timestamp} | ${block}-${block + games - 1} | ${signs} | ${describe(jp)} | ${describe(jm)} | ${sha} |\n`,
    );
    console.log(
      `SPSA iteration=${k + 1} seeds=${block}-${block + games - 1} delta=${signs} Jplus=${describe(jp)} Jminus=${describe(jm)} sha=${sha}`,
    );
  }
  console.log(`SPSA DONE iterations=${iterations} finalProfile=${profileOut}`);
} catch (error) {
  for (const child of children) child.kill("SIGTERM");
  console.error(error);
  process.exitCode = 1;
}
