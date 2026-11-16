/**
 * Unified rules-profile table: the ONLY source of guideline/S2 differences.
 *
 * All behavioral divergence is encoded as data in these fields, not scattered
 * conditionals. The search, evaluation, and mechanisms read the profile to
 * determine which code path to take.
 */
import type { RulesProfile as AttackProfile } from "./rules.js";

export type UnifiedProfileId = "guideline" | "s2";

export type DedupeProfile = "guideline" | "s2";

export interface RulesProfile {
  readonly id: UnifiedProfileId;
  readonly boardRows: number;
  readonly visibleRows: number;
  /**
   * Death threshold. Guideline death is `maxHeight >= board.length` (the board's
   * actual size, which varies); S2 death is `maxHeight >= 21` (fixed). The string
   * "boardLength" means the guideline rule; a number means the fixed threshold.
   */
  readonly deathHeight: number | "boardLength";
  /** The attack-table rules from src/core/rules.ts. */
  readonly attackRules: AttackProfile;
  /** Whether surge (B2B bonus) is enabled. */
  readonly surge: boolean;
  /** Whether combo affects attack (guideline rig folds combo out). */
  readonly comboInAttack: boolean;
  /**
   * Garbage handling model. "root-lift" = only root pending is known, carried
   * as a lift scalar; "materialized-carried" = garbage rows are tracked and
   * materialized into the board, pending is carried through the search.
   */
  readonly garbageSemantics: "root-lift" | "materialized-carried";
  /** Whether 180° rotations are available. */
  readonly rotate180: boolean;
  /** Whether spin evidence is tracked for non-T pieces. */
  readonly spinEvidence: boolean;
  /** Which spin classifier to use: engine (guideline) or s2 (All-Mini+). */
  readonly spinClassifier: "engine" | "s2";
  /** Which dedupe key form to use. */
  readonly dedupe: DedupeProfile;
}

export const RULES_PROFILE_TABLE: Readonly<Record<UnifiedProfileId, RulesProfile>> = {
  guideline: {
    id: "guideline",
    boardRows: 20,
    visibleRows: 20,
    deathHeight: "boardLength",
    attackRules: "guideline",
    surge: false,
    comboInAttack: false,
    garbageSemantics: "root-lift",
    rotate180: false,
    spinEvidence: false,
    spinClassifier: "engine",
    dedupe: "guideline",
  },
  s2: {
    id: "s2",
    boardRows: 40,
    visibleRows: 20,
    deathHeight: 21,
    attackRules: "tetrio-s2",
    surge: true,
    comboInAttack: true,
    garbageSemantics: "materialized-carried",
    rotate180: true,
    spinEvidence: true,
    spinClassifier: "s2",
    dedupe: "s2",
  },
} as const;

export function rulesProfile(id: UnifiedProfileId): RulesProfile {
  return RULES_PROFILE_TABLE[id];
}
