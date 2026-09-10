/**
 * Top-out happens when the centre spawn columns fill, not when the edge well
 * grows. Penalising only the spawn columns keeps deliberate edge wells alive
 * while forcing RED to keep the piece-spawn corridor clear.
 */
export function v9SpawnPressure(h: readonly number[]): number {
  let m = 0;
  for (let x = 3; x <= 6; x += 1) {
    const v = h[x] ?? 0;
    if (v > m) m = v;
  }
  if (m < 14) return 0;
  return (m - 13) * 220;
}
