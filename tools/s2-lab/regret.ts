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
  /** Candidates that are spin clears (mini/normal), any attack value.
   * HS1 stage-0 addition: D3 (setup absence) needs to know whether a spin
   * clear existed in the candidate set at all, which the argmax spin
   * labels alone cannot express. */
  readonly spinCandidateCount: number;
  readonly anySpinCandidate: boolean;
  /** Aeff-basis spin miss: the highest-Aeff candidate was a spin clear,
   * the chosen move was not, and aeffRegret > 0. (missedSpinPremium is
   * the outgoing-argmax analogue.) */
  readonly missedSpinPremiumAeff: boolean;
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
  let spinCandidateCount = 0;
  for (const c of result.candidates) {
    if (c.attack > maxAeff.attack) maxAeff = c;
    if (outgoingOf(c.attack, pendingBefore) > outgoingOf(maxOut.attack, pendingBefore)) maxOut = c;
    if (outgoingOf(c.attack, pendingBefore) > 0) sendingCandidateCount += 1;
    if (isSpinLabel(supplySpinLabel(c.spin))) spinCandidateCount += 1;
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
    spinCandidateCount,
    anySpinCandidate: spinCandidateCount > 0,
    missedSpinPremiumAeff:
      aeffRegret > 0 && isSpinLabel(supplySpinLabel(maxAeff.spin)) && !isSpinLabel(chosenSpin),
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
/* HS1 stage-0 decomposition (HS1-DESIGN-2026-11-24 §3.1–§3.2).        */
/*                                                                     */
/* Splits the supply regret of locks 10–39 (all turns) into:           */
/*   D1 frequency regret — chosen Aeff = 0 but max candidate Aeff > 0  */
/*      ("a clear existed and was not played"); the D1 quantity is     */
/*      the sum of those candidates' max Aeff.                         */
/*   D2 yield regret — chosen Aeff > 0: sum of aeffRegret, with the    */
/*      spin-miss part (missedSpinPremiumAeff) separated, plus the     */
/*      opportunity-turn (pendingBefore > 0) subset so the overlap     */
/*      with the processing-side instrument stays cuttable.            */
/*   D3 setup absence — turns whose candidate max Aeff = 0, or whose   */
/*      candidate set contained no spin clear at all (share of all     */
/*      turns). What D1+D2 cannot explain falls here.                  */
/*                                                                     */
/* The §3.2 judgement is on the Aeff basis (denominator: the 10–39     */
/* production gap, +580 rows over 102 loss games in SUPPLY-DECOMPOSE   */
/* §3); outgoing-basis totals are reported alongside as a cross-check  */
/* (denominator there: the sending gap, +532).                         */
/* Pure aggregation over SupplyRegretRow[] — no I/O, no search.        */
/* ------------------------------------------------------------------ */

export interface Hs1Bucket {
  turns: number;
  /** Sum of maxCandidateAeff over the bucket's turns. */
  sumMaxAeff: number;
  /** Sum of aeffRegret over the bucket's turns. */
  sumAeffRegret: number;
  /** Sum of supplyRegret (outgoing basis) over the bucket's turns. */
  sumSupplyRegret: number;
}

function emptyBucket(): Hs1Bucket {
  return { turns: 0, sumMaxAeff: 0, sumAeffRegret: 0, sumSupplyRegret: 0 };
}
function addBucket(b: Hs1Bucket, r: SupplyRegretRow): void {
  b.turns += 1;
  b.sumMaxAeff += r.maxCandidateAeff;
  b.sumAeffRegret += r.aeffRegret;
  b.sumSupplyRegret += r.supplyRegret;
}
function addBucketMap(map: Record<string, Hs1Bucket>, key: string, r: SupplyRegretRow): void {
  addBucket((map[key] ??= emptyBucket()), r);
}

export interface Hs1Decomposition {
  turns: number;
  d1: Hs1Bucket & {
    bySubBand: Record<string, Hs1Bucket>;
    /** Keyed by the missed candidate's lines (maxAeffLines). */
    byMaxLines: Record<string, Hs1Bucket>;
  };
  d2: Hs1Bucket & {
    spinMissTurns: number;
    spinMissAeffRegret: number;
    spinMissSupplyRegret: number;
    /** Subset of D2 on opportunity turns (pendingBefore > 0): the part
     * that overlaps the processing-side regret instrument. */
    opportunity: Hs1Bucket;
  };
  d3: {
    /** Candidate max Aeff = 0: no clear existed at all. */
    noCandidateTurns: number;
    /** No spin clear anywhere in the candidate set. */
    noSpinCandidateTurns: number;
    /** Union per §3.1: max Aeff = 0 OR no spin candidate. */
    absentTurns: number;
    absentShare: number;
    noSpinShare: number;
  };
  /** D1+D2 restricted to turns where a spin clear existed in the
   * candidate set (the §3.2 exploration-side condition). */
  spinPresentRegret: Hs1Bucket;
  totalAeffRegret: number;
  totalSupplyRegret: number;
}

export function summariseHs1Decomposition(rows: readonly SupplyRegretRow[]): Hs1Decomposition {
  const d1BySubBand: Record<string, Hs1Bucket> = {};
  const d1ByMaxLines: Record<string, Hs1Bucket> = {};
  const d1 = { ...emptyBucket(), bySubBand: d1BySubBand, byMaxLines: d1ByMaxLines };
  const d2Opp = emptyBucket();
  const d2 = {
    ...emptyBucket(),
    spinMissTurns: 0,
    spinMissAeffRegret: 0,
    spinMissSupplyRegret: 0,
    opportunity: d2Opp,
  };
  let noCandidateTurns = 0;
  let noSpinCandidateTurns = 0;
  let absentTurns = 0;
  const spinPresentRegret = emptyBucket();
  for (const r of rows) {
    if (r.chosenAeff === 0 && r.maxCandidateAeff > 0) {
      addBucket(d1, r);
      addBucketMap(d1BySubBand, subBandKey(r.lockIndex), r);
      addBucketMap(d1ByMaxLines, String(r.maxAeffLines), r);
    }
    if (r.chosenAeff > 0) {
      addBucket(d2, r);
      if (r.missedSpinPremiumAeff) {
        d2.spinMissTurns += 1;
        d2.spinMissAeffRegret += r.aeffRegret;
        d2.spinMissSupplyRegret += r.supplyRegret;
      }
      if (r.opportunity) addBucket(d2Opp, r);
    }
    const noCand = r.maxCandidateAeff === 0;
    const noSpin = !r.anySpinCandidate;
    if (noCand) noCandidateTurns += 1;
    if (noSpin) noSpinCandidateTurns += 1;
    if (noCand || noSpin) absentTurns += 1;
    if (r.anySpinCandidate && (r.chosenAeff === 0 ? r.maxCandidateAeff > 0 : r.chosenAeff > 0)) {
      // Spin-present explained pool (§3.2 exploration row): for D1 turns
      // the explained amount is the missed candidate's max Aeff, for D2
      // turns it is the aeffRegret; both are accumulated into
      // sumAeffRegret so the pool is one comparable number.
      spinPresentRegret.turns += 1;
      spinPresentRegret.sumMaxAeff += r.maxCandidateAeff;
      spinPresentRegret.sumAeffRegret += r.chosenAeff === 0 ? r.maxCandidateAeff : r.aeffRegret;
      spinPresentRegret.sumSupplyRegret += r.supplyRegret;
    }
  }
  const n = rows.length;
  return {
    turns: n,
    d1,
    d2,
    d3: {
      noCandidateTurns,
      noSpinCandidateTurns,
      absentTurns,
      absentShare: n ? absentTurns / n : 0,
      noSpinShare: n ? noSpinCandidateTurns / n : 0,
    },
    spinPresentRegret,
    totalAeffRegret: rows.reduce((s, r) => s + r.aeffRegret, 0),
    totalSupplyRegret: rows.reduce((s, r) => s + r.supplyRegret, 0),
  };
}

/** §3.2 pre-registered judgement (Aeff basis). `productionGap` is the
 * 10–39 band production gap in rows (SUPPLY §3: 580). Returns the single
 * pre-selected mechanism key, or "setup" / "undecidable". The caller
 * supplies rows from ONE replay population; mixing populations is the
 * caller's error, not checked here. */
export function judgeHs1(
  d: Hs1Decomposition,
  productionGap: number,
): "HS1-A" | "HS1-A-spin" | "HS1-C" | "HS1-B" | "undecidable" {
  const half = productionGap / 2;
  if (d.d1.sumMaxAeff > half) return "HS1-A";
  if (d.d1.sumMaxAeff + d.d2.sumAeffRegret > half) {
    return d.d2.spinMissAeffRegret >= d.d2.sumAeffRegret / 2 ? "HS1-A-spin" : "undecidable";
  }
  if (d.spinPresentRegret.sumAeffRegret > half) return "HS1-C";
  if (d.d3.noSpinShare > 0.5) return "HS1-B";
  return "undecidable";
}

// ---------------------------------------------------------------------------
// R2 stage-2 premium instrument (R2-STAGE2-DESIGN-2026-11-24 §4).
//
// Question it separates, for NON-opportunity turns (pendingBefore = 0) in
// the mid bands (100-159 / 160-199 / 200+): was the premium clear
// (a) present among the evaluated candidates but not chosen (selection ->
// SB-1, or SB-2 when the regret concentrates in lines 1/2), or
// (b) absent from the candidate set altogether (board construction ->
// SB-3)?
//
// Basis: referee Aeff (cancelled + outgoingAfterCancel), the same basis as
// the stage-1 premium residual and the attax-regret-rerun driver (#6885).
// premium(aeff, lines) = max(0, aeff - LINE_BASE[lines]) with the
// original-source line base [0,0,1,2,4,5] (rules.ts awardLock tetrio-s2
// non-spin table; garbage.ts LINE_BASE agrees for lines 0-4).
//
// Recording rule: every attax turn (all locks, any pending). Banding and
// the pendingBefore = 0 slice are aggregation concerns, so the driver can
// call this unconditionally. Pure: no I/O, no weights, no search.

export const LINE_BASE_S2: readonly number[] = [0, 0, 1, 2, 4, 5];

export function premiumOf(aeff: number, lines: number): number {
  const base = LINE_BASE_S2[Math.min(Math.max(lines, 0), 5)] ?? 0;
  return Math.max(0, aeff - base);
}

export interface PremiumCandidateLike {
  readonly aeff: number;
  readonly lines: number;
  readonly spin?: string;
}

export interface PremiumRegretRow {
  readonly lockIndex: number;
  readonly pendingBefore: number;
  readonly chosenAeff: number;
  readonly chosenLines: number;
  readonly chosenSpin: string;
  readonly chosenPremium: number;
  readonly maxPremium: number;
  readonly maxPremiumLines: number;
  readonly maxPremiumSpin: string;
  /** maxPremium - chosenPremium (>= 0). */
  readonly premiumRegret: number;
  readonly anyPremiumCandidate: boolean;
  readonly premiumCandidateCount: number;
  readonly candidateCount: number;
  readonly evaluatedCandidates: number;
  readonly skippedCandidates: number;
}

export function premiumRegretRow(
  chosen: PremiumCandidateLike,
  candidates: readonly PremiumCandidateLike[],
  lockIndex: number,
  pendingBefore: number,
  evaluatedCandidates = candidates.length,
  skippedCandidates = 0,
): PremiumRegretRow {
  const chosenPremium = premiumOf(chosen.aeff, chosen.lines);
  let maxPremium = chosenPremium;
  let maxPremiumLines = chosen.lines;
  let maxPremiumSpin = chosen.spin ?? "none";
  let premiumCandidateCount = chosenPremium > 0 ? 1 : 0;
  for (const c of candidates) {
    const p = premiumOf(c.aeff, c.lines);
    if (p > 0) premiumCandidateCount += 1;
    if (p > maxPremium) {
      maxPremium = p;
      maxPremiumLines = c.lines;
      maxPremiumSpin = c.spin ?? "none";
    }
  }
  return {
    lockIndex,
    pendingBefore,
    chosenAeff: chosen.aeff,
    chosenLines: chosen.lines,
    chosenSpin: chosen.spin ?? "none",
    chosenPremium,
    maxPremium,
    maxPremiumLines,
    maxPremiumSpin,
    premiumRegret: maxPremium - chosenPremium,
    anyPremiumCandidate: maxPremium > 0,
    premiumCandidateCount,
    candidateCount: candidates.length + 1,
    evaluatedCandidates,
    skippedCandidates,
  };
}

export interface PremiumBandDecomposition {
  turns: number;
  /** D1: chosen premium = 0 (or no clear) but a premium candidate existed. */
  d1Turns: number;
  d1SumMaxPremium: number;
  /** D2: chosen was a clear (lines > 0); sum of premiumRegret over those. */
  d2Turns: number;
  d2SumRegret: number;
  /** D1+D2 regret total (D1 contributes its maxPremium). */
  explained: number;
  /** Share of D1+D2 attributed to max-premium candidates with lines 1/2. */
  lines12Share: number | null;
  regretByMaxLines: Record<string, number>;
  /** D3: share of turns with no premium candidate at all. */
  d3AbsentTurns: number;
  d3AbsentShare: number;
  spinMissTurns: number;
}

export function summarisePremiumBand(rows: readonly PremiumRegretRow[]): PremiumBandDecomposition {
  let d1Turns = 0, d1Sum = 0, d2Turns = 0, d2Sum = 0, absent = 0, spinMiss = 0;
  const byLines: Record<string, number> = {};
  const isSpin = (s: string) => s === "mini" || s === "normal";
  for (const r of rows) {
    if (!r.anyPremiumCandidate) absent += 1;
    if (r.chosenPremium === 0 && r.maxPremium > 0) {
      d1Turns += 1;
      d1Sum += r.maxPremium;
      byLines[String(r.maxPremiumLines)] = (byLines[String(r.maxPremiumLines)] ?? 0) + r.maxPremium;
      if (isSpin(r.maxPremiumSpin) && !isSpin(r.chosenSpin)) spinMiss += 1;
    } else if (r.chosenLines > 0) {
      d2Turns += 1;
      d2Sum += r.premiumRegret;
      if (r.premiumRegret > 0) {
        byLines[String(r.maxPremiumLines)] = (byLines[String(r.maxPremiumLines)] ?? 0) + r.premiumRegret;
        if (isSpin(r.maxPremiumSpin) && !isSpin(r.chosenSpin)) spinMiss += 1;
      }
    }
  }
  const explained = d1Sum + d2Sum;
  const l12 = (byLines["1"] ?? 0) + (byLines["2"] ?? 0);
  return {
    turns: rows.length,
    d1Turns, d1SumMaxPremium: d1Sum,
    d2Turns, d2SumRegret: d2Sum,
    explained,
    lines12Share: explained > 0 ? l12 / explained : null,
    regretByMaxLines: byLines,
    d3AbsentTurns: absent,
    d3AbsentShare: rows.length ? absent / rows.length : 0,
    spinMissTurns: spinMiss,
  };
}

/**
 * Preregistered stage-0 verdict (R2-STAGE2-DESIGN §4.2), per band then
 * combined: selection side requires explained >= half the denominator in
 * at least 2 of 3 mid bands; lines12Share >= 2/3 (same bands' pooled
 * share) selects SB-2 over SB-1; board side requires D3 absent share
 * over half in at least 2 of 3 bands when the selection side fails.
 */
export function judgePremiumStage0(
  bands: readonly { denominator: number; decomp: PremiumBandDecomposition }[],
): "SB-1" | "SB-2" | "SB-3" | "undecidable" {
  const selBands = bands.filter((b) => b.denominator > 0 && b.decomp.explained >= b.denominator / 2).length;
  if (selBands >= 2) {
    const totExpl = bands.reduce((n, b) => n + b.decomp.explained, 0);
    const tot12 = bands.reduce(
      (n, b) => n + (b.decomp.lines12Share ?? 0) * b.decomp.explained, 0);
    return totExpl > 0 && tot12 / totExpl >= 2 / 3 ? "SB-2" : "SB-1";
  }
  const d3Bands = bands.filter((b) => b.decomp.d3AbsentShare > 0.5).length;
  if (d3Bands >= 2) return "SB-3";
  return "undecidable";
}
