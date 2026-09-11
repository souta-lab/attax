// Evaluation worker: plays a shard of deterministic versus matches against the
// Rust Hoiko replica and prints the outcomes as JSON on stdout.
//
// Usage: bun scripts/tuner/eval-worker.ts '<job-json>'
// The orchestrator (scripts/tune-vs.ts) spawns several of these in parallel so a
// generation is spread across all CPU cores.

import { createDeepSeekTetris } from "../../src/ai/deepseek.js";
import { resolveGenome } from "../../src/tuner/genome.js";
import type { EvalJob } from "../../src/tuner/job.js";
import { type MatchOutcome, runTunerMatch } from "../../src/tuner/match.js";
import { createTunedDeepSeek } from "../../src/tuner/tuned-deepseek.js";
import type { VersusFighter } from "../../src/versus/controller.js";
import { createRustHoiko } from "../../tools/hoiko-rust/loader.js";

const OUR_COLOR = "#3aa0ff";

function makeOurFighter(job: EvalJob): VersusFighter {
  if (job.mode === "baseline") {
    return { ...createDeepSeekTetris(), color: OUR_COLOR };
  }
  const genome = resolveGenome(job.genome ?? {});
  return {
    ...createTunedDeepSeek(genome, job.search === undefined ? {} : { search: job.search }),
    color: OUR_COLOR,
  };
}

function main(): void {
  const raw = process.argv[2];
  if (raw === undefined) throw new Error("missing job JSON argument");
  const job = JSON.parse(raw) as EvalJob;
  const outcomes: MatchOutcome[] = [];
  for (const seed of job.seeds) {
    const ours = makeOurFighter(job);
    const hoiko = createRustHoiko({ weightPreset: job.hoikoPreset, beamSizeLimit: 500 });
    outcomes.push(runTunerMatch(seed, ours, hoiko, job.maxTicks));
  }
  process.stdout.write(JSON.stringify({ outcomes }));
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
}
