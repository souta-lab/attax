/**
 * Rules audit: does the engine award Hoiko exactly the clear Hoiko itself predicted?
 *
 *   bun scripts/audit-rules.ts --seeds 3001-3020 --out bench-results/rules-audit.json
 *
 * For every Hoiko lock (bot vs Hoiko games) this compares the action code Hoiko's search
 * reported for its chosen move (`firstAct`: single, TSD, mini, ...) with the action the
 * engine awarded on lock. Any disagreement means the rules engine is judging Hoiko by
 * rules it does not play by — which would make a win over it meaningless.
 */
import { writeFileSync } from "node:fs";
import { createBot } from "../src/ai/bot/fighter.js";
import { lockActionCode } from "../src/ai/hoiko/engine.js";
import { resolveFaithfulHoikoOptions } from "../src/ai/hoiko/faithful.js";
import type { GameSnapshot } from "../src/core/types.js";
import { resolveVersusConfig } from "../src/versus/config.js";
import {
  createVersusController,
  VERSUS_DEFAULTS,
  type VersusFighter,
} from "../src/versus/controller.js";
import { createHoiko } from "../tools/hoiko-node.js";

const argv = process.argv.slice(2);
const arg = (name: string, fallback: string): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] as string) : fallback;
};
const [from, to] = arg("seeds", "3001-3020").split("-").map(Number) as [number, number];
const tally = new Map<string, number>();
let locks = 0;
let agree = 0;

for (let seed = from; seed <= to; seed += 1) {
  const hoiko = createHoiko(resolveFaithfulHoikoOptions({ HOIKO_ADAPT: "0" }));
  let predicted: number | null = null;
  const audited: VersusFighter = {
    name: hoiko.name,
    color: hoiko.color,
    reset: () => hoiko.reset?.(),
    findBestMove(s: GameSnapshot) {
      const r = hoiko.searchSnapshot(s);
      predicted = r !== null && r.out.useHold !== 1 ? r.out.firstAct : null;
      return r?.move ?? null;
    },
  };
  const controller = createVersusController(createBot(), audited, seed, resolveVersusConfig());
  let lockId = 0;
  for (let t = 0; t < 12000 && controller.result === null; t += 1) {
    controller.tick(16, VERSUS_DEFAULTS);
    const transition = controller.right.core.getLastLockTransition();
    if (transition === null || transition.lockId === lockId) continue;
    lockId = transition.lockId;
    if (predicted !== null) {
      const awarded = lockActionCode(transition.action);
      locks += 1;
      if (awarded === predicted) agree += 1;
      const key = `hoiko=${predicted} engine=${awarded} (${transition.action})`;
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    predicted = null;
  }
}

const result = {
  seeds: `${from}-${to}`,
  locks,
  agree,
  breakdown: Object.fromEntries([...tally].sort()),
};
console.log(JSON.stringify(result, null, 2));
const out = arg("out", "");
if (out !== "") writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
