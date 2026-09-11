// (1+lambda) evolution strategy operators over the tuner genome.
// Deterministic given the RNG state; pure so tests can run it without I/O.

import { type Genome, sanitizeGenome, TUNABLE_SPECS } from "./genome.js";
import type { Rng } from "./rng.js";

/** Probability that any single tunable gene is perturbed in one offspring. */
export const MUTATION_RATE = 0.1;

export function mutate(parent: Genome, rng: Rng, sigmaScale: number): Genome {
  const out: Record<string, number> = { ...parent };
  let changed = 0;
  for (const spec of TUNABLE_SPECS) {
    if (rng.next() >= MUTATION_RATE) continue;
    const base = parent[spec.key] ?? spec.value;
    out[spec.key] = base + rng.gaussian() * spec.sigma * sigmaScale;
    changed += 1;
  }
  if (changed === 0 && TUNABLE_SPECS.length > 0) {
    const spec = TUNABLE_SPECS[rng.int(TUNABLE_SPECS.length)];
    if (spec !== undefined) {
      const base = parent[spec.key] ?? spec.value;
      out[spec.key] = base + rng.gaussian() * spec.sigma * sigmaScale;
    }
  }
  return sanitizeGenome(out);
}

export function proposeOffspring(
  parent: Genome,
  lambda: number,
  rng: Rng,
  sigmaScale: number,
): readonly Genome[] {
  const out: Genome[] = [];
  for (let index = 0; index < lambda; index += 1) {
    out.push(mutate(parent, rng, sigmaScale));
  }
  return out;
}
