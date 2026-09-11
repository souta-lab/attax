// Hoiko solo benchmark: does the replica survive on its own (no attacker)?

import { createEngine } from "/home/s0u7a/browser-tetris/src/core/engine.js";
import { createRustHoiko } from "/home/s0u7a/browser-tetris/tools/hoiko-rust/loader.js";

function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}
const seeds = [1, 7, 42];
for (const seed of seeds) {
  const ai = createRustHoiko({ weightPreset: "we", beamSizeLimit: 500 });
  const core = createEngine({ random: lcg(seed) });
  const port = core as unknown as { hardDropAt(r: number, x: number): boolean };
  let n = 0;
  let lines = 0;
  for (let i = 0; i < 500; i += 1) {
    const snap = core.getSnapshot();
    if (snap.gameOver || snap.active === null) break;
    const mv = ai.findBestMove(snap);
    if (mv === null) {
      core.hardDrop();
      n += 1;
      continue;
    }
    if (mv.useHold) core.hold();
    if (!port.hardDropAt(mv.targetRotation, mv.targetX)) core.hardDrop();
    n += 1;
  }
  const end = core.getSnapshot();
  lines = end.lines;
  console.log(
    `seed=${seed} pieces=${n} lines=${lines} dead=${end.gameOver} maxHeight=${Math.max(...Array.from(new Uint16Array(20)).map(() => 0), ...[]) || "n/a"}`,
  );
}
