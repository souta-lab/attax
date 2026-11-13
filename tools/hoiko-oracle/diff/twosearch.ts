/**
 * Two-search oracle check: exe vs Rust beam adaptation.
 *
 * After search 1 the binary's SetNextOption sets the global beamSizeLimit from
 * RootNode.GetDelay(root1), and the second search reports it at @452. The Rust
 * engine exposes the same inputs (the chosen line's moveDelay + act), so the
 * documented formula is applied and compared.
 *
 *   bun ./twosearch.ts [positionName ...]
 */

import { writeFileSync } from "node:fs";
import type { GameSnapshot, PieceKind } from "../../../src/core/types.js";
import { createHoiko } from "../../hoiko-node.js";
import { POSITIONS, type Position } from "./positions.js";

const ORACLE_INPUT = "/tmp/opencode/oracle/run/oracle_input.txt";
const ORACLE_SCRIPT = "/tmp/opencode/oracle/run_oracle.sh";
const KIND: Record<number, PieceKind> = { 0: "I", 1: "J", 2: "L", 3: "O", 4: "T", 5: "S", 6: "Z" };

const CLEAR_DELAY: Readonly<Record<number, number>> = {
  0: 0,
  1: 36,
  5: 36,
  8: 36,
  2: 41,
  3: 41,
  6: 41,
  7: 41,
  4: 46,
  9: 1,
};
const TAKE_OVER_TIME = 5;
const MAX_BEAM_SIZE = 50;

function getDelay(moveDelay: number, act: number): number {
  return (CLEAR_DELAY[act] ?? 0) * 16 + moveDelay;
}

function snapshotFrom(p: Position): GameSnapshot {
  const rows = 20;
  const grid: number[][] = Array.from({ length: rows }, () => Array.from({ length: 10 }, () => 0));
  for (let y = 0; y < p.board.length && y < rows; y += 1) {
    const native = p.board[y] ?? 0;
    const row = grid[rows - 1 - y];
    if (row === undefined) continue;
    for (let c = 0; c < 10; c += 1) if ((native & (1 << (9 - c))) !== 0) row[c] = 1;
  }
  return {
    board: { cols: 10, rows, grid },
    active: { kind: KIND[p.next[0] ?? 0] ?? "I", rotation: 0, cells: [], posX: 3, posY: 0 },
    ghostY: null,
    hold: null,
    canHold: true,
    next: p.next.slice(1, 13).map((v) => KIND[v] ?? "I"),
    score: 0,
    lines: 0,
    level: 1,
    gameOver: false,
    combo: 0,
    b2b: false,
    nativeCombo: 0,
    nativeBtb: 0,
    lockId: 0,
    lastAction: "None",
    lastRawAttack: 0,
    pendingGarbage: 0,
    lastAttack: 0,
    lastBlocked: 0,
  };
}

function runOracleTwo(p: Position): { getDelay1: number; beam2: number } {
  const boardHex = p.board.map((v) => `0x${(v >>> 0).toString(16)}`).join(",");
  writeFileSync(
    ORACLE_INPUT,
    `# ${p.name}\nboard=${boardHex}\nnext=${p.next.join(",")}\ntwosearch=1\n`,
  );
  const proc = Bun.spawnSync(["bash", ORACLE_SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 180000,
  });
  const raw = `${proc.stdout.toString()}\n${proc.stderr.toString()}`;
  const md = raw.match(/GetDelay\s*=\s*(-?\d+)/);
  const b2 = raw.match(/search2 beamLimit @452\s*=\s*(-?\d+)/);
  return { getDelay1: md ? +md[1] : -1, beam2: b2 ? +b2[1] : -1 };
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const list = only.length > 0 ? POSITIONS.filter((p) => only.includes(p.name)) : POSITIONS;

let mismatches = 0;
for (const p of list) {
  const fighter = createHoiko({
    weightPreset: "we",
    depthLimit: 10,
    offset: false,
    adapt: false,
  });
  const res = fighter.searchSnapshot(snapshotFrom(p));
  const o = runOracleTwo(p);
  const ru = res?.out;
  const rustGetDelay = ru === undefined ? -1 : getDelay(ru.moveDelay, ru.firstAct);
  const timerLimit = rustGetDelay - TAKE_OVER_TIME;
  const beam = Math.min(Math.trunc((MAX_BEAM_SIZE * timerLimit) / 112), MAX_BEAM_SIZE * 3);
  const match = o.beam2 === beam;
  if (!match) mismatches += 1;
  console.log(
    `${match ? "MATCH  " : "MISMATCH"} ${p.name.padEnd(14)} | oracle GetDelay1=${o.getDelay1} beam2=${o.beam2} | rust getDelay=${rustGetDelay} predictedBeam=${beam}`,
  );
}
console.log(`\n${list.length - mismatches}/${list.length} beam-adaptation match`);
process.exit(mismatches === 0 ? 0 : 1);
