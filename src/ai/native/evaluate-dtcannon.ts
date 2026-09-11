/** EvaluateAI.SearchDTCannon + lambdas (SPEC_EvaluateAI §6, binary 12829). */

import type { GamePack } from "./gamepack.js";
import { trustNext } from "./evaluate-trust.js";
import { WI, weightAt } from "./weight-index.js";

interface W {
  readonly weight: readonly number[];
}

function lambda23b(g: GamePack, base: number, idx: number): boolean {
  return (
    (g.board.rowAt(base + 5) & (240 >> idx)) === 0 &&
    (g.board.rowAt(base + 6) & (224 >> idx)) === (128 >> idx)
  );
}

function lambdaE8ff(g: GamePack, base: number, idx: number): boolean {
  return (
    (g.board.rowAt(base + 5) & (1920 >> idx)) === 0 &&
    (g.board.rowAt(base + 6) & (896 >> idx)) === (128 >> idx)
  );
}

export function searchDTCannon(g: GamePack, ch: Int32Array, y0: number, ew: W): number {
  const line = (y: number): number => g.board.rowAt(y);
  const w = (i: number): number => weightAt(ew, i);
  let trust = trustNext(g);

  let b = (ch[8] ?? 0) - 4;
  if (
    b >= 0 &&
    (line(b) | 4) === 1023 &&
    (line(b + 1) | 4) === 1023 &&
    (line(b + 2) & 0x1f) === 17 &&
    (line(b + 3) & 0xf) === 9 &&
    (line(b + 4) & 7) === 3
  ) {
    if ((line(b + 5) & 7) !== 0) return 0;
    let n = w(WI.TstHole);
    if (lambda23b(g, b, 5)) {
      n += w(WI.TstSpinable);
      const lo = Math.max(b - 1, y0);
      const d = b - lo + 4;
      if (d <= 2) n -= ((ch[7] ?? 0) - (b + 2) * 2 + (ch[6] ?? 0)) * w(WI.DonateCover);
      if (d > 0) {
        let dd = Math.min(3, d);
        dd = (1 << (dd - 1)) + ((ch[7] ?? 0) - b - 4) * dd - 1;
        n -= w(WI.Pierce) * dd;
      }
      if ((line(b + 3) & 0xf) === 0) n -= ((ch[6] ?? 0) - b - 3) * w(WI.Pierce);
    }
    trust = trustNext(g);
    if (b > 0) {
      const r = line(b - 1);
      if ((r | 2) === 1023 && trust > 1) n += w(WI.TDHole);
      if ((r & 4) === 0) n += w(WI.TstOffensive);
    }
    if ((line(b) | 4) === 1023 && trust > 1) n += w(WI.TstClearable);
    if ((line(b + 1) | 4) === 1023) n += w(WI.TstClearable);
    if ((line(b + 2) | 0xe) === 1023) n += w(WI.TstClearable);
    if ((line(b + 3) | 6) === 1023) {
      if (trust > 1) n += w(WI.TstClearable);
      n -= w(WI.Anabara);
    }
    if ((line(b + 4) | 4) === 1023) {
      if (trust > 1) n += w(WI.TstClearable);
      n -= w(WI.Anabara);
    }
    return n >> (trust <= 0 ? 1 : 0);
  }

  b = (ch[1] ?? 0) - 4;
  if (
    b >= 0 &&
    (line(b) | 0x80) === 1023 &&
    (line(b + 1) | 0x80) === 1023 &&
    (line(b + 2) & 0x3e0) === 544 &&
    (line(b + 3) & 0x3c0) === 576 &&
    (line(b + 4) & 0x380) === 768
  ) {
    if ((line(b + 5) & 0x780) !== 0) return 0;
    let n = w(WI.TstHole);
    if (lambdaE8ff(g, b, 0)) {
      n += w(WI.TstSpinable);
      const lo = Math.max(b - 1, y0);
      const d = b - lo + 4;
      if (d <= 2) n -= ((ch[3] ?? 0) - (b + 2) * 2 + (ch[2] ?? 0)) * w(WI.DonateCover);
      if (d > 0) {
        let dd = Math.min(3, d);
        dd = (1 << (dd - 1)) + ((ch[3] ?? 0) - b - 4) * dd - 1;
        n -= w(WI.Pierce) * dd;
      }
      if ((line(b + 3) & 0x3c0) === 0) n -= ((ch[3] ?? 0) - b - 3) * w(WI.Pierce);
    }
    trust = trustNext(g);
    if (b > 0) {
      const r = line(b - 1);
      if ((r | 0x100) === 1023 && trust > 1) n += w(WI.TDHole);
      if ((r & 0x80) === 0) n += w(WI.TstOffensive);
    }
    if ((line(b) | 0x80) === 1023 && trust > 1) n += w(WI.TstClearable);
    if ((line(b + 1) | 0x80) === 1023) n += w(WI.TstClearable);
    if ((line(b + 2) | 0x1c0) === 1023) n += w(WI.TstClearable);
    if ((line(b + 3) | 0x180) === 1023) {
      if (trust > 1) n += w(WI.TstClearable);
      n -= w(WI.Anabara);
    }
    if ((line(b + 4) | 0x80) === 1023) {
      if (trust > 1) n += w(WI.TstClearable);
      n -= w(WI.Anabara);
    }
    return n >> (trust <= 0 ? 1 : 0);
  }
  return 0;
}
