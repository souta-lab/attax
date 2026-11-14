import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const labRoot = resolve(process.env.S2_LAB_ROOT ?? "../s2-bot-lab-ref");
export const lab = (path) => import(pathToFileURL(resolve(labRoot, path)).href);
export const controller = await lab("src-js/bot-match-controller.mjs");
export const champion = await lab("src-js/champion-parameters.mjs");
export const parameters = (await lab("src-js/bot-parameters.mjs")).defaultBotParameters(
  "cc2-s2-champion",
);
export const profile = champion.createChampionProfile(parameters);
export const { fullStateKey } = await lab("src-js/state-keys.mjs");
export const { applyTransition } = await lab("src-js/transition.mjs");
export const { resolvePlacementRules } = await lab("src-js/ruleset-profiles.mjs");
export const { createS2AmountOnlyDecisionState } = await lab(
  "src-js/s2-amount-only-decision-state.mjs",
);
