//! C1 — stock potential Φ for the S2 search (canonical design §C1), a port of
//! src/ai/bot/stock.ts. See that file for the design: Φ is a STATE potential added to
//! the board evaluation inside the same discounted bracket as the board dot product.

use crate::rules::{s2_combo_raw, s2_surge};

/// `StockParams` from stock.ts.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StockParams {
    /// Overall multiplier. The search skips Φ entirely when this is 0.
    pub scale: f64,
    /// Weight of the chain-growth option value U_B.
    pub beta_b: f64,
    /// Weight of the REN continuation value U_R.
    pub beta_r: f64,
}

impl Default for StockParams {
    fn default() -> Self {
        StockParams { scale: 1.0, beta_b: 0.5, beta_r: 0.5 }
    }
}

/// Everything Φ needs from a post-lock search state (`StockState` in stock.ts).
#[derive(Clone, Copy, Debug)]
pub struct StockState {
    /// Exact difficult-clear chain count (the node's b2b).
    pub chain: i32,
    /// Engine combo counter of the node's last lock (-1 = no active chain).
    pub combo: i32,
    /// Residual pending garbage after the node's lock.
    pub pending: i32,
    /// Post-lock stack height (board feature).
    pub max_height: i32,
    /// Board feature: lines a T-spin into the best open T-slot would clear.
    pub t_slot: i32,
    /// Board feature: depth of the main well, capped at 4.
    pub well_depth: i32,
    /// Margin multiplier at the node's lock frame.
    pub multiplier: f64,
}

fn clip01(x: f64) -> f64 {
    if x < 0.0 {
        0.0
    } else if x > 1.0 {
        1.0
    } else {
        x
    }
}

/// Cashable surge rows if the chain released on a plain clear now: S(d, m).
pub fn cashable_surge(chain: i32, multiplier: f64) -> f64 {
    s2_surge(chain) as f64 * multiplier
}

/// Φ_stock(s) in score points (`stockPotential` in stock.ts). `attack_points` is w_A
/// (the profile's attack weight); `discount` is the profile's γ.
pub fn stock_potential(state: &StockState, params: &StockParams, attack_points: f64, discount: f64) -> f64 {
    let d = state.chain;
    let m = state.multiplier;
    let cashable = cashable_surge(d, m);
    // Effective height counts the residual pending that will land under the stack.
    let effective_height = state.max_height + state.pending;
    let q_b = clip01((18 - effective_height) as f64 / 8.0);
    // Speculative-growth gate (cashable stock above is not gated by this).
    let g_h = clip01((14 - state.max_height) as f64 / 6.0);
    let g_m = clip01((20 - effective_height) as f64 / 6.0);
    let g = g_h * g_m;
    // U_B: one more difficult clear grows the cashable surge by the increment.
    let opportunity = if state.t_slot > 0 {
        1.0
    } else if state.well_depth >= 4 {
        0.7
    } else {
        0.35
    };
    let u_b = opportunity * (cashable_surge(d + 1, m) - cashable).max(0.0);
    // U_R: K = 3 counterfactual continuation of the REN chain, reference base attack
    // 1 row, same moves in both arms (chain continues vs restarts).
    let mut u_r = 0.0;
    if state.combo >= 0 {
        for j in 1..=3i32 {
            u_r += discount.powi(j - 1) * (s2_combo_raw(1.0, state.combo + j) - s2_combo_raw(1.0, j - 1));
        }
        u_r *= m;
    }
    params.scale * attack_points * (q_b * cashable + g * (params.beta_b * u_b + params.beta_r * u_r))
}
