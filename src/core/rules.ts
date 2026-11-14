/** Native lock rules. References are headings in ../attax-s2/S2-SPEC.md. */
import { attackForClear, type ClearInfo } from "./garbage.js";
import type { TspinKind } from "./tspin.js";

export type RulesProfile = "guideline" | "tetrio-s2";
export const RULES_PROFILES = {
  guideline: { cols: 10, rows: 20, visibleRows: 20 },
  // Board dimensions: LAB-RECON, Timing and adapter requirements (20 buffer rows).
  "tetrio-s2": { cols: 10, rows: 40, visibleRows: 20 },
} as const;

const S2_GARBAGE_BASE = 1;
const S2_GARBAGE_INCREASE = 0.008;
const S2_GARBAGE_MARGIN_FRAMES = 10800;
const S2_FRAMES_PER_SECOND = 60;

export function s2GarbageMultiplier(frame: number): number {
  return (
    S2_GARBAGE_BASE +
    (Math.max(0, frame - S2_GARBAGE_MARGIN_FRAMES) * S2_GARBAGE_INCREASE) / S2_FRAMES_PER_SECOND
  );
}

/** S2-SPEC: Attack table and complete combo rule. No bounded lookup table. */
export function s2ComboAttack(base: number, combo: number): number {
  const c = Math.max(0, combo);
  return Math.floor(Math.max(base * (1 + 0.25 * c), c >= 2 ? Math.log1p(1.25 * c) : 0));
}

/** S2-SPEC: B2B charging and surge. d is one-based; displayed b = d - 1. */
export function s2Surge(d: number): number {
  return d >= 5 ? d - 1 : 0;
}

export interface LockAward {
  readonly attack: number;
  readonly difficultChain: number;
  readonly surgeReleased: number;
}

/** Optional S2 referee staging; combo is displayed (first clear = 0). */
export function awardLock(
  profile: RulesProfile,
  info: ClearInfo,
  difficultChain: number,
  stage?: { multiplier: number; garbageCleared: number },
): LockAward {
  if (profile === "guideline") {
    return { attack: attackForClear(info), difficultChain, surgeReleased: 0 };
  }
  if (info.lines === 0) return { attack: 0, difficultChain, surgeReleased: 0 };
  const spin: TspinKind = info.tspinKind ?? (info.tspinLines > 0 ? "full" : "none");
  const difficult = info.lines === 4 || spin !== "none" || info.perfectClear;
  const table =
    spin === "full"
      ? [0, 2, 4, 6, 10, 12]
      : spin === "mini"
        ? [0, 0, 1, 2, 10, 12]
        : [0, 0, 1, 2, 4, 5];
  const base = table[info.lines] ?? (table[5] as number) + (info.lines - 5);
  const surgeReleased = difficult ? 0 : s2Surge(difficultChain);
  // PC and surge are separate stages from the combo attack.
  const raw = s2ComboAttack(base + (difficult && difficultChain > 0 ? 1 : 0), info.combo);
  const specialBonus =
    stage && stage.garbageCleared > 0 && (spin !== "none" || info.lines >= 4) ? 1 : 0;
  return {
    attack:
      (stage ? Math.floor(raw * stage.multiplier + specialBonus) : raw) +
      (info.perfectClear ? (stage ? Math.floor(5 * stage.multiplier) : 5) : 0) +
      surgeReleased,
    difficultChain: difficult ? difficultChain + 1 : 0,
    surgeReleased,
  };
}

// TODO S2-SPEC Unpinned #2/#3: partition surge into three attacks and pin delivery/holes.
// TODO S2-SPEC Unpinned #4: margin multiplier and garbage special bonus are mirrored
// on the S2 search path via stage context (rounding "down" per the observed profile).
// TODO S2-SPEC Unpinned #6: spawn/hold coordinates, Clutch, ARE and blockout order.
// TODO S2-SPEC Unpinned #7: official intake/margin constants and numeric storage cap.
// Unpinned #1 is resolved by official 1.1.1/1.2.0: PC advances exactly once.
