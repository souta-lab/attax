import type { PieceKind } from "../../core/pieces.js";

const KINDS: readonly PieceKind[] = ["I", "O", "T", "S", "Z", "J", "L"];

/** Tracks observations, including previews, rather than pieces placed from hold. */
export class BagTracker {
  private previous: readonly PieceKind[] = [];
  private remaining = new Set(KINDS);
  private valid = true;
  private seeded = false;

  reset(): void {
    this.previous = [];
    this.remaining = new Set(KINDS);
    this.valid = true;
    this.seeded = false;
  }

  /** TBP provides the remaining bag after the entire visible queue on resync. */
  seed(remaining: readonly PieceKind[]): void {
    this.reset();
    this.remaining = new Set(remaining);
    this.seeded = true;
  }

  observe(sequence: readonly PieceKind[]): readonly PieceKind[] {
    if (this.seeded) {
      this.previous = [...sequence];
      this.seeded = false;
      return this.remaining.size === 0 ? KINDS : [...this.remaining];
    }
    let overlap = Math.min(this.previous.length, sequence.length);
    while (overlap > 0 && !this.previous.slice(-overlap).every((piece, i) => piece === sequence[i]))
      overlap -= 1;
    // A discontinuous snapshot cannot establish the bag boundary honestly.
    if (this.previous.length > 0 && overlap === 0) this.valid = false;
    for (const piece of sequence.slice(overlap)) {
      if (this.remaining.size === 0) this.remaining = new Set(KINDS);
      if (!this.remaining.delete(piece)) this.valid = false;
    }
    this.previous = [...sequence];
    if (!this.valid) return [];
    return this.remaining.size === 0 ? KINDS : [...this.remaining];
  }
}
