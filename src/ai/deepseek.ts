// "DeepSeek Tetris" — the project's single candidate AI.
//
// Policy (2026-09-10): the former BLUE/RED co-evolution is retired. BLUE's
// implementation (fighterA.ts + blueV8/blueV9-score.ts) is now the one AI to
// improve; RED (fighterB.ts) is kept only as a frozen opponent for robustness
// and never improved again. fighterA.ts stays as the implementation file for
// test compatibility; this module is the canonical entry point going forward.
import type { AiDebug, AiMove, GameSnapshot } from "../ui/types.js";
import { createFighterA, type FighterAOptions } from "./fighterA.js";

export const DEEPSEEK_NAME = "DEEPSEEK";

export interface DeepSeekTetris {
  readonly name: string;
  findBestMove(snapshot: GameSnapshot): AiMove | null;
  getDebug(): AiDebug | null;
}

export function createDeepSeekTetris(options: FighterAOptions = {}): DeepSeekTetris {
  const fighter = createFighterA(options);
  return {
    name: DEEPSEEK_NAME,
    findBestMove: (snapshot) => fighter.findBestMove(snapshot),
    getDebug: () => fighter.getDebug(),
  };
}
