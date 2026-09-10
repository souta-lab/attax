// ASCII versus renderer for manual behavior review ("brain rendering").
// Usage: bun scripts/render.ts [seed...]
// Env: RENDER_BASE (source tree to import fighters from; default: live src)
//      RENDER_INTERVAL (ticks between board dumps; default 500)
//      RENDER_MAX_TICKS (default 12000)
import { resolve } from "node:path";

const BASE = process.env.RENDER_BASE ?? resolve(import.meta.dir, "../src");
const INTERVAL = Number(process.env.RENDER_INTERVAL ?? 500);
const MAX_TICKS = Number(process.env.RENDER_MAX_TICKS ?? 12000);
const seeds = process.argv
  .slice(2)
  .map((value) => Number(value))
  .filter((value) => Number.isFinite(value));
if (seeds.length === 0) seeds.push(1, 7);

const { createVersusController, VERSUS_DEFAULTS } = await import(`${BASE}/versus/controller.js`);
const { createFighterA } = await import(`${BASE}/ai/fighterA.js`);
const { createFighterB } = await import(`${BASE}/ai/fighterB.js`);

type Grid = readonly (readonly number[])[];

function heights(grid: Grid): number[] {
  const out: number[] = [];
  for (let x = 0; x < 10; x += 1) {
    let top = 0;
    for (let y = 0; y < grid.length; y += 1) {
      if ((grid[y]?.[x] ?? 0) !== 0) {
        top = grid.length - y;
        break;
      }
    }
    out.push(top);
  }
  return out;
}

function countHoles(grid: Grid): number {
  let holes = 0;
  for (let x = 0; x < 10; x += 1) {
    let blockSeen = false;
    for (let y = 0; y < grid.length; y += 1) {
      const filled = (grid[y]?.[x] ?? 0) !== 0;
      if (filled) blockSeen = true;
      else if (blockSeen) holes += 1;
    }
  }
  return holes;
}

function wellOf(h: readonly number[]): { readonly col: number; readonly level: number } {
  let col = 0;
  let best = h[0] ?? 0;
  for (let x = 1; x < 10; x += 1) {
    const v = h[x] ?? 0;
    if (v < best || (v === best && (x === 0 || x === 9))) {
      best = v;
      col = x;
    }
  }
  return { col, level: best };
}

function boardRows(grid: Grid): string[] {
  return grid.map((row) => {
    let line = "";
    for (let x = 0; x < 10; x += 1) line += (row[x] ?? 0) === 0 ? "." : "#";
    return line;
  });
}

interface SideSnap {
  readonly lines: number;
  readonly pendingGarbage: number;
  readonly board: { readonly grid: Grid };
}

interface SideDebug {
  readonly linesCleared: number;
  readonly isTspin: boolean;
}

function sideLabel(label: string, snap: SideSnap, sent: number, debug: SideDebug | null): string {
  const h = heights(snap.board.grid);
  const maxH = Math.max(...h, 0);
  const well = wellOf(h);
  const last =
    debug === null ? "" : ` last(clear=${debug.linesCleared},tspin=${debug.isTspin ? "T" : "-"})`;
  return `${label} L=${snap.lines} sent=${sent} H=${maxH} holes=${countHoles(snap.board.grid)} pend=${snap.pendingGarbage} well=${well.col}:${well.level}${last}`;
}

for (const seed of seeds) {
  console.log(`\n===== SEED ${seed} =====`);
  const blue = createFighterA();
  const red = createFighterB();
  const ctrl = createVersusController(
    {
      name: "BLUE",
      color: "#38bdf8",
      findBestMove: (s) => blue.findBestMove(s),
      getDebug: () => blue.getDebug(),
    },
    {
      name: "RED",
      color: "#f87171",
      findBestMove: (s) => red.findBestMove(s),
      getDebug: () => red.getDebug(),
    },
    seed,
  );
  let ticks = 0;
  let sinceDump = 0;
  let prevBlue = 0;
  let prevRed = 0;
  let blueTetris = 0;
  let redTetris = 0;
  let blueTspin = 0;
  let redTspin = 0;
  let blueMaxH = 0;
  let redMaxH = 0;
  let blueMaxPend = 0;
  let redMaxPend = 0;

  while (ctrl.result === null && ticks < MAX_TICKS) {
    ctrl.tick(16, VERSUS_DEFAULTS);
    ticks += 1;
    sinceDump += 1;
    const blueSnap = ctrl.left.core.getSnapshot();
    const redSnap = ctrl.right.core.getSnapshot();
    const blueDbg = blue.getDebug();
    const redDbg = red.getDebug();

    if (blueSnap.lines > prevBlue) {
      const cleared = blueSnap.lines - prevBlue;
      if (cleared === 4) blueTetris += 1;
      if (blueDbg?.isTspin === true) blueTspin += 1;
      console.log(
        `[t=${ticks}] BLUE clear +${cleared}${blueDbg?.isTspin === true ? " (tspin)" : ""} total=${blueSnap.lines}`,
      );
      prevBlue = blueSnap.lines;
    }
    if (redSnap.lines > prevRed) {
      const cleared = redSnap.lines - prevRed;
      if (cleared === 4) redTetris += 1;
      if (redDbg?.isTspin === true) redTspin += 1;
      console.log(
        `[t=${ticks}] RED  clear +${cleared}${redDbg?.isTspin === true ? " (tspin)" : ""} total=${redSnap.lines}`,
      );
      prevRed = redSnap.lines;
    }

    blueMaxH = Math.max(blueMaxH, Math.max(...heights(blueSnap.board.grid), 0));
    redMaxH = Math.max(redMaxH, Math.max(...heights(redSnap.board.grid), 0));
    blueMaxPend = Math.max(blueMaxPend, blueSnap.pendingGarbage);
    redMaxPend = Math.max(redMaxPend, redSnap.pendingGarbage);

    if (sinceDump >= INTERVAL) {
      sinceDump = 0;
      console.log(`[t=${ticks}] ${sideLabel("BLUE", blueSnap, ctrl.left.sentTotal, blueDbg)}`);
      console.log(`[t=${ticks}] ${sideLabel("RED ", redSnap, ctrl.right.sentTotal, redDbg)}`);
      const rowsA = boardRows(blueSnap.board.grid);
      const rowsB = boardRows(redSnap.board.grid);
      for (let y = 0; y < rowsA.length; y += 1) {
        console.log(`  ${rowsA[y]}   ${rowsB[y]}`);
      }
    }
  }

  const result = ctrl.result;
  console.log(
    `RESULT seed=${seed} winner=${result?.winner ?? "cap"} reason=${result?.reason ?? "max-ticks"} ticks=${ticks} pieces=${result?.pieces ?? ctrl.pieces}`,
  );
  const blueEnd = ctrl.left.core.getSnapshot();
  const redEnd = ctrl.right.core.getSnapshot();
  console.log(
    `  BLUE tetris=${blueTetris} tspinClears=${blueTspin} maxH=${blueMaxH} maxPending=${blueMaxPend} lines=${blueEnd.lines} sent=${ctrl.left.sentTotal}`,
  );
  console.log(
    `  RED  tetris=${redTetris} tspinClears=${redTspin} maxH=${redMaxH} maxPending=${redMaxPend} lines=${redEnd.lines} sent=${ctrl.right.sentTotal}`,
  );
}
