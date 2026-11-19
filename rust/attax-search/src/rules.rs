//! S2 lock awards — port of the `tetrio-s2` path of `awardLock` plus its helpers in
//! src/core/rules.ts. References are headings in the S2 spec (tools/s2-lab S2-SPEC).

use crate::movegen::Tspin;

const S2_GARBAGE_BASE: f64 = 1.0;
const S2_GARBAGE_INCREASE: f64 = 0.008;
const S2_GARBAGE_MARGIN_FRAMES: i64 = 10800;
const S2_FRAMES_PER_SECOND: f64 = 60.0;

/// Margin-multiplier state mirroring the module cache in rules.ts: the referee defines
/// the value by per-frame accumulation (increase/60 added on every frame past the
/// margin), not by the closed form. The accumulated value is a pure function of the
/// frame (additions always happen in ascending frame order from the reset point), so a
/// cache held anywhere gives identical results; this one keeps the same reset/resume
/// behaviour as the TS module.
#[derive(Clone, Copy, Debug)]
pub struct MultiplierCache {
    frame: i64,
    value: f64,
}

impl Default for MultiplierCache {
    fn default() -> Self {
        MultiplierCache { frame: 0, value: S2_GARBAGE_BASE }
    }
}

impl MultiplierCache {
    pub fn new() -> MultiplierCache {
        MultiplierCache::default()
    }

    /// `s2GarbageMultiplier(frame)` from rules.ts.
    pub fn get(&mut self, frame: i64) -> f64 {
        if frame < self.frame {
            self.frame = 0;
            self.value = S2_GARBAGE_BASE;
        }
        let mut value = self.value;
        let mut step = self.frame + 1;
        while step <= frame {
            if step > S2_GARBAGE_MARGIN_FRAMES {
                value += S2_GARBAGE_INCREASE / S2_FRAMES_PER_SECOND;
            }
            step += 1;
        }
        self.frame = frame;
        self.value = value;
        value
    }
}

/// Attack table and complete combo rule, unfloored (`s2ComboRaw`): the referee keeps
/// this value fractional; flooring happens only at the rounding stage.
pub fn s2_combo_raw(base: f64, combo: i32) -> f64 {
    let c = combo.max(0);
    let grown = base * (1.0 + 0.25 * c as f64);
    let floor_term = if c >= 2 { (1.25 * c as f64).ln_1p() } else { 0.0 };
    grown.max(floor_term)
}

/// B2B charging and surge (`s2Surge`): d is one-based; displayed b = d - 1.
pub fn s2_surge(d: i32) -> i32 {
    if d >= 5 { d - 1 } else { 0 }
}

/// `LockAward` from rules.ts.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LockAward {
    pub attack: i32,
    pub difficult_chain: i32,
    pub surge_released: i32,
}

/// The S2 branch of `awardLock`, with the stage context the search always supplies
/// (lock-frame margin multiplier and garbage rows cleared by this lock).
///
/// `combo` is the displayed combo (first clear = 0); `b2b_active` is part of the TS
/// `ClearInfo` but the S2 branch never reads it (the chain count carries the state).
#[allow(clippy::too_many_arguments)]
pub fn award_lock_s2(
    lines: u32,
    spin: Tspin,
    combo: i32,
    perfect_clear: bool,
    difficult_chain: i32,
    multiplier: f64,
    garbage_cleared: i32,
) -> LockAward {
    if lines == 0 {
        return LockAward { attack: 0, difficult_chain, surge_released: 0 };
    }
    let difficult = lines == 4 || spin != Tspin::None || perfect_clear;
    let table: [i32; 6] = match spin {
        Tspin::Full => [0, 2, 4, 6, 10, 12],
        Tspin::Mini => [0, 0, 1, 2, 10, 12],
        Tspin::None => [0, 0, 1, 2, 4, 5],
    };
    let base = if (lines as usize) < table.len() {
        table[lines as usize]
    } else {
        table[5] + (lines as i32 - 5)
    };
    let surge_released = if difficult { 0 } else { s2_surge(difficult_chain) };
    // PC and surge are separate stages from the combo attack. The combo composition
    // stays fractional until the stage floor, like the referee.
    let raw = s2_combo_raw(base as f64 + if difficult && difficult_chain > 0 { 1.0 } else { 0.0 }, combo);
    let special_bonus = if garbage_cleared > 0 && (spin != Tspin::None || lines >= 4) { 1 } else { 0 };
    let attack = (raw * multiplier + special_bonus as f64).floor() as i32
        + if perfect_clear { (5.0 * multiplier).floor() as i32 } else { 0 }
        // The referee's calculateSurge multiplies the released charge by the lock's
        // margin multiplier (amount = floor((chain - 1) * M)).
        + (surge_released as f64 * multiplier).floor() as i32;
    LockAward {
        attack,
        difficult_chain: if difficult { difficult_chain + 1 } else { 0 },
        surge_released,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multiplier_is_one_before_the_margin() {
        let mut cache = MultiplierCache::new();
        assert_eq!(cache.get(0), 1.0);
        assert_eq!(cache.get(10800), 1.0);
    }

    #[test]
    fn multiplier_accumulates_per_frame_past_the_margin() {
        // One frame past the margin adds exactly one increment; a cold cache and a
        // resumed cache agree (the value is a pure function of the frame).
        let mut cold = MultiplierCache::new();
        let at = cold.get(10801);
        assert_eq!(at, 1.0 + 0.008 / 60.0);
        let mut resumed = MultiplierCache::new();
        resumed.get(5000);
        assert_eq!(resumed.get(10801), at);
        // Reset on a smaller frame restarts the accumulation.
        assert_eq!(resumed.get(42), 1.0);
        assert_eq!(resumed.get(10801), at);
    }

    #[test]
    fn surge_releases_from_chain_five() {
        assert_eq!(s2_surge(4), 0);
        assert_eq!(s2_surge(5), 4);
        assert_eq!(s2_surge(9), 8);
    }

    #[test]
    fn combo_raw_matches_the_referee_formula() {
        assert_eq!(s2_combo_raw(1.0, -1), 1.0);
        assert_eq!(s2_combo_raw(1.0, 0), 1.0);
        assert_eq!(s2_combo_raw(2.0, 4), 4.0);
        // The log floor term dominates a zero base at high combo.
        assert_eq!(s2_combo_raw(0.0, 10), (12.5f64).ln_1p());
    }

    #[test]
    fn award_plain_clear_releases_surge() {
        // Chain 6, plain single: surge 5 released at multiplier 1, base attack 0.
        let award = award_lock_s2(1, Tspin::None, 0, false, 6, 1.0, 0);
        assert_eq!(award, LockAward { attack: 5, difficult_chain: 0, surge_released: 5 });
    }

    #[test]
    fn award_difficult_clear_charges_the_chain() {
        // T-spin double with an active chain: base 4 + 1 chain bonus, chain grows.
        let award = award_lock_s2(2, Tspin::Full, 0, false, 3, 1.0, 0);
        assert_eq!(award, LockAward { attack: 5, difficult_chain: 4, surge_released: 0 });
    }
}
