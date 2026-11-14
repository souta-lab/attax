//! The bot's whole policy as data — mirror of `src/ai/bot/weights.ts`.
//!
//! `Weights::default()` is the ONLY place the default numbers appear on the Rust side.
//! A tuner drives the policy through the flat parameter vector (`PARAM_NAMES`,
//! `to_params`, `from_params`) or through the JSON shape of the TS `Weights` object
//! (handled by the CLI crate), never by editing literals in the search code.

use crate::features::{N_FEATURES, Features};

/// Clear kinds in the order of the TS `ClearKind` union.
pub const N_CLEARS: usize = 9;
pub const CLEAR_NAMES: [&str; N_CLEARS] = [
    "single",
    "double",
    "triple",
    "quad",
    "tspinMini",
    "tspinSingle",
    "tspinDouble",
    "tspinTriple",
    "perfectClear",
];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum ClearKind {
    Single = 0,
    Double = 1,
    Triple = 2,
    Quad = 3,
    TspinMini = 4,
    TspinSingle = 5,
    TspinDouble = 6,
    TspinTriple = 7,
    PerfectClear = 8,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Weights {
    /// Board-shape weights in `features::FEATURE_NAMES` order.
    pub board: [f64; N_FEATURES],
    /// Reward per garbage line produced.
    pub attack: f64,
    /// Extra shaping per clear type, `CLEAR_NAMES` order.
    pub clear: [f64; N_CLEARS],
    pub b2b_break: f64,
    pub wasted_t: f64,
    /// Per-ply multiplier on later rewards.
    pub discount: f64,
}

impl Default for Weights {
    /// `DEFAULT_WEIGHTS` from weights.ts (checked against TS by the agreement harness,
    /// which always ships the TS weights object with each case).
    fn default() -> Self {
        Weights {
            board: [-6.0, -40.0, -60.0, -12.0, -40.0, -8.0, -3.0, -6.0, 18.0, -40.0, 60.0],
            attack: 90.0,
            clear: [-60.0, -40.0, -30.0, 60.0, -20.0, 40.0, 120.0, 160.0, 400.0],
            b2b_break: -90.0,
            wasted_t: -50.0,
            discount: 0.97,
        }
    }
}

/// Total number of tunable parameters in the flat vector.
pub const N_PARAMS: usize = N_FEATURES + 1 + N_CLEARS + 3;

/// Flat parameter names: `board.<feature>`, `attack`, `clear.<kind>`, `b2bBreak`,
/// `wastedT`, `discount` — the TS object paths, so tuner output maps 1:1 onto a
/// `weights.json` the TS bot can load (`ATTAX_WEIGHTS`).
pub fn param_names() -> Vec<String> {
    let mut v = Vec::with_capacity(N_PARAMS);
    for f in crate::features::FEATURE_NAMES {
        v.push(format!("board.{f}"));
    }
    v.push("attack".into());
    for c in CLEAR_NAMES {
        v.push(format!("clear.{c}"));
    }
    v.push("b2bBreak".into());
    v.push("wastedT".into());
    v.push("discount".into());
    v
}

impl Weights {
    pub fn to_params(&self) -> [f64; N_PARAMS] {
        let mut p = [0.0; N_PARAMS];
        p[..N_FEATURES].copy_from_slice(&self.board);
        p[N_FEATURES] = self.attack;
        p[N_FEATURES + 1..N_FEATURES + 1 + N_CLEARS].copy_from_slice(&self.clear);
        p[N_PARAMS - 3] = self.b2b_break;
        p[N_PARAMS - 2] = self.wasted_t;
        p[N_PARAMS - 1] = self.discount;
        p
    }

    pub fn from_params(p: &[f64; N_PARAMS]) -> Weights {
        let mut w = Weights::default();
        w.board.copy_from_slice(&p[..N_FEATURES]);
        w.attack = p[N_FEATURES];
        w.clear.copy_from_slice(&p[N_FEATURES + 1..N_FEATURES + 1 + N_CLEARS]);
        w.b2b_break = p[N_PARAMS - 3];
        w.wasted_t = p[N_PARAMS - 2];
        w.discount = p[N_PARAMS - 1];
        w
    }

    /// `dot(features, w)` from search.ts: same order, same left fold, so bit-identical.
    #[inline(always)]
    pub fn dot(&self, f: &Features) -> f64 {
        let mut total = 0.0;
        for i in 0..N_FEATURES {
            total += f[i] as f64 * self.board[i];
        }
        total
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn params_round_trip() {
        let w = Weights::default();
        let p = w.to_params();
        assert_eq!(Weights::from_params(&p), w);
        assert_eq!(param_names().len(), N_PARAMS);
        assert_eq!(param_names()[N_FEATURES], "attack");
    }
}
