// Reproducible strength sweep for DeepSeek v2 (Rust wasm) against Rust Hoiko.
//
//   bun scripts/strength-sweep.ts
//   bun scripts/strength-sweep.ts --workers 6 --chunk 2
//   bun scripts/strength-sweep.ts --configs d7-w24-beam500,d10-w24-beam3000
//
// Runs every (v2 depth/width, Hoiko beam) configuration over the fixed fresh
// seed set, in parallel shards across the machine, and writes a machine-readable
// record plus a printed table. Output: evidence/strength/sweep.jsonl.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const GATE = join(import.meta.dir, "gate-v2.ts");

export const STRENGTH_SEEDS: readonly number[] = [
  301, 307, 311, 313, 317, 331, 337, 347, 349, 353, 359, 367,
];

export interface SweepConfig {
  readonly label: string;
  readonly depth: number;
  readonly width: number;
  readonly topK: number;
  readonly beam: number;
}

export const SWEEP_CONFIGS: readonly SweepConfig[] = [
  { label: "d7-w24-beam500", depth: 7, width: 24, topK: 16, beam: 500 },
  { label: "d7-w24-beam3000", depth: 7, width: 24, topK: 16, beam: 3000 },
  { label: "d10-w24-beam500", depth: 10, width: 24, topK: 16, beam: 500 },
  { label: "d10-w24-beam3000", depth: 10, width: 24, topK: 16, beam: 3000 },
  { label: "d10-w32-beam3000", depth: 10, width: 32, topK: 16, beam: 3000 },
  { label: "d13-w24-beam3000", depth: 13, width: 24, topK: 16, beam: 3000 },
];

interface GateSide {
  readonly lines: number;
  readonly sent: number;
  readonly thinkMs: number;
  readonly thinkCount: number;
}

interface GateMatch {
  readonly seed: number;
  readonly winner: "left" | "right" | "draw" | "cap";
  readonly reason: string;
  readonly ticks: number;
  readonly pieces: number;
  readonly left: GateSide;
  readonly right: GateSide;
}

export interface MatchRecord extends GateMatch {
  readonly config: string;
}

interface ConfigSummary {
  readonly config: SweepConfig;
  readonly matches: number;
  readonly wins: number;
  readonly losses: number;
  readonly draws: number;
  readonly caps: number;
  readonly leftLines: number;
  readonly rightLines: number;
  readonly leftSent: number;
  readonly rightSent: number;
  readonly ticks: number;
  readonly pieces: number;
  readonly leftThinkMs: number;
  readonly leftThinkCount: number;
  readonly rightThinkMs: number;
  readonly rightThinkCount: number;
  readonly perSeed: readonly MatchRecord[];
}

interface Args {
  readonly workers: number;
  readonly chunk: number;
  readonly maxTicks: number;
  readonly seeds: readonly number[];
  readonly configs: readonly SweepConfig[];
  readonly out: string;
  readonly json: boolean;
}

function readInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`expected positive integer, got ${raw}`);
  return value;
}

function parseArgs(argv: readonly string[]): Args {
  let workers = 6;
  let chunk = 2;
  let maxTicks = 12000;
  let seeds = STRENGTH_SEEDS;
  let configs = SWEEP_CONFIGS;
  let out = join(ROOT, "evidence", "strength", "sweep.jsonl");
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") json = true;
    else if (arg === "--workers") {
      workers = readInteger(argv[index + 1], workers);
      index += 1;
    } else if (arg === "--chunk") {
      chunk = readInteger(argv[index + 1], chunk);
      index += 1;
    } else if (arg === "--max-ticks") {
      maxTicks = readInteger(argv[index + 1], maxTicks);
      index += 1;
    } else if (arg === "--seeds") {
      seeds = (argv[index + 1] ?? "")
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value));
      index += 1;
    } else if (arg === "--configs") {
      const wanted = (argv[index + 1] ?? "").split(",").map((value) => value.trim());
      configs = SWEEP_CONFIGS.filter((config) => wanted.includes(config.label));
      if (configs.length !== wanted.length)
        throw new Error(`unknown config in ${wanted.join(",")}`);
      index += 1;
    } else if (arg === "--out") {
      const value = argv[index + 1];
      if (value === undefined) throw new Error("--out needs a path");
      out = resolve(value);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (seeds.length === 0) throw new Error("no seeds provided");
  return { workers, chunk, maxTicks, seeds, configs, out, json };
}

function chunkSeeds(seeds: readonly number[], size: number): number[][] {
  const out: number[][] = [];
  for (let index = 0; index < seeds.length; index += size)
    out.push(seeds.slice(index, index + size));
  return out;
}

function envFor(
  config: SweepConfig,
  maxTicks: number,
  seeds: readonly number[],
): Record<string, string> {
  return {
    ...process.env,
    DSV2_RUST: "1",
    DSV2_DEPTH: String(config.depth),
    DSV2_WIDTH: String(config.width),
    DSV2_TOP_K: String(config.topK),
    HOIKO_BEAM: String(config.beam),
    HOIKO_MAX_TICKS: String(maxTicks),
    HOIKO_SEEDS: seeds.join(","),
  } as Record<string, string>;
}

async function runChunk(
  config: SweepConfig,
  seeds: readonly number[],
  maxTicks: number,
): Promise<MatchRecord[]> {
  const proc = spawn("bun", [GATE], { cwd: ROOT, env: envFor(config, maxTicks, seeds) });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const code = await new Promise<number>((resolveCode) =>
    proc.on("close", (c) => resolveCode(c ?? 1)),
  );
  if (code !== 0)
    throw new Error(`gate-v2 exited ${code} for ${config.label}: ${stderr.slice(0, 500)}`);
  const records: MatchRecord[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.includes('"HOIKO-match"')) continue;
    const parsed = JSON.parse(line) as GateMatch;
    records.push({
      config: config.label,
      seed: parsed.seed,
      winner: parsed.winner,
      reason: parsed.reason,
      ticks: parsed.ticks,
      pieces: parsed.pieces,
      left: parsed.left,
      right: parsed.right,
    });
  }
  return records;
}

function summarize(config: SweepConfig, rows: readonly MatchRecord[]): ConfigSummary {
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let caps = 0;
  const totals = {
    leftLines: 0,
    rightLines: 0,
    leftSent: 0,
    rightSent: 0,
    ticks: 0,
    pieces: 0,
    leftThinkMs: 0,
    leftThinkCount: 0,
    rightThinkMs: 0,
    rightThinkCount: 0,
  };
  for (const row of rows) {
    if (row.winner === "left") wins += 1;
    else if (row.winner === "right") losses += 1;
    else if (row.winner === "draw") draws += 1;
    else caps += 1;
    totals.leftLines += row.left.lines;
    totals.rightLines += row.right.lines;
    totals.leftSent += row.left.sent;
    totals.rightSent += row.right.sent;
    totals.ticks += row.ticks;
    totals.pieces += row.pieces;
    totals.leftThinkMs += row.left.thinkMs;
    totals.leftThinkCount += row.left.thinkCount;
    totals.rightThinkMs += row.right.thinkMs;
    totals.rightThinkCount += row.right.thinkCount;
  }
  return {
    config,
    matches: rows.length,
    wins,
    losses,
    draws,
    caps,
    ...totals,
    perSeed: rows,
  };
}

function msPer(count: number, total: number): number {
  return total > 0 ? count / total : 0;
}

function fmt(value: number, digits = 1): string {
  return value.toFixed(digits);
}

function pad(value: string, width: number): string {
  return value.padStart(width);
}

function printTable(summaries: readonly ConfigSummary[]): void {
  const header = [
    "config".padEnd(16),
    pad("W-L-D/cap", 12),
    pad("lines F-A", 11),
    pad("line+", 7),
    pad("sent F-A", 10),
    pad("sent+", 7),
    pad("avgTick", 8),
    pad("v2 ms/mv", 9),
    pad("hko ms/mv", 9),
    pad("pieces", 8),
  ].join(" ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const s of summaries) {
    const wlc = `${s.wins}-${s.losses}-${s.draws}/${s.caps}`;
    const lines = `${s.leftLines}-${s.rightLines}`;
    const sent = `${s.leftSent}-${s.rightSent}`;
    console.log(
      [
        s.config.label.padEnd(16),
        pad(wlc, 12),
        pad(lines, 11),
        pad(`${s.leftLines - s.rightLines >= 0 ? "+" : ""}${s.leftLines - s.rightLines}`, 7),
        pad(sent, 10),
        pad(`${s.leftSent - s.rightSent >= 0 ? "+" : ""}${s.leftSent - s.rightSent}`, 7),
        pad(fmt(s.ticks / Math.max(1, s.matches), 0), 8),
        pad(fmt(msPer(s.leftThinkMs, s.leftThinkCount), 1), 9),
        pad(fmt(msPer(s.rightThinkMs, s.rightThinkCount), 1), 9),
        pad(String(Math.round(s.pieces / Math.max(1, s.matches))), 8),
      ].join(" "),
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const jobs: { readonly config: SweepConfig; readonly seeds: readonly number[] }[] = [];
  for (const config of args.configs) {
    for (const seeds of chunkSeeds(args.seeds, args.chunk)) jobs.push({ config, seeds });
  }
  const results: MatchRecord[][] = new Array(jobs.length);
  let next = 0;
  const started = performance.now();
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= jobs.length) return;
      const job = jobs[index];
      if (job === undefined) continue;
      results[index] = await runChunk(job.config, job.seeds, args.maxTicks);
    }
  };
  await Promise.all(Array.from({ length: Math.min(args.workers, jobs.length) }, () => worker()));
  const rows = results.flat();
  const summaries = args.configs.map((config) =>
    summarize(
      config,
      rows.filter((row) => row.config === config.label).sort((a, b) => a.seed - b.seed),
    ),
  );
  const payload = {
    generatedAt: new Date().toISOString(),
    engine: "rust-wasm",
    seeds: args.seeds,
    maxTicks: args.maxTicks,
    workers: args.workers,
    chunk: args.chunk,
    wallMs: performance.now() - started,
    summaries,
  };
  mkdirSync(dirname(args.out), { recursive: true });
  const meta = {
    type: "sweep-meta",
    generatedAt: payload.generatedAt,
    engine: payload.engine,
    seeds: payload.seeds,
    maxTicks: payload.maxTicks,
    workers: payload.workers,
    chunk: payload.chunk,
    wallMs: payload.wallMs,
  };
  const lines = [
    JSON.stringify(meta),
    ...rows.map((row) => JSON.stringify({ type: "sweep-match", ...row })),
    ...summaries.map((summary) => {
      const { perSeed, ...rest } = summary;
      void perSeed;
      return JSON.stringify({ type: "sweep-summary", ...rest });
    }),
  ];
  writeFileSync(args.out, `${lines.join("\n")}\n`);
  if (args.json) {
    console.log(JSON.stringify(payload));
    return;
  }
  console.log(`seeds: ${args.seeds.join(",")}`);
  console.log(`written: ${args.out}\n`);
  printTable(summaries);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
