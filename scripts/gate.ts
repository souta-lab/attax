// Per-version gate: frozen previous version vs live candidate on the fixed 32-seed corpus.
// Usage: GATE_FREEZE=v8 bun scripts/gate.ts
// Env:
//   GATE_FREEZE      freeze name pinned as the previous version (default "v8")
//   GATE_MAX_TICKS   default 12000
//   GATE_SHARD_INDEX / GATE_SHARD_COUNT   shard over the fixed seed list (default 0 / 6)
//   GATE_SEEDS       comma-separated seed override (runs exactly those seeds, no sharding)
//   GATE_LIVE_BASE   source tree for the candidate side (default: repo src; point at a scratch
//                    tree to self-test, e.g. the materialized freeze dir)
// Scenarios:
//   S2 sanity: frozen BLUE vs frozen RED (reproduces the frozen version's recorded corpus)
//   S1 frozen: live BLUE   vs frozen RED
//   S3 live:   live BLUE   vs live RED
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const FIXED_SEEDS = [
  1, 5555, 13, 37, 61, 89, 7, 9001, 17, 41, 67, 97, 42, 2, 19, 43, 71, 99, 3, 23, 47, 73, 777, 5,
  29, 53, 79, 1234, 11, 31, 59, 83,
] as const;

const FREEZE = process.env.GATE_FREEZE ?? "v8";
const MAX_TICKS = Number(process.env.GATE_MAX_TICKS ?? 12000);
const SHARD_INDEX = Number(process.env.GATE_SHARD_INDEX ?? 0);
const SHARD_COUNT = Number(process.env.GATE_SHARD_COUNT ?? 6);
const LIVE_BASE = process.env.GATE_LIVE_BASE ?? resolve(import.meta.dir, "../src");
const SCRATCH = `/tmp/gate-src-${FREEZE}`;

const seedOverride = process.env.GATE_SEEDS;
const seeds: number[] =
  seedOverride === undefined
    ? FIXED_SEEDS.filter((_, index) => index % SHARD_COUNT === SHARD_INDEX)
    : seedOverride
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isFinite(value));

interface SideMetrics {
  readonly lines: number;
  readonly sent: number;
  readonly tsd: number;
  readonly tetris: number;
  readonly maxPending: number;
  readonly maxHeight: number;
  readonly holes: number;
  readonly executionSourceMismatches?: number;
  readonly executionExpectedBoardFailures?: number;
}

interface Row {
  readonly seed: number;
  readonly winner: string;
  readonly reason: string;
  readonly ticks: number;
  readonly pieces: number;
  readonly left: SideMetrics;
  readonly right: SideMetrics;
}

function fingerprint(rows: readonly Row[]): string {
  let hash = 2166136261;
  const text = JSON.stringify(rows);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function sum(rows: readonly Row[], pick: (row: Row) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

function aggregate(rows: readonly Row[]): unknown {
  const count = (winner: string) => rows.filter((row) => row.winner === winner).length;
  const side = (key: "left" | "right") => ({
    lines: sum(rows, (row) => row[key].lines),
    sent: sum(rows, (row) => row[key].sent),
    tsd: sum(rows, (row) => row[key].tsd),
    tetris: sum(rows, (row) => row[key].tetris),
    maxPending: sum(rows, (row) => row[key].maxPending),
    maxHeight: sum(rows, (row) => row[key].maxHeight),
    holes: sum(rows, (row) => row[key].holes),
    executionSourceMismatches: sum(rows, (row) => row[key].executionSourceMismatches ?? 0),
    executionExpectedBoardFailures: sum(
      rows,
      (row) => row[key].executionExpectedBoardFailures ?? 0,
    ),
  });
  return {
    matches: rows.length,
    leftWins: count("left"),
    rightWins: count("right"),
    draws: count("draw"),
    caps: count("cap"),
    left: side("left"),
    right: side("right"),
  };
}

const materialize = spawnSync(
  "bun",
  [join(import.meta.dir, "freeze.ts"), "materialize", FREEZE, SCRATCH],
  { encoding: "utf8" },
);
if (materialize.status !== 0) {
  throw new Error(`materialize freeze/${FREEZE} failed: ${materialize.stderr}`);
}

const frozenA = await import(`${SCRATCH}/src/ai/fighterA.js`);
const frozenB = await import(`${SCRATCH}/src/ai/fighterB.js`);
const liveA = await import(`${LIVE_BASE}/ai/fighterA.js`);
const liveB = await import(`${LIVE_BASE}/ai/fighterB.js`);
const { runFitnessScenario } = await import(`${LIVE_BASE}/ai/fitness.js`);

const scenarios = [
  {
    label: "S2",
    left: () => frozenA.createFighterA({ useKick: false }),
    right: () => frozenB.createFighterB(),
  },
  {
    label: "S1",
    left: () => liveA.createFighterA({ useKick: false }),
    right: () => frozenB.createFighterB(),
  },
  {
    label: "S3",
    left: () => liveA.createFighterA({ useKick: false }),
    right: () => liveB.createFighterB(),
  },
] as const;

console.log(
  JSON.stringify({
    type: "GATE-config",
    freeze: FREEZE,
    liveBase: LIVE_BASE,
    shard: { index: SHARD_INDEX, count: SHARD_COUNT },
    seeds,
    maxTicks: MAX_TICKS,
  }),
);

const aggregates: Record<string, unknown> = {};
const fingerprints: Record<string, string> = {};
for (const scenario of scenarios) {
  const result = runFitnessScenario({
    factories: { leftFactory: scenario.left, rightFactory: scenario.right },
    seeds,
    maxTicks: MAX_TICKS,
  });
  const rows: Row[] = result.matches.map((match: Row) => ({
    seed: match.seed,
    winner: match.winner,
    reason: match.reason,
    ticks: match.ticks,
    pieces: match.pieces,
    left: match.left,
    right: match.right,
  }));
  for (const row of rows)
    console.log(JSON.stringify({ type: "GATE-match", scenario: scenario.label, ...row }));
  aggregates[scenario.label] = aggregate(rows);
  fingerprints[scenario.label] = fingerprint(rows);
}

console.log(
  JSON.stringify({
    type: "GATE-summary",
    freeze: FREEZE,
    shard: { index: SHARD_INDEX, count: SHARD_COUNT },
    seeds,
    maxTicks: MAX_TICKS,
    aggregates,
    fingerprints,
  }),
);
