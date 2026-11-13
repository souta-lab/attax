/**
 * Coordinate search over the bot's weights, scored by matches against Hoiko on TRAINING
 * seeds only (2001+; the held-out benchmark uses 1001-1200 and is never tuned on).
 *
 *   bun scripts/tune.ts --seeds 2001-2060 --jobs 2 --rounds 1 --out weights.tuned.json
 *
 * Fitness = win rate + attack-per-piece margin (bot - Hoiko). The margin is a smoother
 * signal than wins alone when the bot already wins most games. Each step tries scaling one
 * weight by 0.6x and 1.5x and keeps a change only if fitness improves by more than `--eps`.
 */
import { writeFileSync } from "node:fs";
import { DEFAULT_WEIGHTS, type Weights } from "../src/ai/bot/weights.js";
import { summarize } from "../src/bench/summary.js";
import { parseArgs, runBenchmark } from "./benchmark.js";

type Path = readonly [keyof Weights] | readonly ["board" | "clear", string];

const TUNABLE: readonly Path[] = [
  ["attack"],
  ["board", "holes"],
  ["board", "holeRows"],
  ["board", "danger"],
  ["board", "bumpiness"],
  ["board", "tSlot"],
  ["board", "wellDepth"],
  ["board", "maxHeight"],
  ["clear", "single"],
  ["clear", "double"],
  ["clear", "tspinDouble"],
  ["clear", "quad"],
  ["b2bBreak"],
  ["wastedT"],
];

function get(w: Weights, path: Path): number {
  if (path.length === 1) return w[path[0]] as number;
  return (w[path[0]] as Record<string, number>)[path[1]] as number;
}

function set(w: Weights, path: Path, value: number): Weights {
  if (path.length === 1) return { ...w, [path[0]]: value };
  return { ...w, [path[0]]: { ...(w[path[0]] as Record<string, number>), [path[1]]: value } };
}

async function fitness(weights: Weights, argv: readonly string[]): Promise<number> {
  const file = `/tmp/tune-candidate-${process.pid}.json`;
  writeFileSync(file, JSON.stringify(weights));
  const args = [...argv, "--weights", file, "--quiet"];
  const summary = summarize(await runBenchmark(parseArgs(args), args));
  return summary.winRate + (summary.a.attackPerPiece - summary.b.attackPerPiece);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get_ = (name: string, fallback: string): string => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? (argv[i + 1] as string) : fallback;
  };
  const benchArgs = ["--seeds", get_("seeds", "2001-2060"), "--jobs", get_("jobs", "2")];
  const rounds = Number(get_("rounds", "1"));
  const eps = Number(get_("eps", "0.02"));
  const out = get_("out", "weights.tuned.json");

  let best: Weights = DEFAULT_WEIGHTS;
  let bestFit = await fitness(best, benchArgs);
  console.log(JSON.stringify({ step: "baseline", fitness: bestFit }));
  for (let round = 0; round < rounds; round += 1) {
    for (const path of TUNABLE) {
      for (const factor of [0.6, 1.5]) {
        const value = Math.round(get(best, path) * factor * 100) / 100;
        const candidate = set(best, path, value);
        const fit = await fitness(candidate, benchArgs);
        const accepted = fit > bestFit + eps;
        console.log(
          JSON.stringify({ round, param: path.join("."), value, fitness: fit, accepted }),
        );
        if (accepted) {
          best = candidate;
          bestFit = fit;
          writeFileSync(out, `${JSON.stringify(best, null, 2)}\n`);
          break;
        }
      }
    }
  }
  writeFileSync(out, `${JSON.stringify(best, null, 2)}\n`);
  console.log(JSON.stringify({ step: "done", fitness: bestFit, out }));
}

await main();
