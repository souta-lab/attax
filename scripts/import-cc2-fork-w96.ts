/**
 * Import the replay-verified v3-w96-fork-33001 external run into bench-results/external/cc2-fork-w96/
 * and compute + assert its summary.json from the imported per-seed files.
 *
 *   bun scripts/import-cc2-fork-w96.ts
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { wilson } from "../src/bench/summary.js";

interface RawMatch {
  readonly seed: number;
  readonly swapped: boolean;
  readonly winner: number | null;
  readonly turns: number;
  readonly attack: readonly [number, number];
  readonly lines: readonly [number, number];
  readonly pieces: readonly [number, number];
}

interface RawSeedRecord {
  readonly matches: readonly RawMatch[];
  readonly ms: number;
  readonly pps: number;
  readonly note: string;
}

const RAW_DIR = new URL("../tools/cc2-rematch/runs/v3-w96-fork-33001/", import.meta.url);
const OUT_DIR = new URL("../bench-results/external/cc2-fork-w96/", import.meta.url);

const SEED_FIRST = 33001;
const SEED_LAST = 33050;
const OPPONENT = "cold-clear-2-fork";
const UPSTREAM = "ed8b19327b6bd1410ddd873d8611485bd45d8fae";
const FORK_COMMIT = "b20a92b0ed3230dd910d0674f7a09c552a34dd46";
const RUN = "v3-w96-fork-33001";

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

function readRawText(name: string): string {
  return readFileSync(new URL(name, RAW_DIR), "utf8");
}

function importRecords(): { ms: number; pps: number; note: string } {
  mkdirSync(OUT_DIR, { recursive: true });
  let ms: number | null = null;
  let pps: number | null = null;
  let note: string | null = null;

  for (let seed = SEED_FIRST; seed <= SEED_LAST; seed += 1) {
    const verify = readRawText(`${seed}.verify`).trim();
    assert(
      verify === "verified 2 complete matches",
      `Seed ${seed} not replay-verified: ${JSON.stringify(verify)}`,
    );

    const raw = JSON.parse(readRawText(`${seed}.json`)) as RawSeedRecord;
    assert(raw.matches.length === 2, `Seed ${seed} expected 2 matches, got ${raw.matches.length}`);
    const swappedSet = new Set(raw.matches.map((m) => m.swapped));
    assert(
      swappedSet.has(false) && swappedSet.has(true),
      `Seed ${seed} missing swapped/unswapped pair`,
    );

    if (ms === null) ms = raw.ms;
    if (pps === null) pps = raw.pps;
    if (note === null) note = raw.note;
    assert(raw.ms === ms && raw.pps === pps && raw.note === note, `Settings mismatch at ${seed}`);

    const matches = raw.matches.map((m) => {
      assert(m.seed === seed, `Match seed mismatch: ${m.seed} != ${seed}`);
      return {
        seed: m.seed,
        swapped: m.swapped,
        winner: m.winner,
        turns: m.turns,
        attack: [m.attack[0], m.attack[1]],
        lines: [m.lines[0], m.lines[1]],
        pieces: [m.pieces[0], m.pieces[1]],
      };
    });

    writeFileSync(
      new URL(`cc2fork-${seed}.json`, OUT_DIR),
      `${JSON.stringify({ matches }, null, 2)}\n`,
    );
  }

  assert(ms !== null && pps !== null && note !== null, "Missing run metadata");
  return { ms: ms as number, pps: pps as number, note: note as string };
}

function readBeamWidth(): number {
  const envText = readRawText("environment.txt");
  const match = envText.match(/^ATTAX_WIDTH=(\d+)$/m);
  if (!match?.[1]) throw new Error("ATTAX_WIDTH not found in environment.txt");
  return Number(match[1]);
}

function computeAndAssertSummary(meta: { ms: number; pps: number; note: string }) {
  const files = readdirSync(OUT_DIR)
    .filter((name) => /^cc2fork-\d+\.json$/.test(name))
    .sort();
  assert(
    files.length === SEED_LAST - SEED_FIRST + 1,
    `Expected 50 imported files, got ${files.length}`,
  );

  let games = 0;
  let wins = 0;
  let losses = 0;
  let draws = 0;
  const seatWins = { "0": 0, "1": 0 };
  const attax = { pieces: 0, attack: 0, lines: 0 };
  const opponent = { pieces: 0, attack: 0, lines: 0 };

  for (const file of files) {
    const shard = JSON.parse(readFileSync(new URL(file, OUT_DIR), "utf8")) as {
      matches: RawMatch[];
    };
    for (const game of shard.matches) {
      games += 1;
      // Match scripts/external-results.ts orient(): unswapped = side 0, swapped = side 1.
      const attaxSeat = game.swapped ? 1 : 0;
      const oppSeat = 1 - attaxSeat;

      if (game.winner === null) {
        draws += 1;
      } else if (game.winner === attaxSeat) {
        wins += 1;
        if (attaxSeat === 0) seatWins["0"] += 1;
        else seatWins["1"] += 1;
      } else {
        losses += 1;
      }

      attax.pieces += game.pieces[attaxSeat] ?? 0;
      attax.attack += game.attack[attaxSeat] ?? 0;
      attax.lines += game.lines[attaxSeat] ?? 0;

      opponent.pieces += game.pieces[oppSeat] ?? 0;
      opponent.attack += game.attack[oppSeat] ?? 0;
      opponent.lines += game.lines[oppSeat] ?? 0;
    }
  }

  const attaxCommit = readRawText("commit.txt").trim();
  const beamWidth = readBeamWidth();
  const wilson95 = wilson(wins, games);

  const summary = {
    opponent: OPPONENT,
    games,
    wins,
    losses,
    draws,
    win_rate: wins / games,
    wilson95,
    totals: {
      attax: {
        pieces: attax.pieces,
        attack: attax.attack,
        lines: attax.lines,
        attack_per_piece: attax.attack / attax.pieces,
      },
      opponent: {
        pieces: opponent.pieces,
        attack: opponent.attack,
        lines: opponent.lines,
        attack_per_piece: opponent.attack / opponent.pieces,
      },
    },
    seat_wins: seatWins,
    ms: meta.ms,
    pps: meta.pps,
    upstream: UPSTREAM,
    run: RUN,
    note: meta.note,
    fork_commit: FORK_COMMIT,
    beam_width: beamWidth,
    seeds: [SEED_FIRST, SEED_LAST],
    attax_commit: attaxCommit,
  };

  assert(summary.games === 100, `games ${summary.games} != 100`);
  assert(summary.wins === 79, `wins ${summary.wins} != 79`);
  assert(summary.losses === 16, `losses ${summary.losses} != 16`);
  assert(summary.draws === 5, `draws ${summary.draws} != 5`);
  assert(summary.seat_wins["0"] === 38, `seat_wins[0] ${summary.seat_wins["0"]} != 38`);
  assert(summary.seat_wins["1"] === 41, `seat_wins[1] ${summary.seat_wins["1"]} != 41`);
  assert(
    summary.totals.attax.attack === 26567,
    `attax attack ${summary.totals.attax.attack} != 26567`,
  );
  assert(
    summary.totals.attax.pieces === 28820,
    `attax pieces ${summary.totals.attax.pieces} != 28820`,
  );
  assert(
    summary.totals.attax.lines === 23961,
    `attax lines ${summary.totals.attax.lines} != 23961`,
  );
  assert(
    summary.totals.opponent.attack === 23295,
    `opp attack ${summary.totals.opponent.attack} != 23295`,
  );
  assert(
    summary.totals.opponent.pieces === 28757,
    `opp pieces ${summary.totals.opponent.pieces} != 28757`,
  );
  assert(
    summary.totals.opponent.lines === 26080,
    `opp lines ${summary.totals.opponent.lines} != 26080`,
  );

  writeFileSync(new URL("summary.json", OUT_DIR), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

const meta = importRecords();
const summary = computeAndAssertSummary(meta);
console.log(JSON.stringify(summary, null, 2));
