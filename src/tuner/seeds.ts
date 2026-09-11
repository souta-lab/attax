// Curated screening population for the tuner's first generation.
//
// These are single-term, attack-relevant perturbations (per the versus-tuning
// research note): b2b / combo / tetris / execute rewards and the survival
// trade-off. Each is a partial genome resolved over BASELINE_GENOME, so the
// screen tests exactly one hypothesis at a time.

import { type Genome, resolveGenome } from "./genome.js";

export type GenomeOverride = Readonly<Record<string, number>>;

export const SEED_OVERRIDES: readonly GenomeOverride[] = [
  { "p.ATK_W": 175 },
  { "f.b2bBonus": 170 },
  { "f.comboStep": 230 },
  { "f.tetris": 520 },
  { "w.holes": -17.5 },
  { "p.EXECUTE_BONUS": 540 },
  { "p.B2B_CHAIN": 180 },
  { "p.TETRIS_READY": 220 },
];

export function seedGenomes(): readonly Genome[] {
  return SEED_OVERRIDES.map((override) => resolveGenome(override));
}
