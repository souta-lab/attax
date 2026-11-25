/**
 * Deterministic 7-bag continuation for the TBP adapter (ATTAX_TBP_BAG_FILL).
 *
 * The gauntlet referee reveals only 6 pieces (active + 5 preview), so a
 * horizon past 6 pieces must model the unseen tail. Under the Guideline
 * 7-bag randomizer the unseen tail is partly *known*: the pieces not yet
 * dealt from the current bag are an exact set, and every following bag
 * contains one of each piece. This tracker reconstructs that model from
 * public TBP traffic only (the `start` queue and `new_piece` messages,
 * plus the adapter's own queue consumption), the same information Hoiko's
 * adapter-side NextState replica uses (src/ai/hoiko/next.ts).
 *
 * The continuation is a single deterministic sequence (K = 1): the current
 * bag's remaining pieces in the canonical fill order, then each following
 * bag in the same order. No randomness, no wall clock — the same message
 * stream always yields the same fill.
 */

export type BagKind = "I" | "O" | "T" | "S" | "Z" | "J" | "L";

/** Canonical fill order, Hoiko NextMino's bag sequence (Z,S,T,O,J,L,I). */
export const BAG_ORDER: readonly BagKind[] = ["Z", "S", "T", "O", "J", "L", "I"];

const BAG_SIZE = 7;

export class BagTracker {
  /** Every piece dealt so far this match, in deal order. */
  private dealt: BagKind[] = [];
  /** How many of `dealt` the adapter's queue has already consumed. */
  private consumed = 0;

  /** A fresh match starts: the start queue is the whole dealt sequence. */
  startFresh(queue: readonly BagKind[]): void {
    this.dealt = [...queue];
    this.consumed = 0;
  }

  /**
   * A garbage-resync start (preceded by `stop`): the queue it carries
   * replaces the unconsumed tail of the dealt sequence; the consumed
   * prefix — and with it the bag phase — is preserved.
   */
  startResync(queue: readonly BagKind[]): void {
    const kept = Math.min(this.consumed, this.dealt.length);
    this.dealt = [...this.dealt.slice(0, kept), ...queue];
    this.consumed = kept;
  }

  /** One more piece was revealed (dealt) via `new_piece`. */
  noteNewPiece(piece: BagKind): void {
    this.dealt.push(piece);
  }

  /** One piece was consumed from the head of the adapter's queue. */
  noteConsumed(): void {
    this.consumed += 1;
  }

  /**
   * The next `count` pieces the randomizer will deal after the last one
   * already revealed: the current bag's remaining pieces in canonical
   * order, then whole bags in canonical order. Empty before any piece
   * has been seen.
   */
  continuation(count: number): BagKind[] {
    const n = this.dealt.length;
    if (n === 0 || count <= 0) return [];
    // The current bag is the 7-piece window of the dealt sequence that
    // holds the newest piece (a fresh match starts on a fresh bag).
    const windowStart = BAG_SIZE * Math.floor((n - 1) / BAG_SIZE);
    let inBag = new Set(this.dealt.slice(windowStart));
    if (inBag.size !== n - windowStart) {
      // A duplicate inside one bag window means the phase desynced
      // (e.g. a resync whose queue did not continue the tracked tail).
      // Self-heal on the longest distinct suffix: the most recent
      // consistent anchor for "dealt in the current bag".
      inBag = new Set();
      for (let i = n - 1; i >= 0; i -= 1) {
        const piece = this.dealt[i] as BagKind;
        if (inBag.has(piece)) break;
        inBag.add(piece);
      }
    }
    const out: BagKind[] = BAG_ORDER.filter((k) => !inBag.has(k));
    while (out.length < count) out.push(...BAG_ORDER);
    return out.slice(0, count);
  }
}
