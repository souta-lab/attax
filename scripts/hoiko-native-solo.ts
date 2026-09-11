// Native Hoiko solo benchmark: survives on its own (no attacker).
import { createHoikoNative } from "/home/s0u7a/browser-tetris/src/ai/hoiko-native.js";
import { createEngine } from "/home/s0u7a/browser-tetris/src/core/engine.js";
import type { BoardView } from "/home/s0u7a/browser-tetris/src/ui/types.js";

function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function stats(board: BoardView): { holes: number; maxHeight: number } {
  let holes = 0;
  let maxHeight = 0;
  for (let x = 0; x < board.cols; x += 1) {
    let seen = false;
    for (let y = 0; y < board.rows; y += 1) {
      const filled = (board.grid[y]?.[x] ?? 0) !== 0;
      if (filled) {
        seen = true;
        maxHeight = Math.max(maxHeight, board.rows - y);
      } else if (seen) {
        holes += 1;
      }
    }
  }
  return { holes, maxHeight };
}

const seeds = [1, 7, 42];
const cap = Number(process.argv[2] ?? 1000);
for (const seed of seeds) {
  const ai = createHoikoNative({ weightPreset: "we" });
  const core = createEngine({ random: lcg(seed) });
  const port = core as unknown as { hardDropAt(r: number, x: number): boolean };
  let n = 0;
  for (let i = 0; i < cap; i += 1) {
    const snap = core.getSnapshot();
    if (snap.gameOver || snap.active === null) break;
    const mv = ai.findBestMove(snap);
    if (mv === null) {
      core.hardDrop();
      n += 1;
      continue;
    }
    if (mv.useHold) core.hold();
    if (!port.hardDropAt(mv.targetRotation, mv.targetX)) {
      const cur = core.getSnapshot().active;
      if (cur === null) {
        core.hardDrop();
      } else {
        const target = ((mv.targetRotation % 4) + 4) % 4;
        const cw = (target - cur.rotation + 4) % 4;
        const ccw = (cur.rotation - target + 4) % 4;
        if (cw <= ccw) for (let k = 0; k < cw; k += 1) core.rotateCW();
        else for (let k = 0; k < ccw; k += 1) core.rotateCCW();
        const dx = mv.targetX - cur.posX;
        if (dx < 0) for (let k = 0; k < -dx; k += 1) core.moveLeft();
        else for (let k = 0; k < dx; k += 1) core.moveRight();
        core.hardDrop();
      }
    }
    n += 1;
  }
  const end = core.getSnapshot();
  const { holes, maxHeight } = stats(end.board);
  console.log(
    `seed=${seed} pieces=${n} lines=${end.lines} dead=${end.gameOver} holes=${holes} maxHeight=${maxHeight}`,
  );
}
