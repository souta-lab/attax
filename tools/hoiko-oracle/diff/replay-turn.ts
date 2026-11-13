/**
 * Replay a fullgame JSONL locally (no wine) and dump the exact engine snapshot
 * at a chosen turn, so the divergence position can be fed to the Rust probes.
 *
 *   bun replay-turn.ts --jsonl=evidence/hoiko-fullgame/fixed-seed1-cap500.jsonl \
 *     --turn=196 [--out=evidence/hoiko-fullgame/chase196/snapshot-turn196.json] \
 *     [--eval-input=evidence/hoiko-fullgame/chase196/eval-input-turn196.txt]
 *
 * The engine sequence is the same `createEngine` + `seededRandom(seed)` the
 * fullgame harness uses; each recorded exe move is applied through the same
 * `hold()` / `placeMinoAt()` path, so the state at `turn` is byte-identical to
 * the snapshot the fullgame differential queried at that turn.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { kindToMino, MINO_NONE } from "../../../src/ai/hoiko/mino-codes.js";
import { createEngine } from "../../../src/core/engine.js";
import { ROWS } from "../../../src/core/types.js";
import { seededRandom } from "../../../src/versus/controller.js";

const args = Bun.argv.slice(2);
function argValue(flag: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  return hit === undefined ? undefined : hit.slice(flag.length + 1);
}

const jsonl = argValue("--jsonl") ?? "evidence/hoiko-fullgame/fixed-seed1-cap500.jsonl";
const turn = Number.parseInt(argValue("--turn") ?? "196", 10);
const seedArg = argValue("--seed");
const out = argValue("--out");
const evalInput = argValue("--eval-input");

interface ExeMove {
  readonly x: number;
  readonly y: number;
  readonly rot: number;
  readonly m: number;
  readonly srs: number;
  readonly postHold: number;
  readonly postCombo: number;
  readonly postBtb: number;
}

interface Record {
  readonly turn: number;
  readonly seed?: number;
  readonly exe: ExeMove;
}

const records: Record[] = readFileSync(jsonl, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Record);

const seed = seedArg !== undefined ? Number.parseInt(seedArg, 10) : (records[0]?.seed ?? 1);
const core = createEngine({ random: seededRandom(seed) });

function nativeRowsOf(snap: ReturnType<typeof core.getSnapshot>): number[] {
  const rows: number[] = [];
  for (let y = 0; y < snap.board.rows; y += 1) {
    const src = snap.board.grid[snap.board.rows - 1 - y];
    let bits = 0;
    for (let x = 0; x < 10; x += 1) {
      if ((src?.[x] ?? 0) !== 0) bits |= 1 << (9 - x);
    }
    rows.push(bits);
  }
  return rows;
}

let played = 0;
let snapshot: {
  readonly turn: number;
  readonly board: number[];
  readonly current: number;
  readonly next: number[];
  readonly hold: number;
  readonly combo: number;
  readonly btb: number;
  readonly canHold: boolean;
} | null = null;

for (const rec of records) {
  if (rec.turn !== played)
    throw new Error(`record order: expected turn ${played}, got ${rec.turn}`);
  const snap = core.getSnapshot();
  if (rec.turn === turn) {
    snapshot = {
      turn: rec.turn,
      board: nativeRowsOf(snap),
      current: snap.active === null ? MINO_NONE : kindToMino(snap.active.kind),
      next: snap.next.map(kindToMino),
      hold: snap.hold === null ? MINO_NONE : kindToMino(snap.hold),
      combo: snap.nativeCombo,
      btb: snap.nativeBtb,
      canHold: snap.canHold,
    };
    break;
  }
  const exe = rec.exe;
  const preHoldMino = snap.hold === null ? MINO_NONE : kindToMino(snap.hold);
  const currentMino = snap.active === null ? MINO_NONE : kindToMino(snap.active.kind);
  const holdUsed = exe.postHold !== preHoldMino || exe.m !== currentMino;
  if (holdUsed) core.hold();
  const rot = ((exe.rot % 4) + 4) % 4;
  const topRow = ROWS - 1 - exe.y;
  const placed = core.placeMinoAt?.(rot, exe.x, topRow, exe.srs) ?? false;
  if (!placed) throw new Error(`turn ${rec.turn}: placeMinoAt rejected`);
  played += 1;
}

if (snapshot === null) throw new Error(`turn ${turn} not reached (reached ${played})`);

const board = [...snapshot.board];
while (board.length < 32) board.push(0);

console.log(JSON.stringify(snapshot, null, 1));

if (out !== undefined) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(snapshot, null, 1)}\n`);
}

if (evalInput !== undefined) {
  // eval_dump `trace` input: board_len rows... current queue_len queue... hold
  // combo btb view_next allow_hold
  const window = snapshot.next.slice();
  while (window.length < 27) window.push(MINO_NONE);
  const line = [
    "trace_std",
    String(board.length),
    ...board.map(String),
    String(snapshot.current),
    String(window.length),
    ...window.map(String),
    String(snapshot.hold),
    String(snapshot.combo),
    String(snapshot.btb),
    "2",
    snapshot.canHold ? "1" : "0",
    "",
  ].join(" ");
  mkdirSync(dirname(evalInput), { recursive: true });
  writeFileSync(evalInput, line);
  console.log(`wrote ${evalInput}`);
}
