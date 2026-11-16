/**
 * Unified rules-profile table: data-driven configuration for guideline vs S2 search.
 *
 * `search.ts` reads these profile fields instead of branching on `profile.id`:
 * - `garbageSemantics` selects between `expand()` ("root-lift") and `expandS2()`
 *   ("materialized-carried") — the two expansion models are kept as separate
 *   functions while their selection and internal mechanics are profile-driven.
 * - `spinEvidence`, `rotate180`, `spinClassifier`, `attackRules`, `surge`,
 *   `comboInAttack`, `deathHeight`, `visibleRows`, `dedupe`, and `allowRootVeto`
 *   drive the corresponding rules choices in `search.ts`.
 * - `SearchOptions.guideline` remains an external-rig override on the "root-lift"
 *   path (standard Hoiko matches pass `guideline: false`, which retains combo/PC).
 */
import type { RulesProfile as AttackProfile } from "./rules.js";

export type UnifiedProfileId = "guideline" | "s2";

export type DedupeProfile = "guideline" | "s2";

export interface RulesProfile {
  readonly id: UnifiedProfileId;
  /** Nominal board height for callers allocating boards (search reads `input.board.length`). */
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
  /**
   * Whether combo affects attack on the S2 path (false on the external
   * guideline rig; standard Hoiko/guideline matches have `SearchOptions.guideline = false`
   * and still include combo on the "root-lift" path).
   */
  readonly comboInAttack: boolean;
  /**
   * Garbage handling model. "root-lift" = only root pending is known, carried
   * as a lift scalar (uses `expand()`); "materialized-carried" = garbage rows are
   * tracked and materialized into the board, pending is carried through the
   * search (uses `expandS2()`).
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
  /** Whether the decision-stage root solvency veto (choose_rescue) is permitted. */
  readonly allowRootVeto: boolean;
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
    allowRootVeto: false,
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
    allowRootVeto: true,
  },
} as const;

export function rulesProfile(id: UnifiedProfileId): RulesProfile {
  return RULES_PROFILE_TABLE[id];
}
