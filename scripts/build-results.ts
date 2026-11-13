/**
 * Turn the raw per-game benchmark records in `bench-results/` into `src/data/results.json`,
 * the only numbers the web page shows.
 *
 *   bun scripts/build-results.ts
 *
 * Inputs (all optional except the first):
 *   bench-results/bot-vs-hoiko.jsonl            scripts/benchmark.ts --sides both (headline)
 *   bench-results/bot-vs-hoiko.preview2.jsonl   same, bot limited to Hoiko's 2-piece preview
 *   bench-results/bot-vs-hoiko.adapt.jsonl      same, Hoiko with its wall-clock beam adaptation
 *   bench-results/old-ai-vs-hoiko.jsonl         pre-overhaul AI (scripts/gate-v2.ts at the base
 *                                               commit + the rules fix), bot seat left
 *   bench-results/rules-audit.json              scripts/audit-rules.ts
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { MatchRecord, SideRecord } from "../src/bench/match.js";
import { type Oriented, summarize } from "../src/bench/summary.js";
import type { GameRow, MatchupRow, Results } from "../src/data/results.js";

const DIR = new URL("../bench-results/", import.meta.url);

function lines(file: string): unknown[] {
  return readFileSync(new URL(file, DIR), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l));
}

function exists(file: string): boolean {
  return existsSync(new URL(file, DIR));
}

/** Records written by scripts/gate-v2.ts (pre-overhaul harness, ours = left). */
interface GateMatch {
  readonly type: string;
  readonly seed: number;
  readonly winner: MatchRecord["winner"];
  readonly ticks: number;
  readonly left: {
    lines: number;
    sent: number;
    locks: number;
    tsd: number;
    tetris: number;
    maxHeight: number;
    thinkMs: number;
    thinkCount: number;
  };
  readonly right: GateMatch["left"];
}

function fromGate(file: string): Oriented[] {
  const side = (s: GateMatch["left"], fighter: string): SideRecord => ({
    fighter,
    lines: s.lines,
    sent: s.sent,
    locks: s.locks,
    tspins: s.tsd,
    quads: s.tetris,
    perfectClears: 0,
    maxHeight: s.maxHeight,
    thinkMs: s.thinkMs,
    decisions: s.thinkCount,
  });
  return (lines(file) as GateMatch[])
    .filter((r) => r.type === "HOIKO-match")
    .map((r) => ({
      seed: r.seed,
      aSide: "left" as const,
      record: {
        seed: r.seed,
        winner: r.winner,
        ticks: r.ticks,
        left: side(r.left, "old-ai"),
        right: side(r.right, "hoiko"),
      },
    }));
}

function row(id: string, label: string, detail: string, games: readonly Oriented[]): MatchupRow {
  const s = summarize(games);
  return {
    id,
    label,
    detail,
    games: s.games,
    wins: s.a.wins,
    losses: s.b.wins,
    draws: s.draws + s.caps,
    winRate: s.winRate,
    low: s.winRateLow,
    high: s.winRateHigh,
    attackPerPiece: s.a.attackPerPiece,
    rivalAttackPerPiece: s.b.attackPerPiece,
    linesPerGame: s.a.linesPerGame,
    rivalLinesPerGame: s.b.linesPerGame,
  };
}

const main = lines("bot-vs-hoiko.jsonl") as Oriented[];
const seeds = [...new Set(main.map((g) => g.seed))].sort((a, b) => a - b);
const seedText = `${seeds.length} held-out seeds (${seeds[0]}–${seeds[seeds.length - 1]})`;

const headline = row("bot", "DeepSeek vs Hoiko", "both seats per seed", main);
const rows: MatchupRow[] = [headline];
rows.push(
  row(
    "bot-left",
    "DeepSeek vs Hoiko, left seat only",
    "the old harness's protocol, for a like-for-like comparison",
    main.filter((g) => g.aSide === "left"),
  ),
);
if (exists("old-ai-vs-hoiko.jsonl")) {
  rows.push(
    row(
      "old-ai",
      "Previous AI vs Hoiko",
      "pre-overhaul code, same seeds, left seat, corrected rules",
      fromGate("old-ai-vs-hoiko.jsonl"),
    ),
  );
}
if (exists("bot-vs-hoiko.preview2.jsonl")) {
  rows.push(
    row(
      "preview2",
      "DeepSeek (2-piece preview) vs Hoiko",
      "bot limited to the 2 previews Hoiko is configured with",
      lines("bot-vs-hoiko.preview2.jsonl") as Oriented[],
    ),
  );
}
if (exists("bot-vs-hoiko.adapt.jsonl")) {
  rows.push(
    row(
      "adapt",
      "DeepSeek vs Hoiko (adaptive beam)",
      "Hoiko with its shipping wall-clock beam adaptation (not reproducible move-for-move)",
      lines("bot-vs-hoiko.adapt.jsonl") as Oriented[],
    ),
  );
}

const games: GameRow[] = main.map((g) => {
  const other = g.aSide === "left" ? "right" : "left";
  const result = g.record.winner === g.aSide ? 1 : g.record.winner === other ? 0 : 2;
  return [
    g.seed,
    g.aSide === "left" ? 0 : 1,
    result,
    g.record.ticks,
    g.record[g.aSide].sent,
    g.record[other].sent,
  ];
});

const audit = exists("rules-audit.json")
  ? (JSON.parse(readFileSync(new URL("rules-audit.json", DIR), "utf8")) as {
      locks: number;
      agree: number;
    })
  : { locks: 0, agree: 0 };

const results: Results = {
  generatedAt: new Date().toISOString(),
  commit: execSync("git rev-parse --short HEAD").toString().trim(),
  seeds: seedText,
  headline,
  rows,
  games,
  rulesAudit: { locks: audit.locks, agree: audit.agree },
};
writeFileSync(new URL("../src/data/results.json", import.meta.url), `${JSON.stringify(results)}\n`);
console.log(
  JSON.stringify({
    seeds: seedText,
    rows: rows.map((r) => `${r.id}: ${r.wins}-${r.losses} ${(r.winRate * 100).toFixed(1)}%`),
  }),
);
