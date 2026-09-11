/**
 * Native EvaluateAI.SearchTsd / SearchTst + lambdas (SPEC_EvaluateAI §4-§5).
 * SearchTst delegates to SearchDTCannon first, then scans the two TST families
 * and the 4-row TDHint pattern, each scaled by the shared `trustNext` gate.
 */

import { log2 } from "./board.js";
import type { GamePack } from "./gamepack.js";
import { searchDTCannon } from "./evaluate-dtcannon.js";
import { trustNext } from "./evaluate-trust.js";
import { MINO_T } from "./shapes.js";
import { WI, weightAt } from "./weight-index.js";

interface W {
  readonly weight: readonly number[];
}

function tsdPierce(ch: Int32Array, y: number, off: number, mask: number, line: (yy: number) => number): number {
  let m = line(y - 1) | mask;
  if (m === 1023) return 0;
  m ^= 1023;
  let mx = 0;
  while (m !== 0) {
    const b = m & -m;
    mx = Math.max(mx, (ch[log2(b)] ?? 0) - y + 1);
    m &= ~b;
  }
  if (off < 2) mx -= 1;
  if (mx > 2) mx = 4 - mx;
  return mx > 0 ? mx : 0;
}

export function searchTsd(g: GamePack, ch: Int32Array, y0: number, ew: W): number {
  const line = (y: number): number => g.board.rowAt(y);
  const w = (i: number): number => weightAt(ew, i);
  let score = 0;

  let lim = Math.min(ch[0] ?? 0, ch[2] ?? 0) + 1;
  let start = Math.max(y0, (ch[1] ?? 0) + 1);
  for (let y = start; y < lim; y += 1) {
    const off = y - y0;
    if ((line(y) & 0x380) === 0x280) {
      if ((line(y + 1) & 0x380) === 0) {
        score += w(WI.TsdHole);
        if ((line(y + 2) & 0x380) === 0x080) score += w(WI.TsdSpinable);
        if (y > 0 && (line(y - 1) & 0x280) === 0x200) score += w(WI.TsdOffensive);
        let clearable = 0;
        if ((line(y) | 0x100) === 1023) clearable = 1;
        if ((line(y + 1) | 0x380) === 1023) clearable += 1;
        if (clearable > 0) {
          score += w(WI.TsdClearable) * clearable;
          if (y > 0 && y !== y0) score -= w(WI.Pierce) * tsdPierce(ch, y, off, 0x380, line);
        }
      }
    }
  }

  lim = Math.min(ch[9] ?? 0, ch[7] ?? 0) + 1;
  start = Math.max(y0, (ch[8] ?? 0) + 1);
  for (let y = start; y < lim; y += 1) {
    const off = y - y0;
    if ((line(y) & 7) === 5) {
      if ((line(y + 1) & 7) === 0) {
        score += w(WI.TsdHole);
        if ((line(y + 2) & 7) === 4) score += w(WI.TsdSpinable);
        if (y > 0 && (line(y - 1) & 5) === 1) score += w(WI.TsdOffensive);
        let clearable = 0;
        if ((line(y) | 2) === 1023) clearable = 1;
        if ((line(y + 1) | 7) === 1023) clearable += 1;
        if (clearable > 0) {
          score += w(WI.TsdClearable) * clearable;
          if (y > 0 && y !== y0) score -= w(WI.Pierce) * tsdPierce(ch, y, off, 7, line);
        }
      }
    }
  }

  for (let k = 0; k < 6; k += 1) {
    const limK = Math.min(ch[k + 1] ?? 0, ch[k + 3] ?? 0) + 1;
    const startK = Math.max(y0, (ch[k + 2] ?? 0) + 1);
    for (let y = startK; y < limK; y += 1) {
      const off = y - y0;
      const mA = 320 >> k;
      const mABC = 448 >> k;
      if ((line(y) & mABC) === mA) {
        if ((line(y + 1) & mABC) === 0) {
          score += w(WI.TsdHole);
          const v = line(y + 2) & mABC;
          if (v === 256 >> k) {
            score += w(WI.TsdSpinable);
            if (y > 0 && (line(y - 1) & mA) === 64 >> k) score += w(WI.TsdOffensive);
          } else if (v === 64 >> k) {
            score += w(WI.TsdSpinable);
            if (y > 0 && (line(y - 1) & mA) === 256 >> k) score += w(WI.TsdOffensive);
          }
          let clearable = 0;
          if (((128 >> k) | line(y)) === 1023) clearable = 1;
          if ((line(y + 1) | mABC) === 1023) clearable += 1;
          if (clearable > 0) {
            score += w(WI.TsdClearable) * clearable;
            if (y > 0 && y !== y0) score -= w(WI.Pierce) * tsdPierce(ch, y, off, mABC, line);
          }
        }
      }
    }
  }

  if (score !== 0) {
    if (g.hold.m === MINO_T) return score;
    for (let i = 0; i < 7; i += 1) if (g.nextIt.getAt(i) === MINO_T) return score;
    return score >> 1;
  }
  return score;
}

function lambda0dc(g: GamePack, row: number, idx: number): boolean {
  const m = 480 >> idx;
  const x = g.board.rowAt(row + 3) & m;
  if (x === 0 && (g.board.rowAt(row + 4) & (448 >> idx)) === 256 >> idx) return true;
  if (x === 32 >> idx && (g.board.rowAt(row + 4) & m) === 288 >> idx) return true;
  return false;
}

function lambda6695(g: GamePack, row: number, idx: number): boolean {
  return (
    (g.board.rowAt(row + 3) & (480 >> idx)) === 0 &&
    (g.board.rowAt(row + 4) & (448 >> idx)) === 256 >> idx
  );
}

function lambdaA670(g: GamePack, row: number, idx: number): boolean {
  // UNDETERMINED: SPEC_EvaluateAI §9.1 — masks 1920/1024/1152 set bit 10, which
  // Board.line never has; transcribed verbatim (masking to 0x3ff is equivalent).
  const m = 1920 >> idx;
  const x = g.board.rowAt(row + 3) & m;
  if (x === 0 && (g.board.rowAt(row + 4) & (896 >> idx)) === 128 >> idx) return true;
  if (x === 1024 >> idx && (g.board.rowAt(row + 4) & m) === 1152 >> idx) return true;
  return false;
}

function lambda0efe(g: GamePack, row: number, idx: number): boolean {
  return (
    (g.board.rowAt(row + 3) & (1920 >> idx)) === 0 &&
    (g.board.rowAt(row + 4) & (896 >> idx)) === 128 >> idx
  );
}

export function searchTst(g: GamePack, ch: Int32Array, y0: number, minHeight: number, ew: W): number {
  const line = (y: number): number => g.board.rowAt(y);
  const w = (i: number): number => weightAt(ew, i);
  const dtc = searchDTCannon(g, ch, y0, ew);
  if (dtc !== 0) return dtc;

  for (let idx = 0; idx < 7; idx += 1) {
    const row = (ch[idx + 2] ?? 0) - 2;
    if (row < 0) continue;
    const r = line(row);
    if (((r >> (7 - idx)) & 7) === 5) {
      if (
        (line(row + 1) & (896 >> idx)) === 512 >> idx &&
        (line(row + 2) & (384 >> idx)) === 128 >> idx
      ) {
        const x = line(row + 3) & (480 >> idx);
        if (x !== 0) {
          const t = 32 >> idx;
          if (x !== t || (line(row + 4) & (224 >> idx)) !== t) continue;
        }
        let n = w(WI.TstHole);
        if (lambda0dc(g, row, idx)) {
          n += w(WI.TstSpinable);
          const d = row - Math.max(row - 1, y0) + 2;
          if (d <= 0) n -= ((ch[idx + 1] ?? 0) - row) * w(WI.DonateCover);
          else n -= ((1 << (d - 1)) + ((ch[idx + 1] ?? 0) - row - 2) * d - 1) * w(WI.Pierce);
          if ((line(row + 3) & (960 >> idx)) === 0)
            n -= ((ch[idx] ?? 0) - row - 3) * w(WI.Pierce);
        }
        let bits = 0;
        const c = 256 >> idx;
        if ((line(row) | c) === 1023) {
          n += w(WI.TstClearable);
          bits = 1;
        }
        if ((line(row + 1) | (384 >> idx)) === 1023) {
          n += w(WI.TstClearable);
          bits |= 2;
        }
        if ((line(row + 2) | c) === 1023) {
          n += w(WI.TstClearable) - w(WI.Anabara);
          bits |= 4;
        }
        const tr = trustNext(g);
        bits += 1;
        if (tr > 1 && (bits - (-bits & bits)) === 0) {
          if (row <= 0) return n >> (tr <= 0 ? 1 : 0);
          if ((line(row - 1) | (128 >> idx)) === 1023) n += w(WI.TDHole);
        }
        if (row > 0 && (line(row - 1) & (256 >> idx)) === 0) n += w(WI.TstOffensive);
        return n >> (tr <= 0 ? 1 : 0);
      }
    } else if (
      idx === 6 &&
      row > 0 &&
      (line(row + 1) ^ 6) === 1023 &&
      (line(row - 1) | 2) === 1023 &&
      (r & 0xe) === 8 &&
      (line(row + 2) & 6) === 2 &&
      (line(row + 3) & 7) === 0
    ) {
      let n = w(WI.TstHole);
      if (lambda6695(g, row, idx)) {
        n += w(WI.TstSpinable);
        const d = row - Math.max(row - 1, y0) + 2;
        if (d <= 0) n -= ((ch[idx + 1] ?? 0) - row) * w(WI.DonateCover);
        else n -= ((1 << (d - 1)) + ((ch[idx + 1] ?? 0) - row - 2) * d - 1) * w(WI.Pierce);
      } else {
        n += w(WI.BadRoof) * -2;
      }
      const tr = trustNext(g);
      if ((line(row) | (384 >> idx)) === 1023 && tr > 1) n += w(WI.TstClearable);
      if ((line(row + 2) | (256 >> idx)) === 1023) n += w(WI.TstClearable) - w(WI.Anabara);
      return n >> (tr <= 0 ? 1 : 0);
    }
  }

  for (let idx = 0; idx < 7; idx += 1) {
    const row = (ch[idx + 1] ?? 0) - 2;
    if (row < 0) continue;
    const r = line(row);
    if (((r >> (6 - idx)) & 7) === 5) {
      if (
        (line(row + 1) & (448 >> idx)) === 64 >> idx &&
        (line(row + 2) & (384 >> idx)) === 256 >> idx
      ) {
        const x = line(row + 3) & (1920 >> idx);
        if (x !== 0) {
          const t = 1024 >> idx;
          if (x !== t || (line(row + 4) & (1792 >> idx)) !== t) continue;
        }
        let n = w(WI.TstHole);
        if (lambdaA670(g, row, idx)) {
          n += w(WI.TstSpinable);
          const d = row - Math.max(row - 1, y0) + 2;
          if (d <= 0) n -= ((ch[idx + 2] ?? 0) - row) * w(WI.DonateCover);
          else n -= ((1 << (d - 1)) + ((ch[idx + 2] ?? 0) - row - 2) * d - 1) * w(WI.Pierce);
          if ((line(row + 3) & (960 >> idx)) === 0)
            n -= ((ch[idx + 3] ?? 0) - row - 3) * w(WI.Pierce);
        }
        let bits = 0;
        const c = 128 >> idx;
        if ((line(row) | c) === 1023) {
          n += w(WI.TstClearable);
          bits = 1;
        }
        if ((line(row + 1) | (384 >> idx)) === 1023) {
          n += w(WI.TstClearable);
          bits |= 2;
        }
        if ((line(row + 2) | c) === 1023) {
          n += w(WI.TstClearable) - w(WI.Anabara);
          bits |= 4;
        }
        const tr = trustNext(g);
        bits += 1;
        if (tr > 1 && (bits - (-bits & bits)) === 0) {
          if (row <= 0) return n >> (tr <= 0 ? 1 : 0);
          if ((line(row - 1) | (256 >> idx)) === 1023) n += w(WI.TDHole);
        }
        if (row > 0 && (line(row - 1) & (128 >> idx)) === 0) n += w(WI.TstOffensive);
        return n >> (tr <= 0 ? 1 : 0);
      }
    } else if (
      idx === 0 &&
      row > 0 &&
      (line(row + 1) ^ 0x180) === 1023 &&
      (line(row - 1) | 0x100) === 1023 &&
      (r & 0x1c0) === 64 &&
      (line(row + 2) & 0x180) === 256 &&
      (line(row + 3) & 0x780) === 0
    ) {
      let n = w(WI.TstHole);
      if (lambda0efe(g, row, idx)) {
        n += w(WI.TstSpinable);
        const d = row - Math.max(row - 1, y0) + 2;
        if (d <= 0) n -= ((ch[idx + 2] ?? 0) - row) * w(WI.DonateCover);
        else n -= ((1 << (d - 1)) + ((ch[idx + 2] ?? 0) - row - 2) * d - 1) * w(WI.Pierce);
      } else {
        n += w(WI.BadRoof) * -2;
      }
      const tr = trustNext(g);
      if ((line(row) | (384 >> idx)) === 1023 && tr > 1) n += w(WI.TstClearable);
      if ((line(row + 2) | (128 >> idx)) === 1023) n += w(WI.TstClearable) - w(WI.Anabara);
      return n >> (tr <= 0 ? 1 : 0);
    }
  }

  const r2 = line(minHeight + 2);
  for (let i = 0; i < 7; i += 1) {
    if (((r2 >> (6 - i)) & 0xf) === 9) {
      const v = line(minHeight + 1) & (960 >> i);
      if (i < 6 && v === 704 >> i) {
        if ((line(minHeight + 3) & (224 >> i)) === 0) {
          if (minHeight >= 0 && (line(minHeight) & (960 >> i)) === 832 >> i) return w(WI.TDHint);
          return w(WI.TstHint);
        }
      } else if (i > 0 && v === 832 >> i && (line(minHeight + 3) & (1792 >> i)) === 0) {
        if (minHeight >= 0 && (line(minHeight) & (960 >> i)) === 704 >> i) return w(WI.TDHint);
        return w(WI.TstHint);
      }
    }
  }
  return 0;
}
