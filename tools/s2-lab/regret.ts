/** Yield-regret instrument (EARLY-CANCEL-DESIGN-2026-11-24 §2.1).
 *
 * Question it separates: on opportunity turns (pendingBefore > 0) in locks
 * 10–29, was the premium clear (a) present among the candidates the search
 * actually evaluated but not chosen (selection problem -> mechanism A), or
 * (b) absent from the candidate set altogether (board-construction problem
 * -> mechanism B)?
 *
 * Definition: regret(turn) = maxAeff(candidates) - Aeff(chosen), where Aeff
 * is the root step's search-internal attack (`Candidate.attack`, pre-cancel
 * award; the same quantity the search itself prices). Both terms come from
 * the SAME search call, so the figure is internally consistent even where
 * the referee's realised Aeff (cancelled + outgoingAfterCancel in the trace)
 * differs by the known +1 cancel component.
 *
 * Recording rule: only attax turns with pendingBefore > 0 and
 * 10 <= lockIndex < 30 are recorded (the design's band). Everything else
 * returns null so a trace driver can call this unconditionally.
 *
 * This module is pure: no I/O, no weights, no search invocation. A trace
 * driver (run-match-trace form) calls `regretRow` with the SearchResult it
 * already computed and appends the returned row to its regret JSONL.
 */
import type { SearchResult } from "./search.js";

export const REGRET_BAND_LO = 10;
export const REGRET_BAND_HI = 30; // exclusive

export interface RegretRow {
  readonly lockIndex: number;
  readonly pendingBefore: number;
  /** Attack of the move actually chosen (search `best.attack`). */
  readonly chosenAeff: number;
  /** Largest attack among all evaluated root candidates. */
  readonly maxCandidateAeff: number;
  /** maxCandidateAeff - chosenAeff (>= 0). */
  readonly regret: number;
  readonly chosenLines: number;
  /** Lines cleared by the highest-attack candidate (first such candidate). */
  readonly maxCandidateLines: number;
  readonly candidateCount: number;
}

/** True when a turn is in scope for the instrument. */
export function isOpportunityTurn(lockIndex: number, pendingBefore: number): boolean {
  return pendingBefore > 0 && lockIndex >= REGRET_BAND_LO && lockIndex < REGRET_BAND_HI;
}

/**
 * Build the regret row for one decided turn, or null when out of scope or
 * the search produced no candidates. `pendingBefore` is the referee-side
 * pending at turn start (the trace's pendingBefore), not the search's
 * internal residual.
 */
export function regretRow(
  result: Pick<SearchResult, "best" | "candidates">,
  lockIndex: number,
  pendingBefore: number,
): RegretRow | null {
  if (!isOpportunityTurn(lockIndex, pendingBefore)) return null;
  if (result.candidates.length === 0) return null;
  let max = result.candidates[0] as SearchResult["candidates"][number];
  for (const c of result.candidates) if (c.attack > max.attack) max = c;
  const chosenAeff = result.best.attack;
  return {
    lockIndex,
    pendingBefore,
    chosenAeff,
    maxCandidateAeff: max.attack,
    regret: max.attack - chosenAeff,
    chosenLines: result.best.linesCleared,
    maxCandidateLines: max.linesCleared,
    candidateCount: result.candidates.length,
  };
}

/** Band total + per-turn mean over recorded rows (the §2.4 readout item 6). */
export function summariseRegret(rows: readonly RegretRow[]): {
  turns: number;
  totalRegret: number;
  meanRegret: number;
  positiveShare: number;
} {
  const total = rows.reduce((n, r) => n + r.regret, 0);
  return {
    turns: rows.length,
    totalRegret: total,
    meanRegret: rows.length ? total / rows.length : 0,
    positiveShare: rows.length ? rows.filter((r) => r.regret > 0).length / rows.length : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Supply-side extension (SUPPLY-DECOMPOSE-2026-11-24 §7–§8).          */
/*                                                                     */
/* The yield instrument above covers opportunity turns only            */
/* (pendingBefore > 0, locks 10–29): the processing side. The supply   */
/* decomposition showed the production gap lives on ALL turns in       */
/* locks 10–39 (frequency/composition of premium clears, H-S1) and     */
/* that sending alignment (opponent's pending window, H-S2) needs a    */
/* per-turn record too. This extension therefore records, for every    */
/* attax turn in locks 10–39 regardless of pending:                    */
/*                                                                     */
/*   supplyRegret(turn) = maxCandidateOutgoing − chosenOutgoing,       */
/*   outgoing(attack)   = max(0, attack − pendingBefore).              */
/*                                                                     */
/* Outgoing — not Aeff — is the supply quantity: it is what the        */
/* opponent actually receives (trace identity: received == outgoing,   */
/* verified band-by-band in SUPPLY-DECOMPOSE §2). The Aeff regret is   */
/* recorded alongside so the two sides stay separable in one row:      */
/* aeffRegret − supplyRegret is the part of the yield gap that was     */
/* absorbed by cancelling own pending (processing side), and           */
/* supplyRegret is the part that would have reached the opponent.      */
/*                                                                     */
/* Composition fields (lines / spin of the chosen move and of both     */
/* argmax candidates) let a readout split the regret by the H-S1       */
/* axes — single/double frequency and spin premium — without           */
/* re-running the search. `opponentPendingBefore` is optional: the     */
/* search does not know it, so a driver that tracks the opponent's     */
/* pending (trace replay does) passes it in for the H-S2 slice;        */
/* otherwise it is recorded as null, never guessed.                    */
/*                                                                     */
/* Pure like the rest of this module: no I/O, no weights, no search.   */
/* ------------------------------------------------------------------ */

export const SUPPLY_BAND_LO = 10;
export const SUPPLY_BAND_HI = 40; // exclusive: locks 10–39

/** Minimal structural view of a candidate for the supply instrument. */
export interface SupplyCandidateLike {
  readonly attack: number;
  readonly linesCleared: number;
  readonly spin?: string;
}

/** Minimal structural view of a decided turn's search result. */
export interface SupplySearchLike {
  readonly best: {
    readonly attack: number;
    readonly linesCleared: number;
    readonly spin?: string;
    readonly placement?: { readonly tspin?: string };
  };
  readonly candidates: readonly SupplyCandidateLike[];
}

export interface SupplyRegretRow {
  readonly lockIndex: number;
  readonly pendingBefore: number;
  /** Opponent's pending at turn start when the driver knows it, else null. */
  readonly opponentPendingBefore: number | null;
  /** pendingBefore > 0 (the original instrument's opportunity turns). */
  readonly opportunity: boolean;
  readonly chosenAeff: number;
  readonly maxCandidateAeff: number;
  /** maxCandidateAeff − chosenAeff (>= 0). */
  readonly aeffRegret: number;
  readonly chosenOutgoing: number;
  readonly maxCandidateOutgoing: number;
  /** maxCandidateOutgoing − chosenOutgoing (>= 0). The supply regret. */
  readonly supplyRegret: number;
  /** aeffRegret − supplyRegret: gap absorbed by cancelling own pending. */
  readonly cancelAbsorbedRegret: number;
  readonly chosenLines: number;
  readonly maxOutgoingLines: number;
  readonly maxAeffLines: number;
  /** Spin labels in trace vocabulary: "none" | "mini" | "normal" | "unknown". */
  readonly chosenSpin: string;
  readonly maxOutgoingSpin: string;
  readonly maxAeffSpin: string;
  readonly chosenSends: boolean;
  readonly anyCandidateSends: boolean;
  /** A sending candidate existed but the chosen move sent nothing. */
  readonly missedSend: boolean;
  /** The best sending candidate was a spin clear, the chosen move was not,
   * and supply was actually left on the table (supplyRegret > 0). */
  readonly missedSpinPremium: boolean;
  readonly candidateCount: number;
  readonly sendingCandidateCount: number;
}

/** Outgoing (post-cancel sent amount) of an attack against pending. */
export function outgoingOf(attack: number, pendingBefore: number): number {
  return Math.max(0, attack - pendingBefore);
}

/** Supply scope: every turn in locks 10–39, pending or not. */
export function isSupplyTurn(lockIndex: number): boolean {
  return lockIndex >= SUPPLY_BAND_LO && lockIndex < SUPPLY_BAND_HI;
}

/** Trace vocabulary: the search's "full" spin is the trace's "normal". */
export function supplySpinLabel(spin: string | undefined): string {
  if (spin === undefined) return "unknown";
  return spin === "full" ? "normal" : spin;
}

function isSpinLabel(label: string): boolean {
  return label === "mini" || label === "normal";
}

/**
 * Build the supply-regret row for one decided turn, or null when the turn
 * is outside locks 10–39 or the search produced no candidates.
 * `opponentPendingBefore` is recorded verbatim (null when unknown).
 */
export function supplyRegretRow(
  result: SupplySearchLike,
  lockIndex: number,
  pendingBefore: number,
  opponentPendingBefore: number | null = null,
): SupplyRegretRow | null {
  if (!isSupplyTurn(lockIndex)) return null;
  if (result.candidates.length === 0) return null;
  let maxAeff = result.candidates[0] as SupplyCandidateLike;
  let maxOut = result.candidates[0] as SupplyCandidateLike;
  let sendingCandidateCount = 0;
  for (const c of result.candidates) {
    if (c.attack > maxAeff.attack) maxAeff = c;
    if (outgoingOf(c.attack, pendingBefore) > outgoingOf(maxOut.attack, pendingBefore)) maxOut = c;
    if (outgoingOf(c.attack, pendingBefore) > 0) sendingCandidateCount += 1;
  }
  const chosenAeff = result.best.attack;
  const chosenOutgoing = outgoingOf(chosenAeff, pendingBefore);
  const maxCandidateOutgoing = outgoingOf(maxOut.attack, pendingBefore);
  const aeffRegret = maxAeff.attack - chosenAeff;
  const supplyRegret = maxCandidateOutgoing - chosenOutgoing;
  const chosenSpin = supplySpinLabel(result.best.spin ?? result.best.placement?.tspin);
  const maxOutgoingSpin = supplySpinLabel(maxOut.spin);
  return {
    lockIndex,
    pendingBefore,
    opponentPendingBefore,
    opportunity: pendingBefore > 0,
    chosenAeff,
    maxCandidateAeff: maxAeff.attack,
    aeffRegret,
    chosenOutgoing,
    maxCandidateOutgoing,
    supplyRegret,
    cancelAbsorbedRegret: aeffRegret - supplyRegret,
    chosenLines: result.best.linesCleared,
    maxOutgoingLines: maxOut.linesCleared,
    maxAeffLines: maxAeff.linesCleared,
    chosenSpin,
    maxOutgoingSpin,
    maxAeffSpin: supplySpinLabel(maxAeff.spin),
    chosenSends: chosenOutgoing > 0,
    anyCandidateSends: sendingCandidateCount > 0,
    missedSend: chosenOutgoing === 0 && sendingCandidateCount > 0,
    missedSpinPremium: supplyRegret > 0 && isSpinLabel(maxOutgoingSpin) && !isSpinLabel(chosenSpin),
    candidateCount: result.candidates.length,
    sendingCandidateCount,
  };
}

export interface SupplyBreakdownEntry {
  turns: number;
  totalSupplyRegret: number;
  totalAeffRegret: number;
  chosenOutgoing: number;
  maxCandidateOutgoing: number;
}

function emptyEntry(): SupplyBreakdownEntry {
  return { turns: 0, totalSupplyRegret: 0, totalAeffRegret: 0, chosenOutgoing: 0, maxCandidateOutgoing: 0 };
}

function addTo(map: Record<string, SupplyBreakdownEntry>, key: string, r: SupplyRegretRow): void {
  const e = (map[key] ??= emptyEntry());
  e.turns += 1;
  e.totalSupplyRegret += r.supplyRegret;
  e.totalAeffRegret += r.aeffRegret;
  e.chosenOutgoing += r.chosenOutgoing;
  e.maxCandidateOutgoing += r.maxCandidateOutgoing;
}

function subBandKey(lockIndex: number): string {
  return lockIndex < 20 ? "10-19" : lockIndex < 30 ? "20-29" : "30-39";
}

/**
 * Frequency/composition summary over supply rows (the H-S1/H-S2 readout):
 * band totals, sub-band split, regret split by chosen lines and by the
 * best sending candidate's spin, the missed-send frequency gap, and the
 * opponent-pending alignment slice (rows with unknown opponent pending
 * are excluded from that slice only).
 */
export function summariseSupplyRegret(rows: readonly SupplyRegretRow[]): {
  turns: number;
  totalSupplyRegret: number;
  meanSupplyRegret: number;
  positiveShare: number;
  totalAeffRegret: number;
  cancelAbsorbedRegret: number;
  chosenOutgoing: number;
  maxCandidateOutgoing: number;
  chosenSendingShare: number;
  anyCandidateSendingShare: number;
  missedSendTurns: number;
  missedSpinPremiumTurns: number;
  bySubBand: Record<string, SupplyBreakdownEntry>;
  byChosenLines: Record<string, SupplyBreakdownEntry>;
  byMaxOutgoingSpin: Record<string, SupplyBreakdownEntry>;
  opponentPending: {
    knownTurns: number;
    withPending: SupplyBreakdownEntry;
    withoutPending: SupplyBreakdownEntry;
  };
} {
  const bySubBand: Record<string, SupplyBreakdownEntry> = {};
  const byChosenLines: Record<string, SupplyBreakdownEntry> = {};
  const byMaxOutgoingSpin: Record<string, SupplyBreakdownEntry> = {};
  const withPending = emptyEntry();
  const withoutPending = emptyEntry();
  let knownTurns = 0;
  for (const r of rows) {
    addTo(bySubBand, subBandKey(r.lockIndex), r);
    addTo(byChosenLines, String(r.chosenLines), r);
    addTo(byMaxOutgoingSpin, r.maxOutgoingSpin, r);
    if (r.opponentPendingBefore !== null) {
      knownTurns += 1;
      const e = r.opponentPendingBefore > 0 ? withPending : withoutPending;
      e.turns += 1;
      e.totalSupplyRegret += r.supplyRegret;
      e.totalAeffRegret += r.aeffRegret;
      e.chosenOutgoing += r.chosenOutgoing;
      e.maxCandidateOutgoing += r.maxCandidateOutgoing;
    }
  }
  const totalSupplyRegret = rows.reduce((n, r) => n + r.supplyRegret, 0);
  const totalAeffRegret = rows.reduce((n, r) => n + r.aeffRegret, 0);
  return {
    turns: rows.length,
    totalSupplyRegret,
    meanSupplyRegret: rows.length ? totalSupplyRegret / rows.length : 0,
    positiveShare: rows.length ? rows.filter((r) => r.supplyRegret > 0).length / rows.length : 0,
    totalAeffRegret,
    cancelAbsorbedRegret: totalAeffRegret - totalSupplyRegret,
    chosenOutgoing: rows.reduce((n, r) => n + r.chosenOutgoing, 0),
    maxCandidateOutgoing: rows.reduce((n, r) => n + r.maxCandidateOutgoing, 0),
    chosenSendingShare: rows.length ? rows.filter((r) => r.chosenSends).length / rows.length : 0,
    anyCandidateSendingShare: rows.length ? rows.filter((r) => r.anyCandidateSends).length / rows.length : 0,
    missedSendTurns: rows.filter((r) => r.missedSend).length,
    missedSpinPremiumTurns: rows.filter((r) => r.missedSpinPremium).length,
    bySubBand,
    byChosenLines,
    byMaxOutgoingSpin,
    opponentPending: { knownTurns, withPending, withoutPending },
  };
}
