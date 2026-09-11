/**
 * Oracle check, exe vs Rust: first move + GetDelay on the fixed positions.
 *
 *   bun ./diff.ts [--timer] [positionName ...]
 *
 * `--timer` calls SearchAI.IsSearching(true) in the oracle (depth 14); without it
 * the binary stops at minDepth (depth 10). The Rust engine runs to the matching
 * `depthLimit` (constant clock, no time cap).
 */

import { writeFileSync } from "fs";
import { POSITIONS, type Position } from "./positions.js";
import { createRustHoiko, type RustHoikoFighter } from "../../hoiko-rust/loader.js";
import type { GameSnapshot, PieceKind } from "../../../src/ui/types.js";

const ORACLE_INPUT = "/tmp/opencode/oracle/run/oracle_input.txt";
const ORACLE_SCRIPT = "/tmp/opencode/oracle/run_oracle.sh";

const KIND: Record<number, PieceKind> = { 0: "I", 1: "J", 2: "L", 3: "O", 4: "T", 5: "S", 6: "Z" };

const CLEAR_DELAY: Readonly<Record<number, number>> = {
  0: 0, 1: 36, 5: 36, 8: 36, 2: 41, 3: 41, 6: 41, 7: 41, 4: 46, 9: 1,
};
function getDelay(moveDelay: number, act: number): number {
  return (CLEAR_DELAY[act] ?? 0) * 16 + moveDelay;
}

function snapshotFrom(p: Position): GameSnapshot {
  const rows = 20;
  const grid: number[][] = Array.from({ length: rows }, () => Array.from({ length: 10 }, () => 0));
  for (let y = 0; y < p.board.length && y < rows; y += 1) {
    const native = p.board[y] ?? 0;
    for (let c = 0; c < 10; c += 1) {
      if ((native & (1 << (9 - c))) !== 0) grid[rows - 1 - y]![c] = 1;
    }
  }
  const next = p.next.slice(1, 13).map((v) => KIND[v] ?? "I");
  return {
    board: { cols: 10, rows, grid },
    active: { kind: KIND[p.next[0] ?? 0] ?? "I", rotation: 0, cells: [], posX: 3, posY: 0 },
    ghostY: null,
    hold: null,
    canHold: true,
    next,
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

interface OracleResult {
  readonly ok: boolean;
  readonly x: number;
  readonly y: number;
  readonly rot: number;
  readonly m: number;
  readonly depth: number;
  readonly getDelay: number | null;
  readonly raw: string;
}

function runOracle(p: Position, startTimer: boolean): OracleResult {
  const boardHex = p.board.map((v) => "0x" + (v >>> 0).toString(16)).join(",");
  const timerLine = startTimer ? "timer=1\n" : "";
  writeFileSync(ORACLE_INPUT, `# ${p.name}\nboard=${boardHex}\nnext=${p.next.join(",")}\n${timerLine}`);
  const proc = Bun.spawnSync(["bash", ORACLE_SCRIPT], { stdout: "pipe", stderr: "pipe", timeout: 180000 });
  const text = proc.stdout.toString() + "\n" + proc.stderr.toString();
  const fm = text.match(/firstMove @\+?456:\s*x=(-?\d+)\s+y=(-?\d+)\s+rot=(-?\d+)\s+m=(-?\d+)/);
  const depth = text.match(/depth\s+@\+?444\s*=\s*(-?\d+)/);
  const delay = text.match(/GetDelay\s*=\s*(-?\d+)/);
  if (!fm) return { ok: false, x: 0, y: 0, rot: 0, m: 0, depth: 0, getDelay: null, raw: text };
  return {
    ok: true,
    x: +fm[1], y: +fm[2], rot: +fm[3], m: +fm[4],
    depth: depth ? +depth[1] : -1,
    getDelay: delay ? +delay[1] : null,
    raw: text,
  };
}

function runRust(fighter: RustHoikoFighter, p: Position, depth: number) {
  // depthLimit is fixed at construction; rebuild per depth for the two modes.
  void depth;
  const res = fighter.searchSnapshot(snapshotFrom(p));
  if (res === null) return null;
  const o = res.out;
  return {
    x: o.x,
    rot: ((o.firstRRaw % 4) + 4) % 4,
    m: o.firstM,
    depth: o.depth,
    getDelay: getDelay(o.moveDelay, o.firstAct),
    moveDelay: o.moveDelay,
    firstAct: o.firstAct,
  };
}

const args = process.argv.slice(2);
const startTimer = args.includes("--timer");
const only = args.filter((a) => !a.startsWith("--"));
const list = only.length > 0 ? POSITIONS.filter((p) => only.includes(p.name)) : POSITIONS;
const depth = startTimer ? 14 : 10;

let mismatches = 0;
for (const p of list) {
  const fighter = createRustHoiko({ weightPreset: "we", depthLimit: depth, offset: false });
  const o = runOracle(p, startTimer);
  const t = runRust(fighter, p, depth);
  const moveMatch = o.ok && t !== null && o.x === t.x && o.rot === t.rot && o.m === t.m;
  const delayMatch = o.getDelay !== null && t !== null && o.getDelay === t.getDelay;
  if (!moveMatch) mismatches += 1;
  console.log(
    `${moveMatch ? "MATCH  " : "MISMATCH"} ${p.name.padEnd(14)} | oracle x=${o.x} y=${o.y} rot=${o.rot} m=${o.m} depth=${o.depth} delay=${o.getDelay} | rust x=${t?.x} rot=${t?.rot} m=${t?.m} depth=${t?.depth} delay=${t?.getDelay} ${delayMatch ? "DELAY-OK" : "DELAY-NO"}`,
  );
}
console.log(`\n${list.length - mismatches}/${list.length} first-move match (${startTimer ? "depth 14" : "depth 10"})`);
process.exit(mismatches === 0 ? 0 : 1);
