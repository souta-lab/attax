/**
 * C1 — stock potential Φ for the S2 search (canonical design §C1).
 *
 * The champion's F14 shaper pays transition rewards for conversion events.
 * This is the alternative the canonical design specifies instead: a STATE
 * potential added to the board evaluation at every beam layer, so a node's
 * value is
 *
 *   V_d = Σ γᵗ rₜ + γᵈ [ V_board(s_d) + Φ_stock(s_d) ]
 *
 * (the search's existing accumulated + γ^d · dot(features, w) shape, with Φ
 * inside the same discounted bracket — Φ is paid once per node as a terminal
 * estimate, never summed per lock).
 *
 *   Φ_stock(s) = scale · w_A · [ q_B(s)·S(d, m) + g(s)·(β_B·U_B(s) + β_R·U_R(s)) ]
 *
 * - w_A is the profile's own attack weight (score points per attack row), so
 *   Φ scales with the policy's attack scale instead of introducing a second
 *   unit system.
 * - d is the exact difficult-clear chain count (the child's b2b state);
 *   S(d, m) is the cashable surge under the authoritative lab award function:
 *   s2Surge(d) rows (zero at d ≤ 4) times the lock-frame margin multiplier m.
 * - q_B estimates converting that stock before death from effective height
 *   (stack + residual pending). Cashable surge is NOT gated away by height
 *   (per the design); it is discounted by this survival/conversion estimate.
 * - U_B is the option value of one more difficult clear: the cashable-surge
 *   increment S(d+1, m) − S(d, m), times a cheap opportunity estimate from
 *   board features (an open T-slot, else a ready quad well, else baseline).
 * - U_R prices the active REN chain by the design's K = 3 counterfactual:
 *   the same next clears with the chain continued (combo c + j) versus
 *   restarted (combo j − 1), on a reference base attack of 1 row, evaluated
 *   with the authoritative s2ComboRaw and margin multiplier.
 * - g = g_h · g_m gates only the SPECULATIVE growth terms (U_B, U_R):
 *   g_h = clip((14 − h)/6, 0, 1) tapers growth above height 8;
 *   g_m = clip(M/6, 0, 1) with M the worst margin if all residual pending
 *   landed (20 − height − pending).
 *
 * All constants marked as estimates are initial experimental settings from
 * the canonical design, not tuned values. S2-profile parameters only; the
 * guideline bot never sees this module.
 */
import { s2ComboRaw, s2Surge } from "../../src/core/rules.js";

export interface StockParams {
  /** Overall multiplier. The search skips Φ entirely when this is 0. */
  readonly scale: number;
  /** Weight of the chain-growth option value U_B. */
  readonly betaB: number;
  /** Weight of the REN continuation value U_R. */
  readonly betaR: number;
}

export const DEFAULT_STOCK_PARAMS: StockParams = { scale: 1, betaB: 0.5, betaR: 0.5 };

/** Everything Φ needs from a post-lock search state. */
export interface StockState {
  /** Exact difficult-clear chain count (the node's b2b). */
  readonly chain: number;
  /** Engine combo counter of the node's last lock (-1 = no active chain). */
  readonly combo: number;
  /** Residual pending garbage after the node's lock. */
  readonly pending: number;
  /** Post-lock stack height (board feature). */
  readonly maxHeight: number;
  /** Board feature: lines a T-spin into the best open T-slot would clear. */
  readonly tSlot: number;
  /** Board feature: depth of the main well, capped at 4. */
  readonly wellDepth: number;
  /** Margin multiplier at the node's lock frame. */
  readonly multiplier: number;
}

function clip01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Cashable surge rows if the chain released on a plain clear now: S(d, m). */
export function cashableSurge(chain: number, multiplier: number): number {
  return s2Surge(chain) * multiplier;
}

/**
 * Φ_stock(s) in score points. `attackPoints` is w_A (the profile's attack
 * weight); `discount` is the profile's γ (used by the U_R counterfactual).
 */
export function stockPotential(
  state: StockState,
  params: StockParams,
  attackPoints: number,
  discount: number,
): number {
  const d = state.chain;
  const m = state.multiplier;
  const cashable = cashableSurge(d, m);
  // Effective height counts the residual pending that will land under the
  // stack; conversion must happen before that pressure resolves.
  const effectiveHeight = state.maxHeight + state.pending;
  const qB = clip01((18 - effectiveHeight) / 8);
  // Speculative-growth gate (cashable stock above is not gated by this).
  const gh = clip01((14 - state.maxHeight) / 6);
  const gm = clip01((20 - effectiveHeight) / 6);
  const g = gh * gm;
  // U_B: one more difficult clear grows the cashable surge by the increment;
  // the opportunity estimate only reads board features (T-slot ready, quad
  // well ready, or baseline setup potential).
  const opportunity = state.tSlot > 0 ? 1 : state.wellDepth >= 4 ? 0.7 : 0.35;
  const uB = opportunity * Math.max(0, cashableSurge(d + 1, m) - cashable);
  // U_R: K = 3 counterfactual continuation of the REN chain, reference base
  // attack 1 row, same moves in both arms (chain continues vs restarts).
  let uR = 0;
  if (state.combo >= 0) {
    for (let j = 1; j <= 3; j += 1) {
      uR += discount ** (j - 1) * (s2ComboRaw(1, state.combo + j) - s2ComboRaw(1, j - 1));
    }
    uR *= m;
  }
  return (
    params.scale * attackPoints * (qB * cashable + g * (params.betaB * uB + params.betaR * uR))
  );
}
