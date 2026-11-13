/**
 * Fresh-seed generalization gate.
 *
 * The random seeds are drawn *after* the policy is frozen, outside the ordinary tune and
 * published benchmark ranges. Each seed is played from both seats; a seed counts as a
 * success only if the bot wins both games. This avoids treating seat-swapped replays as
 * independent evidence and makes selective reporting of favourable seeds harder.
 *
 *   bun scripts/cross-seed.ts --count 200 --jobs 4 --out bench-results/cross-seed.jsonl
 */
import { randomInt } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Oriented } from "../src/bench/summary.js";
import { wilson } from "../src/bench/summary.js";
import { parseArgs, runBenchmark } from "./benchmark.js";

type Outcome = "W" | "L" | "D" | "cap";

export interface SeedPairFailure {
  readonly seed: number;
  readonly left: Outcome;
  readonly right: Outcome;
}

export interface SeedPairSummary {
  readonly seeds: number;
  readonly wonBothSeats: number;
  readonly failedSeeds: number;
  readonly seatDisagreements: number;
  readonly rate: number;
  readonly wilson95: readonly [number, number];
  readonly failures: readonly SeedPairFailure[];
}

function outcome(game: Oriented): Outcome {
  if (game.record.winner === game.aSide) return "W";
  if (game.record.winner === "draw") return "D";
  if (game.record.winner === "cap") return "cap";
  return "L";
}

/** Collapse paired games into independent seed outcomes; reject incomplete data. */
export function summarizeSeedPairs(games: readonly Oriented[]): SeedPairSummary {
  const pairs = new Map<number, { left?: Outcome; right?: Outcome }>();
  for (const game of games) {
    const pair = pairs.get(game.seed) ?? {};
    if (pair[game.aSide] !== undefined)
      throw new Error(`duplicate seed ${game.seed} / ${game.aSide}`);
    pair[game.aSide] = outcome(game);
    pairs.set(game.seed, pair);
  }
  let wonBothSeats = 0;
  let seatDisagreements = 0;
  const failures: SeedPairFailure[] = [];
  for (const [seed, pair] of pairs) {
    if (pair.left === undefined || pair.right === undefined)
      throw new Error(`missing seat for seed ${seed}`);
    if (pair.left !== pair.right) seatDisagreements += 1;
    if (pair.left === "W" && pair.right === "W") wonBothSeats += 1;
    else failures.push({ seed, left: pair.left, right: pair.right });
  }
  const n = pairs.size;
  failures.sort((a, b) => a.seed - b.seed);
  return {
    seeds: n,
    wonBothSeats,
    failedSeeds: failures.length,
    seatDisagreements,
    rate: n > 0 ? wonBothSeats / n : 0,
    wilson95: wilson(wonBothSeats, n),
    failures,
  };
}

function option(argv: readonly string[], name: string, fallback: string): string {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : (argv[i + 1] ?? "");
}

function positiveInt(text: string, name: string): number {
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`invalid --${name}: ${text}`);
  return n;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const count = positiveInt(option(argv, "count", "200"), "count");
  const jobs = positiveInt(option(argv, "jobs", "4"), "jobs");
  const width = positiveInt(option(argv, "width", "48"), "width");
  const preview = positiveInt(option(argv, "preview", "5"), "preview");
  if (count > 5000) throw new Error("--count must be at most 5000");
  const adapt = option(argv, "adapt", "0");
  if (adapt !== "0" && adapt !== "1") throw new Error("--adapt must be 0 or 1");

  // A fresh draw cannot be selected for its outcome. Save the list with the records
  // so a failed run is always reproducible and can be diagnosed separately.
  const seeds = new Set<number>();
  while (seeds.size < count) seeds.add(randomInt(1_000_000, 2_000_000_000));
  const selection = [...seeds].sort((a, b) => a - b);
  const out = option(argv, "out", `bench-results/cross-seed-${Date.now()}.jsonl`);
  const benchArgs = [
    "--seeds",
    selection.join(","),
    "--sides",
    "both",
    "--jobs",
    String(jobs),
    "--adapt",
    adapt,
    "--width",
    String(width),
    "--preview",
    String(preview),
    "--quiet",
  ];
  const records = await runBenchmark(parseArgs(benchArgs), benchArgs);
  const summary = summarizeSeedPairs(records);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${records.map((game) => JSON.stringify(game)).join("\n")}\n`);
  writeFileSync(
    `${out}.summary.json`,
    `${JSON.stringify({ config: { count, jobs, width, preview, adapt, seeds: selection }, ...summary }, null, 2)}\n`,
  );
  console.log(JSON.stringify({ out, ...summary }));
  if (summary.failedSeeds > 0) process.exitCode = 1;
}

if (import.meta.main) await main();
