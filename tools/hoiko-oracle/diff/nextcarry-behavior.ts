/**
 * Next-queue carry behavior differential.
 *
 * The stub `shiftnext=N` replays the real game's per-turn
 * `RootNode.SetPPTData` mutation (ShiftNext + Compare(0, live)) N times on the
 * exe root. The adapter carries the same `NextMino` across `searchSnapshot`
 * calls (one shift per search after the first), so think N+1 must match the exe
 * run with `shiftnext=N`. Verifies the adapter's carry cadence and that the
 * Rust engine consumes the carried state identically.
 *
 *   bun nextcarry-behavior.ts
 *
 * Evidence: evidence/hoiko-inputs/nextcarry/behavior.json.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { opponentIsPCBoard, opponentIsPowerfulBoard } from "../../../src/ai/hoiko-opponent.js";
import type { BoardView, GameSnapshot, PieceKind } from "../../../src/ui/types.js";
import { createRustHoiko, type RustHoikoFighter } from "../../hoiko-rust/loader.js";
import { runExe } from "./exe.js";

const EVIDENCE = new URL("../../../evidence/hoiko-inputs/nextcarry/", import.meta.url);
mkdirSync(EVIDENCE, { recursive: true });

const BAG = [6, 5, 4, 3, 1, 2, 0];
const KIND: Record<number, PieceKind> = { 0: "I", 1: "J", 2: "L", 3: "O", 4: "T", 5: "S", 6: "Z" };
const SHIFTS = [0, 1, 2, 3, 6];

interface Position {
  readonly name: string;
  readonly board: readonly number[];
  readonly queue: readonly number[];
  readonly opponent: readonly number[];
  readonly opponentCombo: number;
  readonly useS4W: boolean;
}

function queue(seed: number): number[] {
  return Array.from({ length: 27 }, (_, i) => BAG[(i + seed) % 7] ?? 0);
}

const POSITIONS: Position[] = [
  { name: "empty", board: [], queue: queue(0), opponent: [], opponentCombo: 0, useS4W: false },
  {
    name: "flat",
    board: [0x3ff],
    queue: queue(1),
    opponent: [0x3ff, 0x3ff],
    opponentCombo: 0,
    useS4W: false,
  },
  {
    name: "stack",
    board: [0x3ff, 0x3ff, 0x001, 0x001, 0x001],
    queue: queue(2),
    opponent: [0x001, 0x001, 0x001],
    opponentCombo: 9,
    useS4W: false,
  },
  {
    name: "s4w",
    board: [0x3ff, 0x3ff, 0x3ff],
    queue: queue(3),
    opponent: [0x1ff, 0x3f, 0x3f, 0x3f, 0x3f, 0x3f],
    opponentCombo: 4,
    useS4W: true,
  },
];

function gridFrom(rows: readonly number[], height: number): BoardView {
  const grid: number[][] = Array.from({ length: height }, () =>
    Array.from({ length: 10 }, () => 0),
  );
  for (let y = 0; y < rows.length && y < height; y += 1) {
    const native = rows[y] ?? 0;
    const row = grid[height - 1 - y];
    if (row === undefined) continue;
    for (let c = 0; c < 10; c += 1) if ((native & (1 << (9 - c))) !== 0) row[c] = 1;
  }
  return { cols: 10, rows: height, grid };
}

function snapshotFrom(p: Position): GameSnapshot {
  const rows = 24;
  return {
    board: gridFrom(p.board, rows),
    active: { kind: KIND[p.queue[0] ?? 0] ?? "I", rotation: 0, cells: [], posX: 3, posY: 0 },
    ghostY: null,
    hold: null,
    canHold: false,
    next: p.queue.slice(1, 13).map((v) => KIND[v] ?? "I"),
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
    opponentCombo: p.opponentCombo,
    opponentBtb: 0,
    opponentLockId: 0,
    opponentBoard: gridFrom(p.opponent, rows),
  };
}

function exeInput(p: Position, shift: number): string {
  const board = [...p.board];
  while (board.length < 32) board.push(0);
  const next = [...p.queue];
  const pc = opponentIsPCBoard(p.opponent);
  const powerful = p.useS4W ? opponentIsPowerfulBoard(p.opponent, p.opponentCombo, 0) : false;
  return [
    `# nextcarry-behavior ${p.name} shift=${shift}`,
    `board=${board.map((v) => `0x${(v >>> 0).toString(16)}`).join(",")}`,
    `next=${next.join(",")}`,
    "depthlimit=10",
    "usehold=0",
    "evenodd=1",
    "multieval=1",
    `oppcombo=${p.opponentCombo}`,
    `opppc=${pc ? 1 : 0}`,
    `opppowerful=${powerful ? 1 : 0}`,
    ...(p.useS4W ? ["uses4w=1"] : []),
    `shiftnext=${shift}`,
    "nextdump=2",
    "",
  ].join("\n");
}

interface Decision {
  readonly x: number;
  readonly rot: number;
  readonly m: number;
  readonly state: string;
}

function parseDecision(text: string): Decision | null {
  const fm = text.match(/firstMove @\+?456:\s*x=(-?\d+)\s+y=(-?\d+)\s+rot=(-?\d+)\s+m=(-?\d+)/);
  const nd = text.match(/NEXTDUMP shift=\d+ m=([-\d,]+) trustEnd=(-?\d+) remains=(-?\d+)/);
  if (fm === null || nd === null) return null;
  return {
    x: Number(fm[1]),
    rot: Number(fm[3]),
    m: Number(fm[4]),
    state: `m=${nd[1]};trust=${nd[2]};rem=${nd[3]}`,
  };
}

function replicaAfter(fighter: RustHoikoFighter, p: Position, searches: number): Decision {
  const snap = snapshotFrom(p);
  let out: Decision | null = null;
  for (let i = 0; i < searches; i += 1) {
    const res = fighter.searchSnapshot(snap);
    if (res === null) throw new Error(`replica null for ${p.name}`);
    out = {
      x: res.out.x,
      rot: ((res.out.firstRRaw % 4) + 4) % 4,
      m: res.out.firstM,
      state: "n/a",
    };
  }
  if (out === null) throw new Error(`no replica decision for ${p.name}`);
  return out;
}

let pass = 0;
let total = 0;
const rows: Record<string, unknown>[] = [];
for (const p of POSITIONS) {
  for (const shift of SHIFTS) {
    const run = runExe(exeInput(p, shift));
    const exe = run.ok ? parseDecision(run.text) : null;
    const fighter = createRustHoiko({
      versus: true,
      nextCarry: true,
      evenMode: "auto",
      adapt: false,
      depthLimit: 10,
      useS4W: p.useS4W,
    });
    const rep = replicaAfter(fighter, p, shift + 1);
    const ok = exe !== null && exe.x === rep.x && exe.rot === rep.rot && exe.m === rep.m;
    total += 1;
    if (ok) pass += 1;
    rows.push({ position: p.name, shift, exe, replica: rep, ok });
    console.log(
      `${ok ? "OK  " : "FAIL"} ${p.name.padEnd(8)} shift=${shift} exe(x${exe?.x} r${exe?.rot} m${exe?.m}) rep(x${rep.x} r${rep.rot} m${rep.m})`,
    );
  }
}

writeFileSync(
  new URL("behavior.json", EVIDENCE),
  `${JSON.stringify({ total, pass, rows }, null, 2)}\n`,
);
console.log(`\n${pass}/${total} next-carry behavior cases match`);
process.exit(pass === total ? 0 : 1);
