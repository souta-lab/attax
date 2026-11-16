/**
 * Time the TS search over the dumped S2 cases (tools/search-port/dump-s2-cases.ts)
 * at a chosen width, one timing per case. Companion to the Rust CLI's batch mode
 * (which reports the same per-case timings for the Rust search), so the two can be
 * interleaved on one machine and compared per case.
 *
 * Usage: bun tools/search-port/bench-s2.ts CASES.jsonl --width N --out TIMINGS.json
 * At the dump width (48) it also verifies the reconstructed inputs reproduce the
 * recorded TS expectations exactly (best, line, value bits, candidates, nodes,
 * depth) — a reconstruction check, printed to stderr.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { type SearchInput, type SearchOptions, search } from "../../src/ai/bot/search.js";

const args = process.argv.slice(2);
const path = args.shift();
if (path === undefined) throw new Error("usage: bench-s2.ts CASES.jsonl --width N --out F");
let width = 48;
let out: string | undefined;
while (args.length > 0) {
  const a = args.shift() as string;
  if (a === "--width") width = Number(args.shift());
  else if (a === "--out") out = args.shift();
  else throw new Error(`unknown arg ${a}`);
}

interface Case {
  id: string;
  input: {
    board: number[];
    frame: number;
    garbageRows: number[] | null;
    active: SearchInput["active"];
    hold: SearchInput["hold"];
    canHold: boolean;
    preview: string[];
    b2b: boolean;
    b2bChain: number;
    combo: number;
    pending: number;
    dueThisLock: number;
    speculativePieces: string[];
  };
  options: { width: number; stock?: unknown; solvency?: unknown; rootVeto?: boolean };
  weights: SearchOptions["weights"];
  expect: unknown;
}

const cases = readFileSync(path, "utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as Case);

// Warm-up (JIT) on the first case, untimed.
const timings: { id: string; ms: number; nodes: number }[] = [];
let checked = 0;
let exact = 0;
for (const c of cases) {
  const input: SearchInput = {
    board: Uint16Array.from(c.input.board),
    frame: c.input.frame,
    garbageRows: c.input.garbageRows ?? undefined,
    active: c.input.active,
    hold: c.input.hold,
    canHold: c.input.canHold,
    preview: c.input.preview as SearchInput["preview"],
    b2b: c.input.b2b,
    b2bChain: c.input.b2bChain,
    combo: c.input.combo,
    pending: c.input.pending,
    dueThisLock: c.input.dueThisLock,
    speculativePieces: c.input.speculativePieces as SearchInput["speculativePieces"],
  };
  const options: SearchOptions = {
    weights: c.weights,
    width,
    profile: "s2",
    ...(c.options.stock ? { stock: c.options.stock as SearchOptions["stock"] } : {}),
    ...(c.options.solvency ? { solvency: c.options.solvency as SearchOptions["solvency"] } : {}),
    ...(c.options.rootVeto ? { rootVeto: true } : {}),
  };
  const t0 = performance.now();
  const result = search(input, options);
  const ms = performance.now() - t0;
  timings.push({ id: c.id, ms, nodes: result?.nodes ?? 0 });
  if (width === c.options.width) {
    checked += 1;
    const plain =
      result === null
        ? null
        : {
            best: result.best,
            line: result.line,
            value: result.value,
            candidates: result.candidates,
            nodes: result.nodes,
            depth: result.depth,
          };
    if (JSON.stringify(plain) === JSON.stringify(c.expect)) exact += 1;
  }
}
const sorted = timings.map((t) => t.ms).sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)] as number;
const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
console.error(
  `ts width ${width}: ${timings.length} cases, median ${median.toFixed(2)} ms, mean ${mean.toFixed(2)} ms` +
    (checked > 0 ? `; reconstruction exact ${exact}/${checked}` : ""),
);
if (out) {
  // This bench calls the TS search directly, so its record is labeled with the
  // reference engine's identity (engine rule: every record names its engine).
  const repoRoot = new URL("../../", import.meta.url).pathname;
  const git = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" });
  const record = {
    engine: { id: "ts-reference", build: git.status === 0 ? git.stdout.trim() : "unknown" },
    width,
    medianMs: median,
    meanMs: mean,
    timings,
  };
  writeFileSync(out, `${JSON.stringify(record)}\n`);
}
