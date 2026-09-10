import { createFighterA } from "../src/ai/fighterA.js";
import { createFighterB } from "../src/ai/fighterB.js";
import {
  type FitnessFighterFactory,
  type FitnessMatchResult,
  type FitnessScenarioResult,
  type FitnessSideMetrics,
  type FitnessWinner,
  runFitnessScenario,
} from "../src/ai/fitness.js";
import { enumerateKickPlacements, type PlacementGenerator } from "../src/ai/search.js";

declare const Bun: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly file: (path: string) => { exists(): Promise<boolean> };
  readonly write: (path: string, contents: string) => Promise<number>;
};

const FIXED_SEEDS = [
  1, 5555, 13, 37, 61, 89, 7, 9001, 17, 41, 67, 97, 42, 2, 19, 43, 71, 99, 3, 23, 47, 73, 777, 5,
  29, 53, 79, 1234, 11, 31, 59, 83,
] as const;
const MAX_TICKS = 12000;
const DEFAULT_SHARD_COUNT = 1;
const S1_OPPONENT_PATH = "/tmp/redv7-fixed.ts";
const explicitKickGenerator: PlacementGenerator = (board, kind) =>
  enumerateKickPlacements(board, kind);

type MetricRecord = Required<FitnessSideMetrics>;
type MatchRecord = Omit<FitnessMatchResult, "left" | "right"> & {
  readonly left: MetricRecord;
  readonly right: MetricRecord;
};
type MutableMetrics = { -readonly [K in keyof FitnessSideMetrics]-?: number };
type PairedRow = {
  readonly seed: number;
  readonly control: MatchRecord;
  readonly candidate: MatchRecord;
};

class HarnessConfigError extends Error {
  readonly name = "HarnessConfigError";
}

function readInteger(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new HarnessConfigError(`${name} must be an integer, received ${raw}`);
  }
  return value;
}

function metricRecord(metrics: FitnessSideMetrics): MetricRecord {
  return {
    ...metrics,
    executionSourceMismatches: metrics.executionSourceMismatches ?? 0,
    executionExpectedBoardFailures: metrics.executionExpectedBoardFailures ?? 0,
  };
}

function matchRecord(match: FitnessMatchResult): MatchRecord {
  return { ...match, left: metricRecord(match.left), right: metricRecord(match.right) };
}

function emptyMetrics(): MutableMetrics {
  return {
    lines: 0,
    sent: 0,
    tsd: 0,
    tetris: 0,
    maxPending: 0,
    maxHeight: 0,
    holes: 0,
    executionSourceMismatches: 0,
    executionExpectedBoardFailures: 0,
  };
}

function addMetrics(total: MutableMetrics, metrics: MetricRecord): void {
  total.lines += metrics.lines;
  total.sent += metrics.sent;
  total.tsd += metrics.tsd;
  total.tetris += metrics.tetris;
  total.maxPending += metrics.maxPending;
  total.maxHeight += metrics.maxHeight;
  total.holes += metrics.holes;
  total.executionSourceMismatches += metrics.executionSourceMismatches;
  total.executionExpectedBoardFailures += metrics.executionExpectedBoardFailures;
}

function aggregate(matches: readonly MatchRecord[]) {
  const total = {
    matches: 0,
    wins: 0,
    caps: 0,
    ticks: 0,
    pieces: 0,
    winnerCounts: { left: 0, right: 0, draw: 0, cap: 0 },
    left: emptyMetrics(),
    right: emptyMetrics(),
  };
  for (const match of matches) {
    total.matches += 1;
    total.ticks += match.ticks;
    total.pieces += match.pieces;
    total.winnerCounts[match.winner] += 1;
    if (match.winner === "left") total.wins += 1;
    if (match.winner === "cap") total.caps += 1;
    addMetrics(total.left, match.left);
    addMetrics(total.right, match.right);
  }
  return {
    ...total,
    winnerCounts: { ...total.winnerCounts },
    left: { ...total.left },
    right: { ...total.right },
  };
}

function fingerprintScenario(scenario: FitnessScenarioResult): string {
  const serialized = JSON.stringify({
    label: scenario.label,
    matches: scenario.matches.map(matchRecord),
  });
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function outcomeGlyph(winner: FitnessWinner): string {
  switch (winner) {
    case "left":
      return "L";
    case "right":
      return "R";
    case "draw":
      return "D";
    case "cap":
      return "C";
    default:
      throw new HarnessConfigError("unexpected winner");
  }
}

function metricBrain(rows: readonly PairedRow[]): string {
  const seeds = rows.map((row) => row.seed).join(" ");
  const control = rows.map((row) => outcomeGlyph(row.control.winner)).join(" ");
  const candidate = rows
    .map((row) => {
      const failures =
        row.candidate.left.executionExpectedBoardFailures +
        row.candidate.right.executionExpectedBoardFailures;
      const suffix = failures === 0 ? "" : `!${failures}`;
      return `${outcomeGlyph(row.candidate.winner)}${suffix}`;
    })
    .join(" ");
  return [
    "ASCII METRIC BRAIN (not a board render)",
    `seed order  ${seeds}`,
    `control     ${control}`,
    `candidate   ${candidate}`,
  ].join("\n");
}

function markdownSummary(summary: Readonly<Record<string, unknown>>, brain: string): string {
  return [
    "# V12 Explicit-Generator Shadow Corpus",
    "",
    "S1 is BLOCKED because `/tmp/redv7-fixed.ts` is absent; no frozen opponent was recreated.",
    "",
    "```json",
    JSON.stringify(summary, null, 2),
    "```",
    "",
    "## ASCII Metric Brain",
    "",
    "This is an ASCII metric render, not a board render.",
    "",
    "```text",
    brain,
    "```",
    "",
  ].join("\n");
}

async function main(): Promise<void> {
  const shardIndex = readInteger("V12_SHARD_INDEX", Bun.env.V12_SHARD_INDEX, 0);
  const shardCount = readInteger("V12_SHARD_COUNT", Bun.env.V12_SHARD_COUNT, DEFAULT_SHARD_COUNT);
  if (shardIndex < 0 || shardCount < 1 || shardIndex >= shardCount) {
    throw new HarnessConfigError(`V12_SHARD_INDEX must be less than V12_SHARD_COUNT`);
  }
  const uniqueSeedCount = new Set(FIXED_SEEDS).size;
  const seeds = FIXED_SEEDS.filter((_, index) => index % shardCount === shardIndex);
  const sourcePresent = await Bun.file(S1_OPPONENT_PATH).exists();
  if (sourcePresent) throw new HarnessConfigError("S1 source exists; S1 remains blocked");
  const blockedReason =
    "S1 blocked: /tmp/redv7-fixed.ts is absent; no frozen opponent was recreated";
  const controlFactory: FitnessFighterFactory = () => createFighterA({ useKick: false });
  const candidateFactory: FitnessFighterFactory = () =>
    createFighterA({ placementGenerator: explicitKickGenerator });
  const control = runFitnessScenario({
    factories: { leftFactory: controlFactory, rightFactory: () => createFighterB() },
    seeds,
    maxTicks: MAX_TICKS,
  });
  const candidate = runFitnessScenario({
    factories: { leftFactory: candidateFactory, rightFactory: () => createFighterB() },
    seeds,
    maxTicks: MAX_TICKS,
  });
  const rows: readonly PairedRow[] = seeds.map((seed, index) => {
    const controlMatch = control.matches[index];
    const candidateMatch = candidate.matches[index];
    if (controlMatch === undefined || candidateMatch === undefined) {
      throw new HarnessConfigError(`missing paired match for seed ${seed}`);
    }
    return { seed, control: matchRecord(controlMatch), candidate: matchRecord(candidateMatch) };
  });
  const controlMatches = rows.map((row) => row.control);
  const candidateMatches = rows.map((row) => row.candidate);
  const controlAggregate = aggregate(controlMatches);
  const candidateAggregate = aggregate(candidateMatches);
  const candidateFailures =
    candidateAggregate.left.executionExpectedBoardFailures +
    candidateAggregate.right.executionExpectedBoardFailures;
  const configValidation = {
    fixedSeedCount: FIXED_SEEDS.length,
    uniqueSeedCount,
    maxTicks: MAX_TICKS,
    shard: { index: shardIndex, count: shardCount, seeds },
    s1: { status: "BLOCKED", opponentPath: S1_OPPONENT_PATH, sourcePresent, reason: blockedReason },
    control: "createFighterA({useKick:false})",
    candidate: "createFighterA({placementGenerator: explicitKickGenerator})",
    opponent: "live createFighterB()",
  } as const;
  const brain = metricBrain(rows);
  const summary = {
    seeds,
    shard: { index: shardIndex, count: shardCount },
    maxTicks: MAX_TICKS,
    configValidation,
    fingerprints: {
      controlS3: fingerprintScenario(control),
      candidateS3: fingerprintScenario(candidate),
    },
    aggregates: { control: controlAggregate, candidate: candidateAggregate },
    perSeed: rows,
    decision:
      candidateFailures === 0
        ? "PASS: zero candidate expected-board failures"
        : "REJECT: candidate expected-board failures are nonzero",
  } as const;
  console.log(JSON.stringify({ type: "S3-config", configValidation }));
  for (const row of rows) console.log(JSON.stringify({ type: "S3-paired", ...row }));
  console.log(JSON.stringify({ type: "S3-summary", ...summary, metricBrain: brain }));
  await Bun.write(
    `/tmp/ev-v12-generator-shadow-summary-${shardIndex}.md`,
    markdownSummary(summary, brain),
  );
}

await main();
