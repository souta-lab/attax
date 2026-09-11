// Shared job/type definitions for the tuner <-> eval-worker protocol.
// Kept free of I/O so both the orchestrator and the worker can import it.

import type { HoikoPreset } from "../ai/hoiko-weights.js";

export interface SearchConfig {
  readonly depth: number;
  readonly width: number;
  readonly topK: number;
}

/** The exact beam configuration used by src/ai/deepseek.ts. */
export const REAL_SEARCH: SearchConfig = { depth: 6, width: 24, topK: 16 };

/** Cheaper beam used only to rank candidates during the search. */
export const PROXY_SEARCH: SearchConfig = { depth: 4, width: 16, topK: 10 };

export type EvalMode = "tuned" | "baseline";

export interface EvalJob {
  readonly id: string;
  readonly mode: EvalMode;
  readonly genome?: Readonly<Record<string, number>> | undefined;
  readonly search?: SearchConfig | undefined;
  readonly seeds: readonly number[];
  readonly maxTicks: number;
  readonly hoikoPreset: HoikoPreset;
}
