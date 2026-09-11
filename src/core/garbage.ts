/**
 * Guideline-style versus garbage rules (PPT/TEC-like attack table).
 *
 * Attack is computed from the lock result, cancels the sender's own
 * pending (unspawned) garbage first, and the remainder is sent to the
 * opponent where it spawns after a 1-turn delay.
 */

export interface ClearInfo {
  readonly lines: number;
  readonly tspinLines: number;
  readonly combo: number;
  readonly b2bActive: boolean;
  readonly perfectClear: boolean;
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

export function comboBonus(combo: number): number {
  if (combo <= 1) return 0;
  if (combo <= 3) return 1;
  if (combo <= 5) return 2;
  if (combo <= 7) return 3;
  if (combo <= 10) return 4;
  return 5;
}

export function attackForClear(info: ClearInfo): number {
  if (info.lines <= 0) return 0;
  const base =
    info.tspinLines > 0 ? (TSPIN_BASE[info.tspinLines] ?? 0) : (LINE_BASE[info.lines] ?? 0);
  const b2b = info.b2bActive && (info.lines === 4 || info.tspinLines > 0) ? 1 : 0;
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
