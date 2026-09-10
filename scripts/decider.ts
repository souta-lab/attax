import { createVersusController, VERSUS_DEFAULTS } from "../src/versus/controller.js";
import { createFighterA } from "../src/ai/fighterA.js";
import { createFighterB } from "../src/ai/fighterB.js";

interface DetailRow {
  readonly seed: number;
  readonly winner: string;
  readonly reason: string;
  readonly ticks: number;
  readonly pieces: number;
  readonly lines: string;
  readonly sent: string;
  readonly tspinA: number;
  readonly tspinB: number;
  readonly tetrisA: number;
  readonly tetrisB: number;
  readonly maxPendingA: number;
  readonly maxPendingB: number;
  readonly maxHeightA: number;
  readonly maxHeightB: number;
  readonly firstBlood: string;
  readonly leadChanges: number;
}

const seeds = [1, 7, 42, 99, 777, 1234, 5555, 9001];
const rows: DetailRow[] = [];
let winsA = 0;
let winsB = 0;

for (const seed of seeds) {
  const a = createFighterA();
  const b = createFighterB();
  const ctrl = createVersusController(
    {
      name: "BLUE",
      color: "#38bdf8",
      findBestMove: (s) => a.findBestMove(s),
      getDebug: () => a.getDebug(),
    },
    {
      name: "RED",
      color: "#f87171",
      findBestMove: (s) => b.findBestMove(s),
      getDebug: () => b.getDebug(),
    },
    seed,
  );
  let ticks = 0;
  let tspinA = 0;
  let tspinB = 0;
  let tetrisA = 0;
  let tetrisB = 0;
  let maxPendingA = 0;
  let maxPendingB = 0;
  let maxHeightA = 0;
  let maxHeightB = 0;
  let firstBlood = "-";
  let leadChanges = 0;
  let lastLeader = "-";
  let prevLinesA = 0;
  let prevLinesB = 0;
  let lastTspinA = false;
  let lastTetrisA = false;
  let lastTspinB = false;
  let lastTetrisB = false;
  while (ctrl.result === null && ticks < 120000) {
    ctrl.tick(16, VERSUS_DEFAULTS);
    ticks++;
    const snapA = ctrl.left.core.getSnapshot();
    const snapB = ctrl.right.core.getSnapshot();
    if (snapA.pendingGarbage > maxPendingA) maxPendingA = snapA.pendingGarbage;
    if (snapB.pendingGarbage > maxPendingB) maxPendingB = snapB.pendingGarbage;
    const hA = stackHeight(snapA.board.grid);
    const hB = stackHeight(snapB.board.grid);
    if (hA > maxHeightA) maxHeightA = hA;
    if (hB > maxHeightB) maxHeightB = hB;
    const dA = a.getDebug();
    const dB = b.getDebug();
    if (dA?.isTspin === true && !lastTspinA) tspinA++;
    if (dB?.isTspin === true && !lastTspinB) tspinB++;
    lastTspinA = dA?.isTspin === true;
    lastTspinB = dB?.isTspin === true;
    if (snapA.lines > prevLinesA && (dA?.linesCleared ?? 0) === 4 && !lastTetrisA) tetrisA++;
    if (snapB.lines > prevLinesB && (dB?.linesCleared ?? 0) === 4 && !lastTetrisB) tetrisB++;
    lastTetrisA = (dA?.linesCleared ?? 0) === 4;
    lastTetrisB = (dB?.linesCleared ?? 0) === 4;
    prevLinesA = snapA.lines;
    prevLinesB = snapB.lines;
    if (firstBlood === "-" && (ctrl.left.sentTotal > 0 || ctrl.right.sentTotal > 0)) {
      firstBlood = ctrl.left.sentTotal > 0 ? "BLUE" : "RED";
    }
    const leader = snapA.lines === snapB.lines ? "=" : snapA.lines > snapB.lines ? "A" : "B";
    if (lastLeader !== "-" && leader !== "=" && lastLeader !== "=" && leader !== lastLeader) {
      leadChanges++;
    }
    if (leader !== "=") lastLeader = leader;
  }
  const r = ctrl.result;
  const winner = r?.winner === "left" ? "BLUE" : r?.winner === "right" ? "RED" : "DRAW";
  if (winner === "BLUE") winsA++;
  else if (winner === "RED") winsB++;
  rows.push({
    seed,
    winner,
    reason: r?.reason ?? "?",
    ticks,
    pieces: r?.pieces ?? 0,
    lines: `${r?.linesLeft}-${r?.linesRight}`,
    sent: `${r?.sentLeft}-${r?.sentRight}`,
    tspinA,
    tspinB,
    tetrisA,
    tetrisB,
    maxPendingA,
    maxPendingB,
    maxHeightA,
    maxHeightB,
    firstBlood,
    leadChanges,
  });
}

console.log("seed | winner reason | ticks pieces | lines | sent | TSD A-B | TETRIS A-B | pendMax | hMax | 1st | leadΔ");
for (const r of rows) {
  console.log(
    `${r.seed} | ${r.winner} ${r.reason} | ${r.ticks}/${r.pieces} | ${r.lines} | ${r.sent} | ${r.tspinA}-${r.tspinB} | ${r.tetrisA}-${r.tetrisB} | ${r.maxPendingA}-${r.maxPendingB} | ${r.maxHeightA}-${r.maxHeightB} | ${r.firstBlood} | ${r.leadChanges}`,
  );
}
console.log(`FINAL Blue:${winsA} Red:${winsB}`);

function stackHeight(grid: readonly (readonly number[])[]): number {
  for (let y = 0; y < grid.length; y++) {
    if (grid[y]?.some((v) => v !== 0) === true) return grid.length - y;
  }
  return 0;
}
