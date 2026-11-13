/**
 * TBP (Tetris Bot Protocol) adapter for Attax.
 *
 * Speaks TBP on stdin/stdout so intetrigence's `external-arena` referee can host Attax.
 * State is tracked from TBP messages only (start / play / new_piece); every decision is
 * made by Attax's own fighter (`createBot().findBestMove`) on a GameSnapshot built from
 * that state. The adapter only translates coordinates:
 *
 *   TBP board: 40 rows, row 0 = bottom.  Attax board: 20 rows, row 0 = top.
 *   TBP placement: piece centre + orientation (Cold Clear convention) + spin label.
 *
 * Attax's chosen placement is converted by matching the four occupied cells against every
 * TBP orientation of the same piece. Because the referee accepts the first suggestion that
 * is in its own move list (which also fixes the spin label), the adapter lists Attax's
 * choice with Attax's spin label first, then the same cells with the other spin labels,
 * then Attax's ranked alternative first moves. Every decision is logged (ATTAX_TBP_LOG).
 *
 * Env: ATTAX_TBP_LOG (optional JSONL decision log path).
 */
import { appendFileSync } from "node:fs";

import { createBot } from "../src/ai/bot/fighter.ts";
import { cellsFor } from "../src/core/pieces.ts";
import type { GameSnapshot } from "../src/core/types.ts";

const LOG = process.env.ATTAX_TBP_LOG;

type Kind = "I" | "O" | "T" | "S" | "Z" | "J" | "L";
type Spin = "none" | "mini" | "full";
interface Loc {
  type: Kind;
  orientation: "north" | "east" | "south" | "west";
  x: number;
  y: number;
}
interface TbpMove {
  location: Loc;
  spin: Spin;
}

// ---- Cold Clear / TBP piece geometry (engine/src/data.rs), y up --------------------------
const CC_CELLS: Record<Kind, [number, number][]> = {
  I: [
    [-1, 0],
    [0, 0],
    [1, 0],
    [2, 0],
  ],
  O: [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ],
  T: [
    [-1, 0],
    [0, 0],
    [1, 0],
    [0, 1],
  ],
  L: [
    [-1, 0],
    [0, 0],
    [1, 0],
    [1, 1],
  ],
  J: [
    [-1, 0],
    [0, 0],
    [1, 0],
    [-1, 1],
  ],
  S: [
    [-1, 0],
    [0, 0],
    [0, 1],
    [1, 1],
  ],
  Z: [
    [-1, 1],
    [0, 1],
    [0, 0],
    [1, 0],
  ],
};
const ORIENTS = ["north", "east", "south", "west"] as const;
function rotateCell(o: (typeof ORIENTS)[number], [x, y]: [number, number]): [number, number] {
  switch (o) {
    case "north":
      return [x, y];
    case "east":
      return [y, -x];
    case "south":
      return [-x, -y];
    case "west":
      return [-y, x];
  }
}
const key = (cells: [number, number][]) =>
  cells
    .map(([x, y]) => `${x},${y}`)
    .sort()
    .join(";");

/** All TBP locations whose cells equal `cells` (absolute, TBP coords). */
function tbpLocations(kind: Kind, cells: [number, number][]): Loc[] {
  const target = key(cells);
  const anchor = [...cells].sort((a, b) => a[1] - b[1] || a[0] - b[0])[0];
  if (!anchor) return [];
  const out: Loc[] = [];
  for (const o of ORIENTS) {
    const offs = CC_CELLS[kind].map((c) => rotateCell(o, c));
    const a = [...offs].sort((p, q) => p[1] - q[1] || p[0] - q[0])[0];
    if (!a) continue;
    const cx = anchor[0] - a[0];
    const cy = anchor[1] - a[1];
    if (key(offs.map(([x, y]) => [x + cx, y + cy])) === target) {
      out.push({ type: kind, orientation: o, x: cx, y: cy });
    }
  }
  return out;
}

/** Attax placement (kind, rotation, x, top-row y) -> absolute TBP cells. */
function attaxCellsToTbp(kind: Kind, rotation: number, x: number, y: number): [number, number][] {
  return cellsFor(kind, rotation).map((c: { x: number; y: number }) => [x + c.x, 19 - (y + c.y)]);
}

// ---- tracked game state (TBP coordinates) ------------------------------------------------
let rows: boolean[][] = []; // rows[y][x], y = 0 bottom, 40 rows
let queue: Kind[] = [];
let hold: Kind | null = null;
let combo = 0; // TBP/intetrigence convention: consecutive clears, 0 = none
let b2b = false;

function setBoard(board: (string | null)[][]) {
  rows = Array.from({ length: 40 }, (_, y) =>
    Array.from({ length: 10 }, (_, x) => (board[y]?.[x] ?? null) !== null),
  );
}

function applyPlay(mv: TbpMove) {
  const kind = mv.location.type;
  const current = queue.shift();
  if (kind !== current) {
    const prevHold = hold;
    hold = current ?? null;
    if (prevHold === null) queue.shift();
  }
  const offs = CC_CELLS[kind].map((c) => rotateCell(mv.location.orientation, c));
  for (const [dx, dy] of offs) {
    const r = rows[mv.location.y + dy];
    if (r) r[mv.location.x + dx] = true;
  }
  const kept = rows.filter((r) => !r.every(Boolean));
  const lines = 40 - kept.length;
  while (kept.length < 40) kept.push(Array(10).fill(false));
  rows = kept;
  if (lines > 0) {
    combo += 1;
    b2b = lines === 4 || mv.spin !== "none";
  } else {
    combo = 0;
  }
}

// ---- decision --------------------------------------------------------------------------
const bot = createBot({ name: "attax" }); // default preview 5, beam width 48, default weights

function snapshot(): GameSnapshot {
  // Attax grid: 20 rows, index 0 = top.  Cells above TBP row 19 cannot be represented.
  const grid = Array.from({ length: 20 }, (_, r) => (rows[19 - r] ?? []).map((f) => (f ? 8 : 0)));
  const kind = queue[0];
  if (!kind) throw new Error("suggest requires a nonempty queue from start");
  const shape = cellsFor(kind, 0) as { x: number; y: number }[];
  const minY = Math.min(0, ...shape.map((c) => c.y));
  const posY = -minY;
  return {
    board: { cols: 10, rows: 20, grid },
    active: {
      kind,
      rotation: 0,
      posX: 3,
      posY,
      cells: shape.map((c) => ({ x: 3 + c.x, y: posY + c.y })),
    },
    ghostY: null,
    hold,
    canHold: true,
    next: queue.slice(1),
    score: 0,
    lines: 0,
    level: 1,
    gameOver: false,
    combo: combo - 1, // Attax: -1 = no chain, 0 = first clear
    b2b,
    nativeCombo: 0,
    nativeBtb: 0,
    lockId: 0,
    lastAction: "None",
    lastRawAttack: 0,
    pendingGarbage: 0, // TBP carries no incoming-garbage information
    lastAttack: 0,
    lastBlocked: 0,
  };
}

function movesFor(kind: Kind, rotation: number, x: number, y: number, spin: Spin): TbpMove[] {
  const locs = tbpLocations(kind, attaxCellsToTbp(kind, rotation, x, y));
  const spins: Spin[] = [spin, ...(["none", "mini", "full"] as Spin[]).filter((s) => s !== spin)];
  const out: TbpMove[] = [];
  for (const s of spins) for (const location of locs) out.push({ location, spin: s });
  return out;
}

function suggest() {
  const t0 = performance.now();
  const snap = snapshot();
  const aiMove = bot.findBestMove(snap);
  const result = bot.lastSearch();
  const ms = performance.now() - t0;
  const moves: TbpMove[] = [];
  let primary: unknown = null;
  if (aiMove !== null && result !== null) {
    const p = result.best.placement;
    primary = {
      kind: p.kind,
      rotation: p.rotation,
      x: p.x,
      y: p.y,
      tspin: p.tspin,
      hold: result.best.usedHold,
    };
    moves.push(...movesFor(p.kind, p.rotation, p.x, p.y, p.tspin));
    for (const c of result.candidates.slice(1)) {
      const q = c.placement;
      moves.push(...movesFor(q.kind, q.rotation, q.x, q.y, q.tspin));
    }
  }
  const above = rows.slice(20).some((r) => r.some(Boolean));
  if (LOG) {
    appendFileSync(
      LOG,
      `${JSON.stringify({ ms: +ms.toFixed(2), nodes: result?.nodes ?? 0, depth: result?.depth ?? 0, primary, first: moves[0] ?? null, cellsAboveRow20: above })}\n`,
    );
  }
  send({
    type: "suggestion",
    moves,
    move_info: { nodes: result?.nodes ?? 0, nps: 0, extra: `attax ${ms.toFixed(1)}ms` },
  });
}

function send(msg: unknown) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

send({
  type: "info",
  name: "Attax",
  version: "overhaul/full",
  author: "attax",
  features: [],
});

for await (const line of console) {
  const text = line.trim();
  if (text === "") continue;
  const msg = JSON.parse(text);
  switch (msg.type) {
    case "rules":
      send({ type: "ready" });
      break;
    case "start":
      setBoard(msg.board);
      queue = [...msg.queue];
      hold = msg.hold ?? null;
      combo = msg.combo ?? 0;
      b2b = !!msg.back_to_back;
      bot.reset();
      break;
    case "play":
      applyPlay(msg.move);
      break;
    case "new_piece":
      queue.push(msg.piece);
      break;
    case "suggest":
      suggest();
      break;
    case "stop":
      break;
    case "quit":
      process.exit(0);
  }
}
