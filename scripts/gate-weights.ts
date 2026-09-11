// One-command reproducible gate: plays the fixed 32-seed corpus against the Rust
// Hoiko replica at the real DeepSeek beam configuration and prints W-L-D/cap plus
// aggregate metrics.
//
//   bun scripts/gate-weights.ts            # tuned weights from weights/deepseek-vs.json
//   bun scripts/gate-weights.ts --baseline # the unmodified createDeepSeekTetris gate fighter
//   bun scripts/gate-weights.ts --compare  # both, with the win-rate delta
//
// Options: --weights <path> --workers <n> --maxticks <n> --json

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveGenome } from "../src/tuner/genome.js";
import { type EvalJob, REAL_SEARCH, type SearchConfig } from "../src/tuner/job.js";
import {
  type GateSummary,
  type MatchOutcome,
  summarize,
  TUNER_MAX_TICKS,
  winLossCap,
} from "../src/tuner/match.js";

const ROOT = resolve(import.meta.dir, "..");
const WORKER = join(import.meta.dir, "tuner", "eval-worker.ts");
const DEFAULT_WEIGHTS = join(ROOT, "weights", "deepseek-vs.json");

const FIXED_SEEDS = [
  1, 5555, 13, 37, 61, 89, 7, 9001, 17, 41, 67, 97, 42, 2, 19, 43, 71, 99, 3, 23, 47, 73, 777, 5,
  29, 53, 79, 1234, 11, 31, 59, 83,
] as const;
const HELDOUT = new Set<number>(FIXED_SEEDS.slice(24));

interface Args {
  readonly mode: "tuned" | "baseline" | "compare";
  readonly weightsPath: string;
  readonly workers: number;
  readonly maxTicks: number;
  readonly json: boolean;
  readonly chunkSize: number;
}

function parseArgs(argv: readonly string[]): Args {
  let mode: Args["mode"] = "tuned";
  let weightsPath = DEFAULT_WEIGHTS;
  let workers = 6;
  let maxTicks = TUNER_MAX_TICKS;
  let json = false;
  let chunkSize = 8;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--baseline") mode = "baseline";
    else if (arg === "--compare") mode = "compare";
    else if (arg === "--tuned") mode = "tuned";
    else if (arg === "--json") json = true;
    else if (arg === "--weights") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--weights needs a path");
      weightsPath = resolve(value);
      index += 1;
    } else if (arg === "--workers") {
      workers = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--maxticks") {
      maxTicks = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--chunk") {
      chunkSize = Number(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { mode, weightsPath, workers, maxTicks, json, chunkSize };
}

function loadTunedGenome(path: string): Readonly<Record<string, number>> {
  if (!existsSync(path)) {
    throw new Error(`weights file not found: ${path} (run bun scripts/tune-vs.ts first)`);
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    genome?: Readonly<Record<string, number>>;
  };
  if (parsed.genome === undefined) throw new Error(`weights file has no "genome": ${path}`);
  return resolveGenome(parsed.genome);
}

function chunkSeeds(size: number): number[][] {
  const out: number[][] = [];
  for (let index = 0; index < FIXED_SEEDS.length; index += size) {
    out.push(FIXED_SEEDS.slice(index, index + size));
  }
  return out;
}

async function spawnJob(job: EvalJob): Promise<MatchOutcome[]> {
  const proc = Bun.spawn(["bun", WORKER, JSON.stringify(job)], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`eval-worker exited ${code}: ${stderr.slice(0, 500)}`);
  return (JSON.parse(stdout) as { outcomes: MatchOutcome[] }).outcomes;
}

async function runShards(jobs: readonly EvalJob[], workers: number): Promise<MatchOutcome[]> {
  const results: MatchOutcome[][] = new Array(jobs.length);
  let next = 0;
  const runWorker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= jobs.length) return;
      const job = jobs[index];
      if (job === undefined) continue;
      results[index] = await spawnJob(job);
    }
  };
  const pool: Promise<void>[] = [];
  for (let index = 0; index < Math.min(workers, jobs.length); index += 1) pool.push(runWorker());
  await Promise.all(pool);
  return results.flat().sort((a, b) => a.seed - b.seed);
}

async function runMode(
  args: Args,
  mode: "tuned" | "baseline",
  genome: Readonly<Record<string, number>> | null,
): Promise<MatchOutcome[]> {
  const search: SearchConfig = REAL_SEARCH;
  const jobs: EvalJob[] = chunkSeeds(args.chunkSize).map((seeds, index) => ({
    id: `${mode}-${index}`,
    mode,
    ...(mode === "tuned" && genome !== null ? { genome } : {}),
    search,
    seeds,
    maxTicks: args.maxTicks,
    hoikoPreset: "we",
  }));
  return runShards(jobs, args.workers);
}

function heldoutOf(rows: readonly MatchOutcome[]): GateSummary {
  return summarize(rows.filter((row) => HELDOUT.has(row.seed)));
}
function trainOf(rows: readonly MatchOutcome[]): GateSummary {
  return summarize(rows.filter((row) => !HELDOUT.has(row.seed)));
}

function report(label: string, rows: readonly MatchOutcome[], json: boolean): void {
  const full = summarize(rows);
  const train = trainOf(rows);
  const held = heldoutOf(rows);
  console.log(`\n=== ${label} (real config, ${rows.length} seeds) ===`);
  console.log(`W-L-D/cap: ${winLossCap(full)}   winRate=${(full.winRate * 100).toFixed(1)}%`);
  console.log(
    `  train  W-L-D/cap: ${winLossCap(train)}  winRate=${(train.winRate * 100).toFixed(1)}%`,
  );
  console.log(
    `  held   W-L-D/cap: ${winLossCap(held)}  winRate=${(held.winRate * 100).toFixed(1)}%`,
  );
  console.log(
    `  ticks=${full.ticks} pieces=${full.pieces}  ` +
      `our lines=${full.left.lines} sent=${full.left.sent} tetris=${full.left.tetris} tsd=${full.left.tsd} ` +
      `maxH=${full.left.maxHeight} holes=${full.left.holes} maxPending=${full.left.maxPending}`,
  );
  console.log(
    `  hoiko lines=${full.right.lines} sent=${full.right.sent} tetris=${full.right.tetris} ` +
      `maxH=${full.right.maxHeight} holes=${full.right.holes} maxPending=${full.right.maxPending}`,
  );
  console.log(
    `  exec mismatches=${full.left.executionSourceMismatches} board-failures=${full.left.executionExpectedBoardFailures}`,
  );
  if (!json) {
    console.log("  per-seed:");
    for (const row of rows) {
      console.log(
        `    seed=${String(row.seed).padStart(5)} ${row.winner.padEnd(5)} ` +
          `ticks=${String(row.ticks).padStart(5)} pieces=${String(row.pieces).padStart(4)} ` +
          `sent ${row.left.sent}-${row.right.sent} lines ${row.left.lines}-${row.right.lines}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const genome = args.mode === "baseline" ? null : loadTunedGenome(args.weightsPath);

  if (args.mode === "compare") {
    const baseline = await runMode(args, "baseline", null);
    const tuned = await runMode(args, "tuned", genome);
    if (args.json) {
      console.log(
        JSON.stringify({
          baseline: summarize(baseline),
          tuned: summarize(tuned),
          baselineWlc: winLossCap(summarize(baseline)),
          tunedWlc: winLossCap(summarize(tuned)),
        }),
      );
      return;
    }
    report("baseline (createDeepSeekTetris)", baseline, false);
    report("tuned (weights/deepseek-vs.json)", tuned, false);
    const delta = (summarize(tuned).winRate - summarize(baseline).winRate) * 100;
    console.log(
      `\nwin-rate delta (tuned - baseline) = ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pp`,
    );
    return;
  }

  const rows = await runMode(args, args.mode, genome);
  if (args.json) {
    console.log(JSON.stringify(summarize(rows)));
    return;
  }
  report(args.mode === "baseline" ? "baseline (createDeepSeekTetris)" : "tuned", rows, false);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
