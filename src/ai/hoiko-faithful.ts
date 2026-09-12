/**
 * Faithful shipping-binary in-match configuration for the Hoiko replica.
 *
 * Source of truth: `evidence/hoiko/weights/config.txt` (beamSize 50, minDepth 10,
 * depthLimit 14, viewNext 2, playStyle 0 = `we`) plus the binary's derived search
 * bounds (`beamSizeLimit = min(1500, threads*50*3) = 150`) and its `SetNextOption`
 * time-budget beam adaptation, which the host applies from real elapsed search time
 * (`RustHoikoEngine.applySetNextOption`).
 *
 * Every caller resolves through this module: the browser app uses the adapter
 * defaults (derived from `FAITHFUL_HOIKO`), the gates/harnesses use
 * `resolveFaithfulHoikoOptions`, so the two cannot drift apart.
 */
import type { RustHoikoOptions } from "./hoiko-rust-core.js";
import type { HoikoPreset } from "./hoiko-weights.js";

/** Fixed fields of the shipping binary's in-match opponent configuration. */
export const FAITHFUL_HOIKO = {
  weightPreset: "we",
  beamSizeLimit: 150,
  maxBeamSize: 50,
  adapt: true,
  depthLimit: 14,
  viewNext: 2,
} as const satisfies RustHoikoOptions;

/** Env boundary for harness runs: strings, absent when unset. */
export interface FaithfulHoikoEnv {
  readonly HOIKO_BEAM?: string | undefined;
  readonly HOIKO_ADAPT?: string | undefined;
  readonly HOIKO_OFFSET?: string | undefined;
  readonly HOIKO_FRAMES?: string | undefined;
  readonly HOIKO_NEXTCARRY?: string | undefined;
  readonly HOIKO_EVEN?: string | undefined;
}

function readEnvInteger(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer, got ${raw}`);
  return value;
}

function readEnvFlag(name: string, raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (raw === "0") return false;
  if (raw === "1") return true;
  throw new Error(`${name} must be 0 or 1, got ${raw}`);
}

function readEnvEvenMode(
  raw: string | undefined,
  fallback: "auto" | "true" | "false",
): "auto" | "true" | "false" {
  if (raw === undefined || raw.trim() === "") return fallback;
  if (raw === "auto" || raw === "true" || raw === "false") return raw;
  throw new Error(`HOIKO_EVEN must be auto, true or false, got ${raw}`);
}

function hasEnv(raw: string | undefined): raw is string {
  return raw !== undefined && raw.trim() !== "";
}

/**
 * Faithful options for the gate/harnesses. Identical to the app defaults unless
 * `HOIKO_BEAM` (stress/ablation) or `HOIKO_ADAPT=0` (deterministic runs) overrides
 * them explicitly.
 */
export function resolveFaithfulHoikoOptions(
  env: FaithfulHoikoEnv,
  preset: HoikoPreset = FAITHFUL_HOIKO.weightPreset,
): RustHoikoOptions {
  return {
    ...FAITHFUL_HOIKO,
    versus: true,
    weightPreset: preset,
    beamSizeLimit: readEnvInteger("HOIKO_BEAM", env.HOIKO_BEAM, FAITHFUL_HOIKO.beamSizeLimit),
    adapt: readEnvFlag("HOIKO_ADAPT", env.HOIKO_ADAPT, FAITHFUL_HOIKO.adapt),
    ...(hasEnv(env.HOIKO_OFFSET)
      ? { offset: readEnvFlag("HOIKO_OFFSET", env.HOIKO_OFFSET, true) }
      : {}),
    ...(hasEnv(env.HOIKO_FRAMES)
      ? { framesPerThink: readEnvInteger("HOIKO_FRAMES", env.HOIKO_FRAMES, 20) }
      : {}),
    ...(hasEnv(env.HOIKO_NEXTCARRY)
      ? { nextCarry: readEnvFlag("HOIKO_NEXTCARRY", env.HOIKO_NEXTCARRY, true) }
      : {}),
    ...(hasEnv(env.HOIKO_EVEN) ? { evenMode: readEnvEvenMode(env.HOIKO_EVEN, "auto") } : {}),
  };
}
