// ASCII versus renderer for manual behavior review ("brain rendering").
// Renders DeepSeek (left) vs the Hoiko replica (right).
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
const { resolveVersusConfig } = await import(`${BASE}/versus/config.js`);
const { createDeepSeekTetris } = await import(`${BASE}/ai/deepseek.js`);
const { createRustHoiko } = await import(`${BASE}/../tools/hoiko-rust/loader.js`);

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
  const ds = createDeepSeekTetris();
  const hoiko = createRustHoiko();
  const dsDebug = () => ds.getDebug();
  const hoikoDebug = () => hoiko.getDebug?.() ?? null;
  const ctrl = createVersusController(
    {
      name: "DEEPSEEK",
      color: "#38bdf8",
      findBestMove: (s) => ds.findBestMove(s),
      getDebug: () => dsDebug(),
    },
    {
      name: "HOIKO",
      color: hoiko.color,
      findBestMove: (s) => hoiko.findBestMove(s),
      getDebug: () => hoikoDebug(),
    },
    seed,
    resolveVersusConfig(),
  );
  let ticks = 0;
  let sinceDump = 0;
  let prevDs = 0;
  let prevHoiko = 0;
  let dsTetris = 0;
  let hoikoTetris = 0;
  let dsTspin = 0;
  let hoikoTspin = 0;
  let dsMaxH = 0;
  let hoikoMaxH = 0;
  let dsMaxPend = 0;
  let hoikoMaxPend = 0;

  while (ctrl.result === null && ticks < MAX_TICKS) {
    ctrl.tick(16, VERSUS_DEFAULTS);
    ticks += 1;
    sinceDump += 1;
    const dsSnap = ctrl.left.core.getSnapshot();
    const hoikoSnap = ctrl.right.core.getSnapshot();
    const dsDbg = dsDebug();
    const hoikoDbg = hoikoDebug();

    if (dsSnap.lines > prevDs) {
      const cleared = dsSnap.lines - prevDs;
      if (cleared === 4) dsTetris += 1;
      if (dsDbg?.isTspin === true) dsTspin += 1;
      console.log(
        `[t=${ticks}] DEEPSEEK clear +${cleared}${dsDbg?.isTspin === true ? " (tspin)" : ""} total=${dsSnap.lines}`,
      );
      prevDs = dsSnap.lines;
    }
    if (hoikoSnap.lines > prevHoiko) {
      const cleared = hoikoSnap.lines - prevHoiko;
      if (cleared === 4) hoikoTetris += 1;
      if (hoikoDbg?.isTspin === true) hoikoTspin += 1;
      console.log(
        `[t=${ticks}] HOIKO    clear +${cleared}${hoikoDbg?.isTspin === true ? " (tspin)" : ""} total=${hoikoSnap.lines}`,
      );
      prevHoiko = hoikoSnap.lines;
    }

    dsMaxH = Math.max(dsMaxH, Math.max(...heights(dsSnap.board.grid), 0));
    hoikoMaxH = Math.max(hoikoMaxH, Math.max(...heights(hoikoSnap.board.grid), 0));
    dsMaxPend = Math.max(dsMaxPend, dsSnap.pendingGarbage);
    hoikoMaxPend = Math.max(hoikoMaxPend, hoikoSnap.pendingGarbage);

    if (sinceDump >= INTERVAL) {
      sinceDump = 0;
      console.log(`[t=${ticks}] ${sideLabel("DEEPSEEK", dsSnap, ctrl.left.sentTotal, dsDbg)}`);
      console.log(
        `[t=${ticks}] ${sideLabel("HOIKO   ", hoikoSnap, ctrl.right.sentTotal, hoikoDbg)}`,
      );
      const rowsA = boardRows(dsSnap.board.grid);
      const rowsB = boardRows(hoikoSnap.board.grid);
      for (let y = 0; y < rowsA.length; y += 1) {
        console.log(`  ${rowsA[y]}   ${rowsB[y]}`);
      }
    }
  }

  const result = ctrl.result;
  console.log(
    `RESULT seed=${seed} winner=${result?.winner ?? "cap"} reason=${result?.reason ?? "max-ticks"} ticks=${ticks} pieces=${result?.pieces ?? ctrl.pieces}`,
  );
  const dsEnd = ctrl.left.core.getSnapshot();
  const hoikoEnd = ctrl.right.core.getSnapshot();
  console.log(
    `  DEEPSEEK tetris=${dsTetris} tspinClears=${dsTspin} maxH=${dsMaxH} maxPending=${dsMaxPend} lines=${dsEnd.lines} sent=${ctrl.left.sentTotal}`,
  );
  console.log(
    `  HOIKO    tetris=${hoikoTetris} tspinClears=${hoikoTspin} maxH=${hoikoMaxH} maxPending=${hoikoMaxPend} lines=${hoikoEnd.lines} sent=${ctrl.right.sentTotal}`,
  );
}
