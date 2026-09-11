// Genome definition for the versus self-play tuner.
//
// A genome is a flat, JSON-serializable map of named scalar parameters. The
// baseline genome is byte-equivalent to the constants baked into
// `src/ai/deepseek.ts`, so `createTunedDeepSeek(BASELINE_GENOME)` reproduces the
// gate's DeepSeek fighter exactly (verified by tests/tuner.test.ts).
//
// New file only: existing src/ai/* is untouched. Structural thresholds are kept
// in the genome for a fully self-describing weights file, but marked
// `tunable: false` so the evolution strategy never mutates algorithm structure.

import type { Weights } from "../ai/weights.js";

export type Genome = Readonly<Record<string, number>>;

export interface GeneSpec {
  readonly key: string;
  /** Baseline value (exactly matches src/ai/deepseek.ts). */
  readonly value: number;
  readonly tunable: boolean;
  readonly min: number;
  readonly max: number;
  /** Per-gene Gaussian step used by the (1+lambda) evolution strategy. */
  readonly sigma: number;
}

function fixed(key: string, value: number): GeneSpec {
  return { key, value, tunable: false, min: value, max: value, sigma: 0 };
}

function gene(key: string, value: number, min: number, max: number, sigma: number): GeneSpec {
  return { key, value, tunable: true, min, max, sigma };
}

/**
 * All named constants of the DeepSeek fighter. `w.*` are the Dubois/DU board
 * features, `f.*` the fire (clear reward) weights, `p.*` the ~40 personality
 * shaping constants, and `s.*` the beam search configuration.
 */
export const GENE_SPECS: readonly GeneSpec[] = [
  // --- board features (eval) ---
  gene("w.landingHeight", -4.5, -12, 0, 1.5),
  gene("w.erodedCells", 3.4, 0, 10, 1),
  gene("w.rowTransitions", -3.2, -8, 0, 1),
  gene("w.colTransitions", -9.35, -20, 0, 2),
  gene("w.holes", -14.5, -30, -6, 3),
  gene("w.wells", -11, -25, -4, 3),
  gene("w.holeDepth", -2, -6, 0, 0.8),
  gene("w.rowsWithHoles", -26, -50, -12, 5),
  gene("w.bumpiness", -1.5, -5, 0, 0.8),
  gene("w.maxHeight", -3.6, -10, -1, 1.2),
  gene("w.linesCleared", 200, 50, 400, 40),

  // --- fire / clear-reward weights ---
  gene("f.tetris", 390, 150, 900, 100),
  gene("f.tspin", 121, 0, 500, 60),
  fixed("f.tspinSingle", 0),
  gene("f.tspinDouble", 289, 0, 800, 90),
  gene("f.tspinTriple", 481, 0, 1200, 140),
  gene("f.b2bBonus", 104, 0, 500, 60),
  gene("f.comboStep", 150, 0, 500, 60),
  gene("f.perfectClear", 999, 0, 4000, 400),
  gene("f.wellStep", 7, 0, 60, 8),
  gene("f.tslotStep", 42, 0, 150, 18),

  // --- personality shaping ---
  gene("p.ATK_W", 142, 0, 400, 35),
  gene("p.TSD_EXEC", 205, 0, 600, 60),
  gene("p.TETRIS_EXEC", 320, 0, 900, 90),
  gene("p.TRIPLE_EXEC", 340, 0, 900, 90),
  fixed("p.TRIPLE_ARRIVAL", 220),
  gene("p.B2B_CHAIN", 130, 0, 500, 50),
  gene("p.B2B_BREAK", 120, 0, 500, 50),
  gene("p.CAVITY_STEP", 25, 0, 100, 12),
  gene("p.COMBO_KEEP", 60, 0, 300, 35),
  fixed("p.COMBO_BREAK", 60),
  gene("p.REN_STEP", 55, 0, 250, 30),
  fixed("p.REN_START", 2),
  gene("p.REN_LATE_STEP", 110, 0, 400, 45),
  fixed("p.REN_LATE_N", 150),
  gene("p.URGENCY_W", 32, 0, 200, 25),
  gene("p.DIG_BONUS", 145, 0, 500, 55),
  fixed("p.DIG_HOLD", 45),
  fixed("p.EMERG_LINE", 14),
  gene("p.TSD_ARRIVAL", 340, 0, 900, 90),
  gene("p.TETRIS_ARRIVAL", 460, 0, 1200, 120),
  gene("p.WELL_PLY_STEP", 30, 0, 150, 18),
  gene("p.TSLOT_KEEP2", 42, 0, 200, 25),
  fixed("p.WELL_EDGE_BONUS", 34),
  fixed("p.WELL_CENTER_PEN", 55),
  gene("p.TETRIS_READY", 170, 0, 600, 60),
  fixed("p.TETRIS_EXEC_DEEP", 340),
  fixed("p.TSD_EXEC_DEEP", 220),
  fixed("p.WASTED_T_CLEAR", 150),
  fixed("p.WASTED_T_IDLE", 20),
  fixed("p.WASTED_I_CLEAR", 110),
  fixed("p.WASTED_I_IDLE", 20),
  fixed("p.BUMP_CAP", 8),
  fixed("p.BUMP_STEP", 22),
  fixed("p.LATE_PIECE_N", 60),
  fixed("p.LATE_MULT", 1.15),
  gene("p.HOLE_EXTRA", 14, 0, 80, 9),
  fixed("p.OPENING_N", 30),
  fixed("p.READY_DEPTH", 4),
  gene("p.EXECUTE_BONUS", 420, 0, 1200, 120),
  gene("p.FILL_PEN", 80, 0, 400, 45),
  fixed("p.WELL_FILL_LOSS", 40),
  fixed("p.DIG_H20_STEP", 220),
  fixed("p.RESERVE_CEIL", 13),
  fixed("p.HOLE_DIVE_STEP", 18),
  fixed("p.B2B_WEAK_EXTRA", 60),
  fixed("p.B2B_TSLOT_EXTRA", 50),
  fixed("p.WELL_REBUILD_STEP", 22),
  fixed("p.REN_CALM_KEEP", 30),
  fixed("p.CAP_PEN", 30),
  fixed("p.HIGH_PEN", 25),

  // --- beam search configuration (structural; fixed) ---
  fixed("s.depth", 6),
  fixed("s.width", 24),
  fixed("s.topK", 16),
];

export const BASELINE_GENOME: Genome = Object.freeze(
  Object.fromEntries(GENE_SPECS.map((spec) => [spec.key, spec.value])),
);

export const TUNABLE_SPECS: readonly GeneSpec[] = GENE_SPECS.filter((spec) => spec.tunable);

const SPEC_BY_KEY: ReadonlyMap<string, GeneSpec> = new Map(
  GENE_SPECS.map((spec) => [spec.key, spec]),
);

export function geneSpec(key: string): GeneSpec {
  const spec = SPEC_BY_KEY.get(key);
  if (spec === undefined) throw new Error(`unknown gene: ${key}`);
  return spec;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Clamp every gene to its declared bounds (defensive against hand-edited JSON). */
export function sanitizeGenome(genome: Genome): Genome {
  const out: Record<string, number> = {};
  for (const spec of GENE_SPECS) {
    const raw = genome[spec.key];
    const value = typeof raw === "number" && Number.isFinite(raw) ? raw : spec.value;
    out[spec.key] = clamp(value, spec.min, spec.max);
  }
  return out;
}

/** Merge a partial record over the baseline (missing keys fall back to baseline). */
export function resolveGenome(partial: Readonly<Record<string, number>>): Genome {
  return sanitizeGenome({ ...BASELINE_GENOME, ...partial });
}

function reader(genome: Genome, key: string): number {
  const value = genome[key];
  if (value === undefined) throw new Error(`genome missing gene ${key}`);
  return value;
}

export interface TunedFire {
  readonly tetris: number;
  readonly tspin: number;
  readonly tspinSingle: number;
  readonly tspinDouble: number;
  readonly tspinTriple: number;
  readonly b2bBonus: number;
  readonly comboStep: number;
  readonly perfectClear: number;
  readonly wellStep: number;
  readonly tslotStep: number;
}

export interface TunedPersonality {
  readonly ATK_W: number;
  readonly TSD_EXEC: number;
  readonly TETRIS_EXEC: number;
  readonly TRIPLE_EXEC: number;
  readonly TRIPLE_ARRIVAL: number;
  readonly B2B_CHAIN: number;
  readonly B2B_BREAK: number;
  readonly CAVITY_STEP: number;
  readonly COMBO_KEEP: number;
  readonly COMBO_BREAK: number;
  readonly REN_STEP: number;
  readonly REN_START: number;
  readonly REN_LATE_STEP: number;
  readonly REN_LATE_N: number;
  readonly URGENCY_W: number;
  readonly DIG_BONUS: number;
  readonly DIG_HOLD: number;
  readonly EMERG_LINE: number;
  readonly TSD_ARRIVAL: number;
  readonly TETRIS_ARRIVAL: number;
  readonly WELL_PLY_STEP: number;
  readonly TSLOT_KEEP2: number;
  readonly WELL_EDGE_BONUS: number;
  readonly WELL_CENTER_PEN: number;
  readonly TETRIS_READY: number;
  readonly TETRIS_EXEC_DEEP: number;
  readonly TSD_EXEC_DEEP: number;
  readonly WASTED_T_CLEAR: number;
  readonly WASTED_T_IDLE: number;
  readonly WASTED_I_CLEAR: number;
  readonly WASTED_I_IDLE: number;
  readonly BUMP_CAP: number;
  readonly BUMP_STEP: number;
  readonly LATE_PIECE_N: number;
  readonly LATE_MULT: number;
  readonly HOLE_EXTRA: number;
  readonly OPENING_N: number;
  readonly READY_DEPTH: number;
  readonly EXECUTE_BONUS: number;
  readonly FILL_PEN: number;
  readonly WELL_FILL_LOSS: number;
  readonly DIG_H20_STEP: number;
  readonly RESERVE_CEIL: number;
  readonly HOLE_DIVE_STEP: number;
  readonly B2B_WEAK_EXTRA: number;
  readonly B2B_TSLOT_EXTRA: number;
  readonly WELL_REBUILD_STEP: number;
  readonly REN_CALM_KEEP: number;
  readonly CAP_PEN: number;
  readonly HIGH_PEN: number;
}

export interface TunedSearch {
  readonly depth: number;
  readonly width: number;
  readonly topK: number;
}

export interface TunedParams {
  readonly weights: Weights;
  readonly fire: TunedFire;
  readonly personality: TunedPersonality;
  readonly search: TunedSearch;
}

export function decodeGenome(genome: Genome): TunedParams {
  const g = (key: string): number => reader(genome, key);
  return {
    weights: {
      landingHeight: g("w.landingHeight"),
      erodedCells: g("w.erodedCells"),
      rowTransitions: g("w.rowTransitions"),
      colTransitions: g("w.colTransitions"),
      holes: g("w.holes"),
      wells: g("w.wells"),
      holeDepth: g("w.holeDepth"),
      rowsWithHoles: g("w.rowsWithHoles"),
      bumpiness: g("w.bumpiness"),
      maxHeight: g("w.maxHeight"),
      linesCleared: g("w.linesCleared"),
    },
    fire: {
      tetris: g("f.tetris"),
      tspin: g("f.tspin"),
      tspinSingle: g("f.tspinSingle"),
      tspinDouble: g("f.tspinDouble"),
      tspinTriple: g("f.tspinTriple"),
      b2bBonus: g("f.b2bBonus"),
      comboStep: g("f.comboStep"),
      perfectClear: g("f.perfectClear"),
      wellStep: g("f.wellStep"),
      tslotStep: g("f.tslotStep"),
    },
    personality: {
      ATK_W: g("p.ATK_W"),
      TSD_EXEC: g("p.TSD_EXEC"),
      TETRIS_EXEC: g("p.TETRIS_EXEC"),
      TRIPLE_EXEC: g("p.TRIPLE_EXEC"),
      TRIPLE_ARRIVAL: g("p.TRIPLE_ARRIVAL"),
      B2B_CHAIN: g("p.B2B_CHAIN"),
      B2B_BREAK: g("p.B2B_BREAK"),
      CAVITY_STEP: g("p.CAVITY_STEP"),
      COMBO_KEEP: g("p.COMBO_KEEP"),
      COMBO_BREAK: g("p.COMBO_BREAK"),
      REN_STEP: g("p.REN_STEP"),
      REN_START: g("p.REN_START"),
      REN_LATE_STEP: g("p.REN_LATE_STEP"),
      REN_LATE_N: g("p.REN_LATE_N"),
      URGENCY_W: g("p.URGENCY_W"),
      DIG_BONUS: g("p.DIG_BONUS"),
      DIG_HOLD: g("p.DIG_HOLD"),
      EMERG_LINE: g("p.EMERG_LINE"),
      TSD_ARRIVAL: g("p.TSD_ARRIVAL"),
      TETRIS_ARRIVAL: g("p.TETRIS_ARRIVAL"),
      WELL_PLY_STEP: g("p.WELL_PLY_STEP"),
      TSLOT_KEEP2: g("p.TSLOT_KEEP2"),
      WELL_EDGE_BONUS: g("p.WELL_EDGE_BONUS"),
      WELL_CENTER_PEN: g("p.WELL_CENTER_PEN"),
      TETRIS_READY: g("p.TETRIS_READY"),
      TETRIS_EXEC_DEEP: g("p.TETRIS_EXEC_DEEP"),
      TSD_EXEC_DEEP: g("p.TSD_EXEC_DEEP"),
      WASTED_T_CLEAR: g("p.WASTED_T_CLEAR"),
      WASTED_T_IDLE: g("p.WASTED_T_IDLE"),
      WASTED_I_CLEAR: g("p.WASTED_I_CLEAR"),
      WASTED_I_IDLE: g("p.WASTED_I_IDLE"),
      BUMP_CAP: g("p.BUMP_CAP"),
      BUMP_STEP: g("p.BUMP_STEP"),
      LATE_PIECE_N: g("p.LATE_PIECE_N"),
      LATE_MULT: g("p.LATE_MULT"),
      HOLE_EXTRA: g("p.HOLE_EXTRA"),
      OPENING_N: g("p.OPENING_N"),
      READY_DEPTH: g("p.READY_DEPTH"),
      EXECUTE_BONUS: g("p.EXECUTE_BONUS"),
      FILL_PEN: g("p.FILL_PEN"),
      WELL_FILL_LOSS: g("p.WELL_FILL_LOSS"),
      DIG_H20_STEP: g("p.DIG_H20_STEP"),
      RESERVE_CEIL: g("p.RESERVE_CEIL"),
      HOLE_DIVE_STEP: g("p.HOLE_DIVE_STEP"),
      B2B_WEAK_EXTRA: g("p.B2B_WEAK_EXTRA"),
      B2B_TSLOT_EXTRA: g("p.B2B_TSLOT_EXTRA"),
      WELL_REBUILD_STEP: g("p.WELL_REBUILD_STEP"),
      REN_CALM_KEEP: g("p.REN_CALM_KEEP"),
      CAP_PEN: g("p.CAP_PEN"),
      HIGH_PEN: g("p.HIGH_PEN"),
    },
    search: {
      depth: g("s.depth"),
      width: g("s.width"),
      topK: g("s.topK"),
    },
  };
}
