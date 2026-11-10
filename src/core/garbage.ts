/**
 * Guideline-style versus garbage rules (PPT/TEC-like attack table).
 *
 * Attack is computed from the lock result, cancels the sender's own
 * pending (unspawned) garbage first, and the remainder is sent to the
 * opponent where it spawns after a 1-turn delay.
 */

export type TspinAttackKind = "none" | "mini" | "full";

export interface ClearInfo {
  readonly lines: number;
  readonly tspinLines: number;
  readonly combo: number;
  readonly b2bActive: boolean;
  readonly perfectClear: boolean;
  /** T-spin classification when known; "mini" selects the PPT mini attack table. */
  readonly tspinKind?: TspinAttackKind;
}

export const PERFECT_CLEAR_BONUS = 10;

const LINE_BASE: Readonly<Record<number, number>> = {
  0: 0,
  1: 0,
  2: 1,
  3: 2,
  4: 4,
};

const TSPIN_BASE: Readonly<Record<number, number>> = {
  0: 0,
  1: 2,
  2: 4,
  3: 6,
};

const MINI_TSPIN_BASE: Readonly<Record<number, number>> = {
  0: 0,
  1: 0,
  2: 1,
  3: 0,
};

/**
 * Guideline (PPT/TEC) combo table, indexed by the 0-based combo counter every
 * caller passes: the first clear of a chain is combo 0 (no bonus), the second
 * clear ("1 REN") is combo 1. Table: 0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5...
 */
export function comboBonus(combo: number): number {
  if (combo <= 0) return 0;
  if (combo <= 2) return 1;
  if (combo <= 4) return 2;
  if (combo <= 6) return 3;
  if (combo <= 9) return 4;
  return 5;
}

/** Resolve the T-spin kind; without an explicit kind, `tspinLines > 0` means full. */
export function resolveTspinKind(
  info: Pick<ClearInfo, "tspinLines" | "tspinKind">,
): TspinAttackKind {
  return info.tspinKind ?? (info.tspinLines > 0 ? "full" : "none");
}

/**
 * Guideline "difficult" clear: a Tetris or any T-spin clear (mini included).
 * It both keeps the B2B chain alive and earns the +1 B2B attack bonus; the
 * engine uses this same predicate for the chain so the two cannot drift.
 */
export function isDifficultClear(lines: number, kind: TspinAttackKind): boolean {
  return lines > 0 && (lines === 4 || kind !== "none");
}

export function attackForClear(info: ClearInfo): number {
  if (info.lines <= 0) return 0;
  const kind = resolveTspinKind(info);
  const base =
    kind === "mini"
      ? (MINI_TSPIN_BASE[info.lines] ?? 0)
      : kind === "full"
        ? (TSPIN_BASE[info.tspinLines > 0 ? info.tspinLines : info.lines] ?? 0)
        : (LINE_BASE[info.lines] ?? 0);
  const b2b = info.b2bActive && isDifficultClear(info.lines, kind) ? 1 : 0;
  const combo = comboBonus(info.combo);
  const pc = info.perfectClear ? PERFECT_CLEAR_BONUS : 0;
  return base + b2b + combo + pc;
}

export interface PendingChunk {
  rows: number;
  timer: number;
}

export const GARBAGE_DELAY = 1;

export function pushIncoming(queue: PendingChunk[], rows: number, delay = GARBAGE_DELAY): void {
  if (rows <= 0) return;
  const last = queue[queue.length - 1];
  if (last !== undefined && last.timer > 0) {
    last.rows += rows;
    return;
  }
  queue.push({ rows, timer: delay });
}

export function pendingTotal(queue: readonly PendingChunk[]): number {
  let total = 0;
  for (const c of queue) total += c.rows;
  return total;
}

export function cancelPending(queue: PendingChunk[], attack: number): number {
  let rest = attack;
  let blocked = 0;
  for (const c of queue) {
    if (rest <= 0) break;
    const take = Math.min(c.rows, rest);
    c.rows -= take;
    rest -= take;
    blocked += take;
  }
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if ((queue[i]?.rows ?? 0) <= 0) queue.splice(i, 1);
  }
  return blocked;
}

export function tickPending(queue: PendingChunk[]): number {
  let due = 0;
  for (const c of queue) c.timer -= 1;
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    const c = queue[i];
    if (c === undefined) continue;
    if (c.timer <= 0) {
      due += c.rows;
      queue.splice(i, 1);
    }
  }
  return due;
}

export function genGarbageHoles(
  count: number,
  rand: () => number,
  prevHole: number,
): { readonly holes: readonly number[]; readonly prevHole: number } {
  const holes: number[] = [];
  let prev = prevHole;
  for (let i = 0; i < count; i += 1) {
    const roll = Math.floor(rand() * 10);
    let hole = roll >= 0 && roll <= 9 ? roll : ((roll % 10) + 10) % 10;
    if (hole === prev && rand() < 0.5) {
      const reroll = Math.floor(rand() * 10);
      hole = reroll >= 0 && reroll <= 9 ? reroll : ((reroll % 10) + 10) % 10;
    }
    holes.push(hole);
    prev = hole;
  }
  return { holes, prevHole: prev };
}
