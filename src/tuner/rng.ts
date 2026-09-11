// Deterministic seeded RNG for the tuner (mulberry32 + Box-Muller Gaussian).
// State is a single uint32 so the orchestrator can persist/restore it for
// exact restartability.

export interface Rng {
  next(): number;
  gaussian(): number;
  int(maxExclusive: number): number;
  getState(): number;
  setState(state: number): void;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gaussian = (): number => {
    const u = Math.max(Number.EPSILON, next());
    const v = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  return {
    next,
    gaussian,
    int(maxExclusive: number): number {
      return Math.floor(next() * maxExclusive);
    },
    getState(): number {
      return state;
    },
    setState(nextState: number): void {
      state = nextState >>> 0;
    },
  };
}
