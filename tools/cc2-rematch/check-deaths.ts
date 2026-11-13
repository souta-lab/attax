/** Compare field/spawn models on already-burned historical terminal positions. */
import { readdirSync, readFileSync } from "node:fs";
import { boardFeatures } from "../../src/ai/bot/features.js";
import { generatePlacements, lockPlacement } from "../../src/ai/bot/movegen.js";
import type { PieceKind } from "../../src/core/pieces.js";

const directory = "/home/hatch/workspace/attax-gauntlet/runs";
const counts = {
  terminalNulls: 0,
  oldHasPlacement: 0,
  oldBelowCeiling: 0,
  externalHasPlacement: 0,
};
for (const name of readdirSync(directory)) {
  if (!/^cc2-70\d+\.jsonl$/.test(name)) continue;
  for (const line of readFileSync(`${directory}/${name}`, "utf8").trim().split("\n")) {
    const move = JSON.parse(line);
    if (move.type !== "move" || move.agent !== "attax" || move.move !== null) continue;
    counts.terminalNulls += 1;
    for (const height of [20, 40]) {
      const board = new Uint16Array(height);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < 10; x += 1) {
          if ((BigInt(move.board[x]) & (1n << BigInt(y))) !== 0n) {
            board[height - 1 - y] = (board[height - 1 - y] ?? 0) | (1 << x);
          }
        }
      }
      const kinds: PieceKind[] = [move.active, move.hold_before ?? move.next_before[0]];
      const placements = kinds.flatMap((kind) =>
        generatePlacements(board, kind, height === 20 ? { rotation: 0, x: 3, y: 0 } : undefined),
      );
      if (height === 40 && placements.length > 0) counts.externalHasPlacement += 1;
      if (height === 20 && placements.length > 0) counts.oldHasPlacement += 1;
      if (
        height === 20 &&
        placements.some((p) => boardFeatures(lockPlacement(board, p).board, 0).maxHeight < 20)
      )
        counts.oldBelowCeiling += 1;
    }
  }
}
console.log(JSON.stringify(counts, null, 2));
