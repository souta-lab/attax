/**
 * Single source of truth for the versus-match garbage configuration (issue #25).
 *
 * Before this module the browser app constructed the controller with
 * `{ garbageAligned: true }` while every measurement harness passed no config, so the
 * gate measured per-row holes instead of the rules the app ships. The app and every
 * harness now resolve through here and cannot drift apart.
 *
 * Choosing `garbageAligned: true`:
 *
 * - The opponent is `Hoiko_PPT_v0-beta1`, a PPT bot (`evidence/hoiko/README.txt`), but it
 *   is an AI that reads the game board/incoming garbage from PPT's memory and never
 *   generates rows itself (`evidence/hoiko/analysis.md`), so the binary cannot be probed
 *   for a hole rule and the oracle only captures AI moves, not garbage
 *   (`evidence/fair-harness/README.md`). Binary evidence is therefore N/A.
 * - The repo docs disagree: `docs/BEAT_HOIKO.md` and scan finding F2 call the aligned
 *   mode "PPT-style", while `docs/BEAT_HOIKO.md`/`docs/research.md` note that PPT changes
 *   the hole column ~30% per row within an attack (90% between attacks).
 * - The engine only models the two extremes: `garbageAligned: true` shares one hole across
 *   a chunk (0% intra-chunk change), `false` gives each row an independent hole (~95%
 *   change, `src/core/garbage.ts`). PPT's real rule is ~70% aligned per consecutive pair,
 *   so the aligned mode is the closer approximation of the two and is the app's shipped
 *   behavior. Per the #25 brief, when the exact binary rule is not representable the
 *   default is the app's current value; a future sticky-30% mode would be more faithful.
 * - `garbageDelay: GARBAGE_DELAY` — incoming rows spawn after one lock, the long-standing
 *   versus default (`src/core/garbage.ts`); pinned here so the resolved match rules do not
 *   silently inherit an engine default.
 */
import { GARBAGE_DELAY } from "../core/garbage.js";
import type { VersusControllerConfig } from "./controller.js";

/** Canonical garbage config used by the app and every harness/gate. */
export const VERSUS_MATCH_CONFIG = {
  garbageDelay: GARBAGE_DELAY,
  garbageAligned: true,
} as const satisfies VersusControllerConfig;

/**
 * Fully-resolved config for a versus controller. Omitted fields fall back to
 * `VERSUS_MATCH_CONFIG`; pass an explicit value only for deliberate ablations.
 */
export function resolveVersusConfig(
  overrides: VersusControllerConfig = {},
): VersusControllerConfig {
  return {
    garbageDelay: overrides.garbageDelay ?? VERSUS_MATCH_CONFIG.garbageDelay,
    garbageAligned: overrides.garbageAligned ?? VERSUS_MATCH_CONFIG.garbageAligned,
  };
}
