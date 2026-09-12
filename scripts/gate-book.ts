// Measures the PCO opening book head-to-head against Rust Hoiko over a fixed
// set of fresh seeds, running the "without book" and "with book" configs in
// parallel across cores. Seeds are fixed up front and reported in full.
//
// Run: `bun scripts/gate-book.ts`
import { cpus } from "node:os";

const SEEDS = [401, 409, 419, 421, 431, 433, 439, 443, 449, 457, 461, 463] as const;

const CONFIGS = [
  { name: "without", env: {} },
  { name: "with", env: { DSV2_BOOK: "1" } },
] as const;

const SHARDS = Math.max(1, Number(process.env.BOOK_SHARDS ?? Math.min(6, cpus().length)));

interface SideMetrics {
  readonly lines: number;
  readonly sent: number;
  readonly locks: number;
  readonly tsd: number;
  readonly tetris: number;
  readonly mismatches: number;
  readonly expectedFailures: number;
}

interface Row {
  readonly seed: number;
  readonly winner: "left" | "right" | "draw" | "cap";
  readonly ticks: number;
  readonly left: SideMetrics;
  readonly right: SideMetrics;
}

interface Totals {
  matches: number;
  wins: number;
  losses: number;
  draws: number;
  caps: number;
  ticks: number;
  linesFor: number;
  linesAgainst: number;
  sentFor: number;
  sentAgainst: number;
  locksFor: number;
  tsd: number;
  tetris: number;
  mismatches: number;
  expectedFailures: number;
}

function emptyTotals(): Totals {
  return {
    matches: 0,
    wins: 0,
    losses: 0,
    draws: 0,
    caps: 0,
    ticks: 0,
    linesFor: 0,
    linesAgainst: 0,
    sentFor: 0,
    sentAgainst: 0,
    locksFor: 0,
    tsd: 0,
    tetris: 0,
    mismatches: 0,
    expectedFailures: 0,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseSide(value: unknown): SideMetrics {
  const record = isRecord(value) ? value : {};
  return {
    lines: num(record.lines),
    sent: num(record.sent),
    locks: num(record.locks),
    tsd: num(record.tsd),
    tetris: num(record.tetris),
    mismatches: num(record.executionSourceMismatches),
    expectedFailures: num(record.executionExpectedBoardFailures),
  };
}

function parseRows(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || parsed.type !== "HOIKO-match") continue;
    const winner = parsed.winner;
    if (winner !== "left" && winner !== "right" && winner !== "draw" && winner !== "cap") continue;
    rows.push({
      seed: num(parsed.seed),
      winner,
      ticks: num(parsed.ticks),
      left: parseSide(parsed.left),
      right: parseSide(parsed.right),
    });
  }
  return rows;
}

function tally(rows: readonly Row[]): Totals {
  const totals = emptyTotals();
  for (const row of rows) {
    totals.matches += 1;
    if (row.winner === "left") totals.wins += 1;
    else if (row.winner === "right") totals.losses += 1;
    else if (row.winner === "draw") totals.draws += 1;
    else totals.caps += 1;
    totals.ticks += row.ticks;
    totals.linesFor += row.left.lines;
    totals.linesAgainst += row.right.lines;
    totals.sentFor += row.left.sent;
    totals.sentAgainst += row.right.sent;
    totals.locksFor += row.left.locks;
    totals.tsd += row.left.tsd;
    totals.tetris += row.left.tetris;
    totals.mismatches += row.left.mismatches + row.right.mismatches;
    totals.expectedFailures += row.left.expectedFailures + row.right.expectedFailures;
  }
  return totals;
}

async function runConfig(config: (typeof CONFIGS)[number]): Promise<Row[]> {
  const buckets: number[][] = Array.from({ length: SHARDS }, () => []);
  SEEDS.forEach((seed, index) => buckets[index % SHARDS]?.push(seed));
  const runs = buckets
    .filter((bucket) => bucket.length > 0)
    .map(async (bucket) => {
      const proc = Bun.spawn(["bun", "scripts/gate-v2.ts"], {
        cwd: new URL("..", import.meta.url).pathname,
        env: { ...process.env, HOIKO_SEEDS: bucket.join(","), ...config.env },
        stdout: "pipe",
        stderr: "inherit",
      });
      const [text, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      if (exitCode !== 0) throw new Error(`gate-v2 (${config.name}) exited ${exitCode}`);
      return parseRows(text);
    });
  const lists = await Promise.all(runs);
  return lists.flat().sort((a, b) => a.seed - b.seed);
}

function fmt(value: number, digits = 2): string {
  return value.toFixed(digits);
}

async function printComparison(rowsByConfig: ReadonlyMap<string, readonly Row[]>): Promise<void> {
  const table: Array<Record<string, string>> = [];
  for (const config of CONFIGS) {
    const rows = rowsByConfig.get(config.name) ?? [];
    const totals = tally(rows);
    table.push({
      config: config.name,
      "W-L-D/cap": `${totals.wins}-${totals.losses}-${totals.draws}/${totals.caps}`,
      lines: `${totals.linesFor}-${totals.linesAgainst}`,
      sent: `${totals.sentFor}-${totals.sentAgainst}`,
      "avg ticks": fmt(totals.matches > 0 ? totals.ticks / totals.matches : 0, 0),
      "atk/piece": fmt(totals.locksFor > 0 ? totals.sentFor / totals.locksFor : 0, 3),
      tsd: String(totals.tsd),
      tetris: String(totals.tetris),
      "exec fails": String(totals.mismatches + totals.expectedFailures),
    });
  }
  console.log("\n=== opening-book gate (fixed fresh seeds) ===");
  console.table(table);

  const without = rowsByConfig.get("without") ?? [];
  const withBook = rowsByConfig.get("with") ?? [];
  const withoutBySeed = new Map(without.map((row) => [row.seed, row]));
  let regressions = 0;
  console.log("\nper-seed winners (without -> with):");
  const perSeed: Array<Record<string, string | number>> = [];
  for (const seed of SEEDS) {
    const a = withoutBySeed.get(seed);
    const b = withBook.find((row) => row.seed === seed);
    const aw = a?.winner ?? "?";
    const bw = b?.winner ?? "?";
    const worse = aw === "left" && bw !== "left";
    if (worse) regressions += 1;
    console.log(`  ${seed}: ${aw} -> ${bw}${worse ? "  <-- REGRESSION" : ""}`);
    perSeed.push({
      seed,
      "winner(without)": aw,
      "winner(with)": bw,
      "ticks(without)": a?.ticks ?? 0,
      "ticks(with)": b?.ticks ?? 0,
      "linesFor(without)": a?.left.lines ?? 0,
      "linesFor(with)": b?.left.lines ?? 0,
      "sent(without)": a?.left.sent ?? 0,
      "sent(with)": b?.left.sent ?? 0,
      "locks(without)": a?.left.locks ?? 0,
      "locks(with)": b?.left.locks ?? 0,
    });
  }
  console.log(`\nseeds with a reduced result: ${regressions}`);
  console.log("\nper-seed efficiency (without -> with):");
  console.table(perSeed);

  const evidence = {
    seeds: [...SEEDS],
    shards: SHARDS,
    configs: table,
    perSeed,
    regressions,
  };
  const dir = new URL("../evidence/opening-book", import.meta.url).pathname;
  await Bun.write(`${dir}/gate.jsonl`, `${JSON.stringify(evidence)}\n`);
}

async function main(): Promise<void> {
  const results = new Map<string, readonly Row[]>();
  await Promise.all(
    CONFIGS.map(async (config) => {
      console.log(`running ${config.name} over ${SEEDS.length} seeds in ${SHARDS} shards...`);
      const rows = await runConfig(config);
      results.set(config.name, rows);
    }),
  );
  await printComparison(results);
}

await main();
