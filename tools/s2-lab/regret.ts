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

/* ------------------------------------------------------------------ */
/* Timing regret — I-1 (ALIGN-DESIGN-2026-11-24 §3.2).                  */
/*                                                                     */
/* The sender-side twin of the yield instrument: does attax leave      */
/* send timing on the table? Two components, per attax turn:           */
/*                                                                     */
/*   window-in  (opponent pending > 0): maxCandidateOutgoing −         */
/*     chosenOutgoing — send that could have landed inside the         */
/*     opponent's pending window but did not.                          */
/*   window-out (opponent pending = 0): the chosen outgoing itself,    */
/*     counted only when a zero-outgoing alternative existed whose     */
/*     value loss was small — the send could have been deferred.       */
/*                                                                     */
/* Spec gap, recorded honestly: §3.2 says "value loss at or below the   */
/* registered threshold" but no numeric threshold is registered        */
/* anywhere in the design. This instrument therefore records the       */
/* value loss itself on every row (`bestZeroOutgoingValueLoss`,        */
/* `maxOutgoingValueLoss`) and the summary takes the threshold as an   */
/* explicit argument, so the §3.2 judgement (total timing regret vs    */
/* window-out outgoing: >= 25% -> On-1, < 10% -> close, else secretary)*/
/* can be evaluated at any threshold deterministically from the rows.  */
/* Nothing is estimated: rows with unknown opponent pending carry      */
/* null and are excluded from both components.                         */
/*                                                                     */
/* Recording scope (§3.2): every attax turn; the judgement band is     */
/* locks 0–39, and rows outside it are still recorded (the summary     */
/* reports the band separately). Own pending is NOT a condition.       */
/* `opponentPendingBefore` is driver-supplied (the search cannot know  */
/* it — ALIGN-G0-CHECK-2026-11-24: observable at the driver layer      */
/* only). Pure like the rest of this module.                           */
/* ------------------------------------------------------------------ */

export const TIMING_BAND_LO = 0;
export const TIMING_BAND_HI = 40; // exclusive: locks 0–39 is the judgement band

/** Minimal structural view of a candidate for the timing instrument. */
export interface TimingCandidateLike {
  readonly attack: number;
  /** Search value of the best line starting with this candidate. */
  readonly value: number;
}

/** Minimal structural view of a decided turn's search result. */
export interface TimingSearchLike {
  /** Value of the chosen line (SearchResult.value). */
  readonly value: number;
  readonly best: { readonly attack: number };
  /** Candidates in value order, best first (as search.ts returns them). */
  readonly candidates: readonly TimingCandidateLike[];
}

export interface TimingRegretRow {
  readonly lockIndex: number;
  readonly pendingBefore: number;
  /** Opponent's pending at turn start when the driver knows it, else null. */
  readonly opponentPendingBefore: number | null;
  readonly chosenOutgoing: number;
  readonly maxCandidateOutgoing: number;
  /** Value rank (0 = best) of the highest-outgoing candidate. */
  readonly maxOutgoingValueRank: number;
  /** best value − value of the highest-outgoing candidate (>= 0). */
  readonly maxOutgoingValueLoss: number;
  /** A candidate with outgoing = 0 exists in the evaluated set. */
  readonly hasZeroOutgoingCandidate: boolean;
  /** Smallest value loss among zero-outgoing candidates, else null. */
  readonly bestZeroOutgoingValueLoss: number | null;
  /** Window-in component (0 unless opponentPendingBefore > 0). */
  readonly timingRegretIn: number;
  /** Window-out send at stake (0 unless opponentPendingBefore = 0 and
   * the chosen move sent something). Threshold filtering happens in the
   * summary, via bestZeroOutgoingValueLoss. */
  readonly windowOutStake: number;
  readonly candidateCount: number;
}

/**
 * Build the timing-regret row for one decided turn, or null when the
 * search produced no candidates. Recorded for every lockIndex >= 0;
 * band membership is a summary concern, not a recording condition.
 */
export function timingRegretRow(
  result: TimingSearchLike,
  lockIndex: number,
  pendingBefore: number,
  opponentPendingBefore: number | null = null,
): TimingRegretRow | null {
  if (result.candidates.length === 0) return null;
  const chosenOutgoing = outgoingOf(result.best.attack, pendingBefore);
  let maxOut = result.candidates[0] as TimingCandidateLike;
  let maxOutRank = 0;
  let bestZeroLoss: number | null = null;
  result.candidates.forEach((c, i) => {
    const out = outgoingOf(c.attack, pendingBefore);
    if (out > outgoingOf(maxOut.attack, pendingBefore)) {
      maxOut = c;
      maxOutRank = i;
    }
    if (out === 0) {
      const loss = result.value - c.value;
      if (bestZeroLoss === null || loss < bestZeroLoss) bestZeroLoss = loss;
    }
  });
  const maxCandidateOutgoing = outgoingOf(maxOut.attack, pendingBefore);
  const inWindow = opponentPendingBefore !== null && opponentPendingBefore > 0;
  const outWindow = opponentPendingBefore === 0;
  return {
    lockIndex,
    pendingBefore,
    opponentPendingBefore,
    chosenOutgoing,
    maxCandidateOutgoing,
    maxOutgoingValueRank: maxOutRank,
    maxOutgoingValueLoss: result.value - maxOut.value,
    hasZeroOutgoingCandidate: bestZeroLoss !== null,
    bestZeroOutgoingValueLoss: bestZeroLoss,
    timingRegretIn: inWindow ? maxCandidateOutgoing - chosenOutgoing : 0,
    windowOutStake: outWindow && chosenOutgoing > 0 ? chosenOutgoing : 0,
    candidateCount: result.candidates.length,
  };
}

function timingSubBandKey(lockIndex: number): string {
  return lockIndex < 10 ? "0-9" : lockIndex < 20 ? "10-19" : lockIndex < 30 ? "20-29" : "30-39";
}

export interface TimingBandEntry {
  turns: number;
  timingRegretIn: number;
  timingRegretOut: number;
  windowOutOutgoing: number;
}

/**
 * §3.2 judgement summary over rows in the judgement band (locks 0–39).
 * `valueLossThreshold` is applied to the window-out component only:
 * a window-out turn counts its stake when a zero-outgoing alternative
 * exists with bestZeroOutgoingValueLoss <= threshold. Pass Infinity
 * for the unfiltered upper bound. The share's denominator is the
 * measured window-out outgoing of the same rows (the design's
 * ≈1564-line figure is the same quantity on the loss population,
 * locks 0–39; the summary reports the measured one).
 */
export function summariseTimingRegret(
  rows: readonly TimingRegretRow[],
  valueLossThreshold: number,
): {
  turns: number;
  knownOpponentTurns: number;
  timingRegretIn: number;
  timingRegretOut: number;
  timingRegretTotal: number;
  windowOutOutgoing: number;
  /** timingRegretTotal / windowOutOutgoing (null when denominator is 0). */
  shareOfWindowOut: number | null;
  /** §3.2 fixed bands: "on1" (>= 25%), "close" (< 10%), "secretary" (between). */
  verdictBand: "on1" | "close" | "secretary" | null;
  bySubBand: Record<string, TimingBandEntry>;
} {
  const band = rows.filter((r) => r.lockIndex >= TIMING_BAND_LO && r.lockIndex < TIMING_BAND_HI);
  const bySubBand: Record<string, TimingBandEntry> = {};
  let timingRegretIn = 0;
  let timingRegretOut = 0;
  let windowOutOutgoing = 0;
  let knownOpponentTurns = 0;
  for (const r of band) {
    const e = (bySubBand[timingSubBandKey(r.lockIndex)] ??= {
      turns: 0,
      timingRegretIn: 0,
      timingRegretOut: 0,
      windowOutOutgoing: 0,
    });
    e.turns += 1;
    if (r.opponentPendingBefore !== null) knownOpponentTurns += 1;
    const out = r.windowOutStake > 0 && r.bestZeroOutgoingValueLoss !== null && r.bestZeroOutgoingValueLoss <= valueLossThreshold
      ? r.windowOutStake
      : 0;
    timingRegretIn += r.timingRegretIn;
    timingRegretOut += out;
    e.timingRegretIn += r.timingRegretIn;
    e.timingRegretOut += out;
    if (r.opponentPendingBefore === 0) {
      windowOutOutgoing += r.chosenOutgoing;
      e.windowOutOutgoing += r.chosenOutgoing;
    }
  }
  const timingRegretTotal = timingRegretIn + timingRegretOut;
  const shareOfWindowOut = windowOutOutgoing > 0 ? timingRegretTotal / windowOutOutgoing : null;
  return {
    turns: band.length,
    knownOpponentTurns,
    timingRegretIn,
    timingRegretOut,
    timingRegretTotal,
    windowOutOutgoing,
    shareOfWindowOut,
    verdictBand: shareOfWindowOut === null ? null : shareOfWindowOut >= 0.25 ? "on1" : shareOfWindowOut < 0.1 ? "close" : "secretary",
    bySubBand,
  };
}
