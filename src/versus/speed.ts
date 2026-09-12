/**
 * Spectator speed multipliers for the versus view.
 *
 * Extracted from `src/main.ts` so the exact controller options the app runs at
 * each speed can be asserted in tests without booting the DOM. 1x is the
 * calibrated default (and the speed the verified gate/CLI runs use).
 */
import { VERSUS_DEFAULTS, type VersusControllerOptions } from "./controller.js";

/** Spectator speed multipliers; 1x is the calibrated default. */
export const SPEEDS = [0.5, 1, 2, 4] as const;

export type SpeedMultiplier = (typeof SPEEDS)[number];

export function isSpeed(value: number): value is SpeedMultiplier {
  return (SPEEDS as readonly number[]).includes(value);
}

/** 1x is the untouched default; other speeds scale both AI step and gravity intervals. */
export function speedOptions(multiplier: number): VersusControllerOptions {
  return {
    ...VERSUS_DEFAULTS,
    stepIntervalMs: VERSUS_DEFAULTS.stepIntervalMs / multiplier,
    gravityMs: VERSUS_DEFAULTS.gravityMs / multiplier,
  };
}
