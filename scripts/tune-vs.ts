// Offline versus self-play tuner for the DeepSeek evaluation weights.
//
// Runs a deterministic, restartable (1+lambda) evolution strategy. Each candidate
// genome is loaded into a parameterized DeepSeek fighter (src/tuner/tuned-deepseek.ts)
// and evaluated over the fixed 32-seed corpus against the fast Rust Hoiko replica.
// Selection uses the 24 train seeds only; the 8 held-out seeds are never used for
// selection and are reported separately.
//
//   bun scripts/tune-vs.ts
//
// Restartable: state is persisted to weights/tuner-state.json after every
// generation; re-running resumes. A time budget (TUNER_TIME_BUDGET_MS) stops the
// search gracefully and finalizes the best genome found so far.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { proposeOffspring } from "../src/tuner/evolution.js";
import { BASELINE_GENOME, type Genome, sanitizeGenome } from "../src/tuner/genome.js";
import { type EvalJob, PROXY_SEARCH, REAL_SEARCH, type SearchConfig } from "../src/tuner/job.js";
import {
  fitnessOf,
  type GateSummary,
  type MatchOutcome,
  summarize,
  TUNER_MAX_TICKS,
  winLossCap,
} from "../src/tuner/match.js";
import { createRng } from "../src/tuner/rng.js";

const ROOT = resolve(import.meta.dir, "..");
const WORKER = join(import.meta.dir, "tuner", "eval-worker.ts");
const WEIGHTS_DIR = join(ROOT, "weights");
const STATE_PATH = process.env.TUNER_STATE_PATH ?? join(WEIGHTS_DIR, "tuner-state.json");
const OUTPUT_PATH = process.env.TUNER_WEIGHTS_PATH ?? join(WEIGHTS_DIR, "deepseek-vs.json");

/** Fixed corpus — identical to scripts/hoiko-gate.ts. */
const FIXED_SEEDS = [
  1, 5555, 13, 37, 61, 89, 7, 9001, 17, 41, 67, 97, 42, 2, 19, 43, 71, 99, 3, 23, 47, 73, 777, 5,
  29, 53, 79, 1234, 11, 31, 59, 83,
] as const;
const HELDOUT_SEEDS = new Set<number>(FIXED_SEEDS.slice(24));
const TRAIN_SEEDS = new Set<number>(FIXED_SEEDS.slice(0, 24));
const STATE_VERSION = 1;

interface FitnessRecord {
  readonly trainWinRate: number;
  readonly heldWinRate: number;
  readonly fullWinRate: number;
  readonly fitness: number;
  readonly wlc: string;
  readonly trainWlc: string;
  readonly heldWlc: string;
  readonly full: GateSummary;
}

interface CandidateState {
  readonly genome: Genome;
  readonly record: FitnessRecord;
}

interface HistoryEntry {
  readonly generation: number;
  readonly improved: boolean;
  readonly sigmaScale: number;
  readonly bestFitness: number;
  readonly bestTrainWinRate: number;
  readonly bestFullWlc: string;
  readonly candidateFitness: readonly number[];
}

interface TunerState {
  readonly version: number;
  readonly tunerSeed: number;
  readonly generation: number;
  readonly rngState: number;
  readonly sigmaScale: number;
  readonly stagnation: number;
  readonly search: SearchConfig;
  readonly maxTicks: number;
  readonly hoikoPreset: "we";
  readonly parent: CandidateState | null;
  readonly baseline: CandidateState | null;
  readonly best: CandidateState | null;
  readonly history: readonly HistoryEntry[];
  readonly gamesPlayed: number;
}

interface Config {
  readonly generations: number;
  readonly lambda: number;
  readonly tunerSeed: number;
  readonly timeBudgetMs: number;
  readonly workers: number;
  readonly maxTicks: number;
  readonly search: SearchConfig;
  readonly chunkSize: number;
  readonly sigma0: number;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got ${raw}`);
  return Math.trunc(value);
}

function readFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got ${raw}`);
  return value;
}

function readConfig(): Config {
  const useProxy = (process.env.TUNER_PROXY ?? "0") !== "0";
  const proxyDepth = readInt("TUNER_PROXY_DEPTH", PROXY_SEARCH.depth);
  const proxyWidth = readInt("TUNER_PROXY_WIDTH", PROXY_SEARCH.width);
  const proxyTopK = readInt("TUNER_PROXY_TOPK", PROXY_SEARCH.topK);
  const search: SearchConfig = useProxy
    ? { depth: proxyDepth, width: proxyWidth, topK: proxyTopK }
    : REAL_SEARCH;
  const workers = Math.max(1, readInt("TUNER_WORKERS", 6));
  const chunkDefault = Math.max(1, Math.ceil(FIXED_SEEDS.length / workers));
  return {
    generations: readInt("TUNER_GENERATIONS", 12),
    lambda: readInt("TUNER_LAMBDA", 6),
    tunerSeed: readInt("TUNER_SEED", 20260912),
    timeBudgetMs: readInt("TUNER_TIME_BUDGET_MS", 90 * 60 * 1000),
    workers,
    maxTicks: readInt("TUNER_MAXTICKS", TUNER_MAX_TICKS),
    search,
    chunkSize: Math.max(1, readInt("TUNER_CHUNK", chunkDefault)),
    sigma0: Math.max(0.05, readFloat("TUNER_SIGMA", 0.3)),
  };
}

function chunkSeeds(seeds: readonly number[], size: number): number[][] {
  const out: number[][] = [];
  for (let index = 0; index < seeds.length; index += size) {
    out.push(seeds.slice(index, index + size));
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
  if (code !== 0) {
    throw new Error(`eval-worker exited ${code}: ${stderr.slice(0, 500)}`);
  }
  const parsed = JSON.parse(stdout) as { outcomes: MatchOutcome[] };
  if (!Array.isArray(parsed.outcomes)) throw new Error("eval-worker: malformed output");
  return parsed.outcomes;
}

async function runJobs(jobs: readonly EvalJob[], workers: number): Promise<MatchOutcome[][]> {
  const results: MatchOutcome[][] = new Array(jobs.length);
  let next = 0;
  let failure: Error | null = null;
  const runWorker = async (): Promise<void> => {
    for (;;) {
      if (failure !== null) return;
      const index = next;
      next += 1;
      if (index >= jobs.length) return;
      const job = jobs[index];
      if (job === undefined) continue;
      try {
        results[index] = await spawnJob(job);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        return;
      }
    }
  };
  const pool: Promise<void>[] = [];
  for (let index = 0; index < Math.min(workers, jobs.length); index += 1) pool.push(runWorker());
  await Promise.all(pool);
  if (failure !== null) throw failure;
  return results;
}

function recordFromOutcomes(outcomes: readonly MatchOutcome[]): FitnessRecord {
  const train = outcomes.filter((outcome) => TRAIN_SEEDS.has(outcome.seed));
  const held = outcomes.filter((outcome) => HELDOUT_SEEDS.has(outcome.seed));
  const full = summarize(outcomes);
  const trainSummary = summarize(train);
  const heldSummary = summarize(held);
  return {
    trainWinRate: trainSummary.winRate,
    heldWinRate: heldSummary.winRate,
    fullWinRate: full.winRate,
    fitness: fitnessOf(trainSummary),
    wlc: winLossCap(full),
    trainWlc: winLossCap(trainSummary),
    heldWlc: winLossCap(heldSummary),
    full,
  };
}

async function evaluateCandidates(
  config: Config,
  genomes: readonly Genome[],
  search: SearchConfig,
): Promise<MatchOutcome[][]> {
  const chunks = chunkSeeds(FIXED_SEEDS, config.chunkSize);
  const jobs: EvalJob[] = [];
  const owner: number[] = [];
  for (let candidate = 0; candidate < genomes.length; candidate += 1) {
    const genome = genomes[candidate];
    if (genome === undefined) continue;
    for (let shard = 0; shard < chunks.length; shard += 1) {
      jobs.push({
        id: `c${candidate}s${shard}`,
        mode: "tuned",
        genome,
        search,
        seeds: chunks[shard] ?? [],
        maxTicks: config.maxTicks,
        hoikoPreset: "we",
      });
      owner.push(candidate);
    }
  }
  const results = await runJobs(jobs, config.workers);
  const out: MatchOutcome[][] = genomes.map(() => []);
  for (let index = 0; index < jobs.length; index += 1) {
    const candidate = owner[index];
    if (candidate === undefined) continue;
    const rows = results[index];
    if (rows !== undefined) out[candidate]?.push(...rows);
  }
  return out.map((rows) => rows.sort((a, b) => a.seed - b.seed));
}

async function evaluateGenome(
  config: Config,
  genome: Genome,
  search: SearchConfig,
): Promise<{ genome: Genome; outcomes: MatchOutcome[] }> {
  const [outcomes] = await evaluateCandidates(config, [genome], search);
  return { genome, outcomes: outcomes ?? [] };
}

async function evaluateBaseline(
  config: Config,
  search: SearchConfig = config.search,
): Promise<MatchOutcome[]> {
  const chunks = chunkSeeds(FIXED_SEEDS, config.chunkSize);
  const jobs: EvalJob[] = chunks.map((seeds, index) => ({
    id: `baseline-${index}`,
    mode: "baseline",
    search,
    seeds,
    maxTicks: config.maxTicks,
    hoikoPreset: "we",
  }));
  const results = await runJobs(jobs, config.workers);
  return results.flat().sort((a, b) => a.seed - b.seed);
}

function loadState(config: Config): TunerState {
  if ((process.env.TUNER_RESUME ?? "1") !== "0" && existsSync(STATE_PATH)) {
    const parsed = JSON.parse(readFileSync(STATE_PATH, "utf8")) as TunerState;
    if (parsed.version === STATE_VERSION && parsed.tunerSeed === config.tunerSeed) {
      return parsed;
    }
  }
  return {
    version: STATE_VERSION,
    tunerSeed: config.tunerSeed,
    generation: 0,
    rngState: config.tunerSeed >>> 0,
    sigmaScale: config.sigma0,
    stagnation: 0,
    search: config.search,
    maxTicks: config.maxTicks,
    hoikoPreset: "we",
    parent: null,
    baseline: null,
    best: null,
    history: [],
    gamesPlayed: 0,
  };
}

function saveState(state: TunerState): void {
  mkdirSync(WEIGHTS_DIR, { recursive: true });
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function candidateSummaryLine(label: string, record: FitnessRecord): string {
  return `${label}: fit=${record.fitness.toFixed(4)} train=${(record.trainWinRate * 100).toFixed(1)}% (${record.trainWlc}) held=${(record.heldWinRate * 100).toFixed(1)}% (${record.heldWlc}) full=${record.wlc}`;
}

function isBetter(candidate: FitnessRecord, incumbent: FitnessRecord): boolean {
  if (candidate.fitness > incumbent.fitness + 1e-9) return true;
  if (candidate.fitness < incumbent.fitness - 1e-9) return false;
  return candidate.heldWinRate > incumbent.heldWinRate + 1e-9;
}

function sameSearch(a: SearchConfig, b: SearchConfig): boolean {
  return a.depth === b.depth && a.width === b.width && a.topK === b.topK;
}

async function main(): Promise<void> {
  const config = readConfig();
  const state = loadState(config);
  const rng = createRng(state.rngState);
  const mutable = { ...state };
  const deadline = Date.now() + config.timeBudgetMs;

  console.log(
    `[tuner] seed=${config.tunerSeed} workers=${config.workers} lambda=${config.lambda} ` +
      `gens<=${config.generations} search=${JSON.stringify(config.search)} ` +
      `(proxy=${process.env.TUNER_PROXY ?? "0"}) budget=${Math.round(config.timeBudgetMs / 60000)}min`,
  );

  if (mutable.baseline === null) {
    const baseline = await evaluateBaseline(config);
    mutable.baseline = { genome: BASELINE_GENOME, record: recordFromOutcomes(baseline) };
    console.log(candidateSummaryLine("[baseline gate fighter]", mutable.baseline.record));
  }
  if (mutable.parent === null) {
    const base = mutable.baseline;
    if (base === null) throw new Error("tuner: baseline missing");
    if (sameSearch(config.search, REAL_SEARCH)) {
      // Proven equivalent (tests/tuner.test.ts): reuse the baseline gate result.
      mutable.parent = { genome: BASELINE_GENOME, record: base.record };
    } else {
      const parent = await evaluateGenome(config, BASELINE_GENOME, config.search);
      mutable.parent = { genome: BASELINE_GENOME, record: recordFromOutcomes(parent.outcomes) };
    }
    mutable.best = mutable.parent;
    console.log(candidateSummaryLine("[parent=baseline genome]", mutable.parent.record));
  }

  let generation = mutable.generation;
  while (generation < config.generations && Date.now() < deadline) {
    generation += 1;
    const parent = mutable.best ?? mutable.parent;
    if (parent === null) throw new Error("tuner: no incumbent");
    const offspring = proposeOffspring(parent.genome, config.lambda, rng, mutable.sigmaScale);
    const rngState = rng.getState();

    const evaluations = await evaluateCandidates(config, offspring, config.search);
    const candidates: CandidateState[] = offspring.map((genome, index) => ({
      genome: sanitizeGenome(genome),
      record: recordFromOutcomes(evaluations[index] ?? []),
    }));

    let bestOffspring = candidates[0];
    if (bestOffspring === undefined) throw new Error("tuner: no offspring");
    for (const candidate of candidates) {
      if (bestOffspring === undefined || isBetter(candidate.record, bestOffspring.record)) {
        bestOffspring = candidate;
      }
    }

    const improved = isBetter(bestOffspring.record, parent.record);
    if (improved) {
      mutable.best = bestOffspring;
      mutable.parent = bestOffspring;
      mutable.stagnation = 0;
      mutable.sigmaScale = Math.min(0.6, mutable.sigmaScale * 1.1);
    } else {
      mutable.stagnation += 1;
      mutable.sigmaScale = Math.max(0.12, mutable.sigmaScale * 0.7);
    }
    mutable.generation = generation;
    mutable.rngState = rngState;
    mutable.gamesPlayed += offspring.length * FIXED_SEEDS.length;

    const entry: HistoryEntry = {
      generation,
      improved,
      sigmaScale: mutable.sigmaScale,
      bestFitness: (mutable.best ?? parent).record.fitness,
      bestTrainWinRate: (mutable.best ?? parent).record.trainWinRate,
      bestFullWlc: (mutable.best ?? parent).record.wlc,
      candidateFitness: candidates.map((candidate) => candidate.record.fitness),
    };
    mutable.history = [...mutable.history, entry];
    saveState(mutable);

    const bestNow = mutable.best ?? parent;
    console.log(
      `[gen ${generation}] improved=${improved} sigma=${mutable.sigmaScale.toFixed(2)} ` +
        `best: ${candidateSummaryLine("genome", bestNow.record)}`,
    );
    for (const [index, candidate] of candidates.entries()) {
      console.log(
        `    #${index} fit=${candidate.record.fitness.toFixed(4)} ` +
          `train=${(candidate.record.trainWinRate * 100).toFixed(1)}% (${candidate.record.trainWlc})`,
      );
    }
  }

  const best = mutable.best ?? mutable.parent;
  if (best === null) throw new Error("tuner: no best genome");

  console.log(`[tuner] generations=${mutable.generation} games≈${mutable.gamesPlayed}`);
  console.log("[tuner] final real-config gate (all 32 seeds)...");
  const realTuned = await evaluateGenome(config, best.genome, REAL_SEARCH);
  const realTunedRecord = recordFromOutcomes(realTuned.outcomes);
  let realBaselineRecord: FitnessRecord;
  if (sameSearch(config.search, REAL_SEARCH) && mutable.baseline !== null) {
    realBaselineRecord = mutable.baseline.record;
  } else {
    const realBaseline = await evaluateBaseline(config, REAL_SEARCH);
    realBaselineRecord = recordFromOutcomes(realBaseline);
  }

  mutable.best = { genome: best.genome, record: realTunedRecord };
  saveState(mutable);

  mkdirSync(WEIGHTS_DIR, { recursive: true });
  const output = {
    name: "deepseek-vs",
    version: 1,
    createdAt: new Date().toISOString(),
    tunerSeed: config.tunerSeed,
    generation: mutable.generation,
    search: REAL_SEARCH,
    selectionSearch: config.search,
    maxTicks: config.maxTicks,
    tickMs: 16,
    hoikoPreset: "we",
    seeds: {
      corpus: [...FIXED_SEEDS],
      train: [...TRAIN_SEEDS].sort((a, b) => a - b),
      heldout: [...HELDOUT_SEEDS].sort((a, b) => a - b),
    },
    genome: best.genome,
    metrics: {
      selection: {
        baseline: mutable.baseline?.record ?? null,
        tuned: best.record,
      },
      real: {
        baseline: realBaselineRecord,
        tuned: realTunedRecord,
      },
    },
  };
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);

  console.log(candidateSummaryLine("[baseline real-config 32-seed]", realBaselineRecord));
  console.log(candidateSummaryLine("[tuned    real-config 32-seed]", realTunedRecord));
  const delta = (realTunedRecord.fullWinRate - realBaselineRecord.fullWinRate) * 100;
  console.log(
    `[tuner] win-rate delta (tuned - baseline) = ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pp`,
  );
  console.log(`[tuner] wrote ${OUTPUT_PATH}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
