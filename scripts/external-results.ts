/** Convert external-rig result records; these are not runs of our benchmark harness. */
import { readdirSync, readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { SideRecord } from "../src/bench/match.js";
import type { Oriented } from "../src/bench/summary.js";

const ROOT = new URL("../bench-results/external/", import.meta.url);
export function externalText(path: string): string {
  return readFileSync(new URL(path, ROOT), "utf8");
}
interface ExternalGame {
  seed: number;
  swapped: boolean;
  winner: number | null;
  turns: number;
  attack: number[];
  lines: number[];
  pieces: number[];
}

function checkPairs(games: readonly Oriented[]): void {
  const pairs = new Map<number, Set<string>>();
  for (const game of games) {
    const seats = pairs.get(game.seed) ?? new Set<string>();
    if (seats.has(game.aSide)) throw new Error(`Duplicate seat: ${game.seed} ${game.aSide}`);
    seats.add(game.aSide);
    pairs.set(game.seed, seats);
  }
  if ([...pairs.values()].some((seats) => seats.size !== 2)) {
    throw new Error("Incomplete external seed pair");
  }
}

function orient(game: ExternalGame, attaxSeat: number, rival: string): Oriented {
  const side = (seat: number): SideRecord => ({
    fighter: seat === attaxSeat ? "attax" : rival,
    // External APP measures generated attack BEFORE cancellation, unlike Hoiko's sent APP.
    sent: game.attack[seat] ?? 0,
    lines: game.lines[seat] ?? 0,
    locks: game.pieces[seat] ?? 0,
    tspins: 0,
    quads: 0,
    perfectClears: 0,
    maxHeight: 0,
    thinkMs: 0,
    decisions: 0,
  });
  return {
    seed: game.seed,
    aSide: attaxSeat === 0 ? "left" : "right",
    record: {
      seed: game.seed,
      ticks: game.turns,
      winner: game.winner === null ? "draw" : game.winner === 0 ? "left" : "right",
      left: side(0),
      right: side(1),
    },
  };
}

export function intetrigenceRun(): {
  games: Oriented[];
  ms: number;
  pps: number;
  medianMs: number;
} {
  const replay = gunzipSync(
    readFileSync(new URL("intetrigence/final-5001-5050.jsonl.gz", ROOT)),
  ).toString("utf8");
  let attaxSeat = -1;
  let ms = 0;
  let pps = 0;
  const thinkMs: number[] = [];
  const games: Oriented[] = [];
  for (const line of replay.trim().split("\n")) {
    const r = JSON.parse(line);
    if (r.type === "start") {
      ms = r.ms;
      pps = r.pps;
      if (r.external_opponent !== "./attax-tbp.sh") throw new Error("Unknown external bot");
      // The original referee hard-codes cold_clear_2 for the external Attax client.
      attaxSeat = r.agents.indexOf("cold_clear_2");
      if (attaxSeat < 0) throw new Error("Missing Attax seat");
    } else if (r.type === "move" && r.agent === "intetrigence") {
      thinkMs.push(r.stats.elapsed_us / 1000);
    } else if (r.type === "result") {
      if (attaxSeat < 0) throw new Error("Result without start");
      games.push(orient(r.result, attaxSeat, "intetrigence"));
      attaxSeat = -1;
    }
  }
  if (attaxSeat !== -1) throw new Error("Incomplete external game");
  checkPairs(games);
  thinkMs.sort((a, b) => a - b);
  return { games, ms, pps, medianMs: thinkMs[Math.floor(thinkMs.length / 2)] ?? 0 };
}

export function clysGames(): Oriented[] {
  const games = readdirSync(new URL("clys/", ROOT))
    .filter((name) => /^clys-70\d\d\.json$/.test(name))
    .sort()
    .flatMap((name) => {
      const shard = JSON.parse(externalText(`clys/${name}`)) as { matches: ExternalGame[] };
      return shard.matches.map((game) => orient(game, game.swapped ? 1 : 0, "clys"));
    });
  checkPairs(games);
  return games;
}

/** Resolve editorial templates exclusively from imported records and condition summaries. */
export function pageCopy(facts: Record<string, string | number>): {
  claim: string;
  profiles: string[];
  fairness: string[];
  unmeasured: string[];
} {
  const template = externalText("copy-template.json");
  const resolved = template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = facts[key];
    if (value === undefined) throw new Error(`Missing copy evidence: ${key}`);
    return String(value);
  });
  return JSON.parse(resolved);
}
