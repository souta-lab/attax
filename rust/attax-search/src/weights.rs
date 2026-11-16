//! The bot's whole policy as data — mirror of `src/ai/bot/weights.ts`.
//!
//! `Weights::default()` is the ONLY place the default numbers appear on the Rust side.
//! A tuner drives the policy through the flat parameter vector (`param_names`,
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
    /// Adopt C1: terminal state value of B2B being alive (`b2bState`; 0 = off, skipped).
    pub b2b_state: f64,
    /// Adopt C2: value per T-slot donation clearing 0..3 lines.
    pub t_slot_chain: [f64; 4],
    /// Adopt C4: terminal value of holding a T / an I (`holdT` / `holdI`; 0 = off).
    pub hold_t: f64,
    pub hold_i: f64,
    /// S2 root reward per attack line left after cancelling known incoming garbage
    /// (`conversion`; 0 = off). Read only by the S2 expansion.
    pub conversion: f64,
    /// S2 C3: terminal value per vertical run of holes (`holeRuns`; 0 = off).
    pub hole_runs: f64,
    /// S2 C3: terminal value per change between consecutive hole-row masks.
    pub hole_shifts: f64,
    /// S2 C5: additive mini-spin clear rewards by cleared line count (0 = off).
    pub mini_single_delta: f64,
    pub mini_double_delta: f64,
    pub mini_triple_delta: f64,
}

impl Default for Weights {
    /// `DEFAULT_WEIGHTS` from weights.ts (checked independently by
    /// `defaults_match_ts_reference`; the CLI instead loads each case's weights).
    fn default() -> Self {
        Weights {
            board: [-6.0, -40.0, -60.0, -12.0, -40.0, -8.0, -3.0, -6.0, 18.0, -40.0, 60.0],
            attack: 90.0,
            clear: [-60.0, -40.0, -30.0, 60.0, -20.0, 40.0, 120.0, 160.0, 400.0],
            b2b_break: -90.0,
            wasted_t: -50.0,
            discount: 0.97,
            b2b_state: 0.0,
            t_slot_chain: [0.0; 4],
            hold_t: 0.0,
            hold_i: 0.0,
            conversion: 0.0,
            hole_runs: 0.0,
            hole_shifts: 0.0,
            mini_single_delta: 0.0,
            mini_double_delta: 0.0,
            mini_triple_delta: 0.0,
        }
    }
}

/// Parameters of the original 24-element policy vector (indices are stable).
pub const N_CORE_PARAMS: usize = N_FEATURES + 1 + N_CLEARS + 3;

/// Adopt-candidate parameters appended after the core vector, in this order
/// (all default to 0 = off).
pub const ADOPT_PARAM_NAMES: [&str; 7] = ["b2bState", "tSlotChain0", "tSlotChain1", "tSlotChain2", "tSlotChain3", "holdT", "holdI"];

/// S2-only parameters appended after the adopt block, in this order (all default to
/// 0 = off; existing indices never move).
pub const S2_PARAM_NAMES: [&str; 6] = ["conversion", "holeRuns", "holeShifts", "miniSingleDelta", "miniDoubleDelta", "miniTripleDelta"];

/// Total number of tunable parameters in the flat vector.
pub const N_PARAMS: usize = N_CORE_PARAMS + ADOPT_PARAM_NAMES.len() + S2_PARAM_NAMES.len();

/// Flat parameter names: `board.<feature>`, `attack`, `clear.<kind>`, `b2bBreak`,
/// `wastedT`, `discount`, then the adopt parameters — the TS object paths, so tuner
/// output maps 1:1 onto a `weights.json` the TS bot can load (`ATTAX_WEIGHTS`).
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
    for a in ADOPT_PARAM_NAMES {
        v.push(a.into());
    }
    for a in S2_PARAM_NAMES {
        v.push(a.into());
    }
    v
}

impl Weights {
    pub fn to_params(&self) -> [f64; N_PARAMS] {
        let mut p = [0.0; N_PARAMS];
        p[..N_FEATURES].copy_from_slice(&self.board);
        p[N_FEATURES] = self.attack;
        p[N_FEATURES + 1..N_FEATURES + 1 + N_CLEARS].copy_from_slice(&self.clear);
        p[N_CORE_PARAMS - 3] = self.b2b_break;
        p[N_CORE_PARAMS - 2] = self.wasted_t;
        p[N_CORE_PARAMS - 1] = self.discount;
        p[N_CORE_PARAMS] = self.b2b_state;
        p[N_CORE_PARAMS + 1..N_CORE_PARAMS + 5].copy_from_slice(&self.t_slot_chain);
        p[N_CORE_PARAMS + 5] = self.hold_t;
        p[N_CORE_PARAMS + 6] = self.hold_i;
        let s2 = N_CORE_PARAMS + ADOPT_PARAM_NAMES.len();
        p[s2] = self.conversion;
        p[s2 + 1] = self.hole_runs;
        p[s2 + 2] = self.hole_shifts;
        p[s2 + 3] = self.mini_single_delta;
        p[s2 + 4] = self.mini_double_delta;
        p[s2 + 5] = self.mini_triple_delta;
        p
    }

    pub fn from_params(p: &[f64; N_PARAMS]) -> Weights {
        let mut w = Weights::default();
        w.board.copy_from_slice(&p[..N_FEATURES]);
        w.attack = p[N_FEATURES];
        w.clear.copy_from_slice(&p[N_FEATURES + 1..N_FEATURES + 1 + N_CLEARS]);
        w.b2b_break = p[N_CORE_PARAMS - 3];
        w.wasted_t = p[N_CORE_PARAMS - 2];
        w.discount = p[N_CORE_PARAMS - 1];
        w.b2b_state = p[N_CORE_PARAMS];
        w.t_slot_chain.copy_from_slice(&p[N_CORE_PARAMS + 1..N_CORE_PARAMS + 5]);
        w.hold_t = p[N_CORE_PARAMS + 5];
        w.hold_i = p[N_CORE_PARAMS + 6];
        let s2 = N_CORE_PARAMS + ADOPT_PARAM_NAMES.len();
        w.conversion = p[s2];
        w.hole_runs = p[s2 + 1];
        w.hole_shifts = p[s2 + 2];
        w.mini_single_delta = p[s2 + 3];
        w.mini_double_delta = p[s2 + 4];
        w.mini_triple_delta = p[s2 + 5];
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
    fn defaults_match_ts_reference() {
        // The agreement CLI loads weights from each case, so agreement alone cannot
        // detect drift in Rust's defaults. Check the source table independently.
        let ts = include_str!("../../../src/ai/bot/weights.ts")
            .split("export const DEFAULT_WEIGHTS: Weights = ")
            .nth(1)
            .expect("TS default table");
        let read = |name: &str| -> f64 {
            ts.split(&format!("{name}:"))
                .nth(1)
                .unwrap_or_else(|| panic!("missing TS weight {name}"))
                .split(',')
                .next()
                .unwrap()
                .trim()
                .parse()
                .unwrap()
        };
        let w = Weights::default();
        for (name, value) in crate::features::FEATURE_NAMES.iter().zip(w.board) {
            assert_eq!(read(name).to_bits(), value.to_bits(), "board.{name}");
        }
        for (name, value) in CLEAR_NAMES.iter().zip(w.clear) {
            assert_eq!(read(name).to_bits(), value.to_bits(), "clear.{name}");
        }
        for (name, value) in [
            ("attack", w.attack),
            ("conversion", w.conversion),
            ("b2bBreak", w.b2b_break),
            ("wastedT", w.wasted_t),
            ("discount", w.discount),
            ("b2bState", w.b2b_state),
            ("holdT", w.hold_t),
            ("holdI", w.hold_i),
        ] {
            assert_eq!(read(name).to_bits(), value.to_bits(), "{name}");
        }
    }

    #[test]
    fn params_round_trip() {
        let w = Weights::default();
        let p = w.to_params();
        assert_eq!(Weights::from_params(&p), w);
        assert_eq!(param_names().len(), N_PARAMS);
        assert_eq!(param_names()[N_FEATURES], "attack");
        assert_eq!(param_names()[N_CORE_PARAMS - 1], "discount");
        assert_eq!(param_names()[N_CORE_PARAMS], "b2bState");
        assert_eq!(param_names()[N_CORE_PARAMS + ADOPT_PARAM_NAMES.len()], "conversion");
        assert_eq!(param_names()[N_PARAMS - 1], "miniTripleDelta");
    }
}
