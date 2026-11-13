// Micro-benchmark: bot decisions per second on positions from a self-play game.
import { createBot } from "../src/ai/bot/fighter.js";
import { createEngine } from "../src/core/engine.js";
import { seededRandom } from "../src/versus/controller.js";

const bot = createBot({ width: Number(process.env.WIDTH ?? 48) });
const engine = createEngine({ random: seededRandom(7) });
let ms = 0;
let n = 0;
let nodes = 0;
for (let i = 0; i < 120 && !engine.getSnapshot().gameOver; i += 1) {
  const s = engine.getSnapshot();
  const t0 = performance.now();
  const move = bot.findBestMove(s);
  ms += performance.now() - t0;
  n += 1;
  nodes += bot.lastSearch()?.nodes ?? 0;
  if (move === null) break;
  if (move.useHold) { engine.hold(); continue; }
  const step = move.execution?.steps[0];
  if (step?.kind === "placeAt") engine.placeMinoAt?.(step.rotation, step.x, step.topRow ?? 0, step.lastSrs ?? 0);
}
const s = engine.getSnapshot();
console.log({ decisions: n, msPerDecision: +(ms / n).toFixed(1), nodesPerDecision: Math.round(nodes / n), lines: s.lines, score: s.score, gameOver: s.gameOver });
