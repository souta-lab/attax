/**
 * Head-to-head benchmark: the bot vs the faithful Hoiko replica, same seeds, same rules.
 *
 *   bun scripts/benchmark.ts --seeds 1001-1200 --sides both --jobs 3 --out runs/heldout.jsonl
 *
 * Options
 *   --seeds    a-b or a,b,c            (default 1001-1200, the held-out set; tuning uses 2001+)
 *   --sides    left | right | both     which side the bot plays (both = every seed twice)
 *   --adapt    0 | 1                   Hoiko's wall-clock beam adaptation (default 0 = deterministic)
 *   --preview  n                       preview pieces the bot may read (default 5)
 *   --width    n                       bot beam width
 *   --weights  file.json               bot weights (default: built-in DEFAULT_WEIGHTS)
 *   --jobs     n                       parallel worker processes
 *   --out      file.jsonl              write one JSON record per game
 *   --quiet                            only print the final summary line
 *
 * Prints one JSON summary line (win rate with a 95% Wilson interval, lines, attack/piece).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { BOT_DEFAULTS, createBot } from "../src/ai/bot/fighter.js";
import { DEFAULT_WEIGHTS, type Weights } from "../src/ai/bot/weights.js";
import { resolveFaithfulHoikoOptions } from "../src/ai/hoiko/faithful.js";
import { runMatch } from "../src/bench/match.js";
import { type Oriented, summarize } from "../src/bench/summary.js";
import { createHoiko } from "../tools/hoiko-node.js";

interface Config {
  readonly seeds: readonly number[];
  readonly sides: "left" | "right" | "both";
  readonly adapt: boolean;
  readonly preview: number;
  readonly width: number;
  readonly weights: Weights;
  readonly weightsFile: string | null;
  readonly jobs: number;
  readonly out: string | null;
  readonly quiet: boolean;
  readonly shard: readonly [number, number] | null;
}

function parseSeeds(text: string): number[] {
  return text.split(",").flatMap((part) => {
    const [a, b] = part.split("-").map(Number);
    if (a === undefined || !Number.isInteger(a)) throw new Error(`bad seed list: ${text}`);
    if (b === undefined) return [a];
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  });
}

export function parseArgs(argv: readonly string[]): Config {
  const get = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const sides = get("sides") ?? "left";
  if (sides !== "left" && sides !== "right" && sides !== "both") throw new Error("--sides");
  const weightsFile = get("weights") ?? null;
  const shard = get("shard");
  return {
    seeds: parseSeeds(get("seeds") ?? "1001-1200"),
    sides,
    adapt: get("adapt") === "1",
    preview: Number(get("preview") ?? BOT_DEFAULTS.preview),
    width: Number(get("width") ?? BOT_DEFAULTS.width),
    weights:
      weightsFile === null
        ? DEFAULT_WEIGHTS
        : (JSON.parse(readFileSync(weightsFile, "utf8")) as Weights),
    weightsFile,
    jobs: Number(get("jobs") ?? 1),
    out: get("out") ?? null,
    quiet: argv.includes("--quiet"),
    shard:
      shard === undefined ? null : (shard.split("/").map(Number) as unknown as [number, number]),
  };
}

function games(config: Config): Oriented[] {
  const list: Oriented[] = [];
  for (const seed of config.seeds) {
    if (config.sides !== "right") list.push({ seed, aSide: "left", record: null as never });
    if (config.sides !== "left") list.push({ seed, aSide: "right", record: null as never });
  }
  return list;
}

/** Worker: play this shard's games and stream one JSON line per game. */
function playShard(config: Config, index: number, count: number): void {
  const hoikoOptions = resolveFaithfulHoikoOptions({ HOIKO_ADAPT: config.adapt ? "1" : "0" });
  const plan = games(config).filter((_, i) => i % count === index);
  for (const game of plan) {
    const bot = createBot({
      preview: config.preview,
      width: config.width,
      weights: config.weights,
    });
    const hoiko = createHoiko(hoikoOptions);
    const record =
      game.aSide === "left" ? runMatch(bot, hoiko, game.seed) : runMatch(hoiko, bot, game.seed);
    console.log(JSON.stringify({ seed: game.seed, aSide: game.aSide, record }));
  }
}

/** Run the benchmark across `jobs` worker processes and return every game. */
export async function runBenchmark(config: Config, argv: readonly string[]): Promise<Oriented[]> {
  const workers = Array.from({ length: config.jobs }, (_, index) =>
    Bun.spawn(["bun", import.meta.path, ...argv, "--shard", `${index}/${config.jobs}`], {
      stdout: "pipe",
      stderr: "inherit",
    }),
  );
  const outputs = await Promise.all(workers.map((w) => new Response(w.stdout).text()));
  const results: Oriented[] = [];
  for (const text of outputs) {
    for (const line of text.split("\n")) if (line.trim() !== "") results.push(JSON.parse(line));
  }
  results.sort((a, b) => a.seed - b.seed || a.aSide.localeCompare(b.aSide));
  return results;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const config = parseArgs(argv);
  if (config.shard !== null) {
    playShard(config, config.shard[0], config.shard[1]);
    return;
  }
  const results = await runBenchmark(config, argv);
  if (config.out !== null) {
    writeFileSync(config.out, `${results.map((r) => JSON.stringify(r)).join("\n")}\n`);
  }
  if (!config.quiet) {
    for (const r of results) {
      const won = r.record.winner === r.aSide ? "W" : r.record.winner === "draw" ? "D" : "L";
      console.error(`seed ${r.seed} bot@${r.aSide} ${won}`);
    }
  }
  const summary = summarize(results);
  console.log(
    JSON.stringify({
      config: {
        seeds: `${config.seeds[0]}..${config.seeds[config.seeds.length - 1]} (${config.seeds.length})`,
        sides: config.sides,
        hoikoAdapt: config.adapt,
        preview: config.preview,
        width: config.width,
        weights: config.weightsFile ?? "default",
      },
      ...summary,
    }),
  );
}

if (import.meta.main) await main();
