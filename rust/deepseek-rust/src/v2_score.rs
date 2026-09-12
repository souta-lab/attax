//! Port of `src/ai/deepseek-v2-score.ts`: versus survivability stats,
//! Cold-Clear-inspired garbage defense, and the opponent telemetry model.

use crate::board::{Board, COLS};
use crate::deepseek_score::ds_heights;

#[derive(Clone, Copy, Debug)]
pub struct V2BoardStats {
    pub heights: [f64; COLS],
    pub global_max: f64,
    pub middle_max: f64,
    pub avg_height: f64,
    pub holes: u32,
    pub hole_rows: u32,
    /// Holes whose covering gap sits in the upper third of the stack.
    pub top_holes: u32,
    /// Deep holes (2+ buried cells) that are expensive to dig out.
    pub deep_holes: u32,
}

/// Board-shape stats tuned for versus survivability.
pub fn v2_board_stats(after: &Board) -> V2BoardStats {
    let heights = ds_heights(after);
    let mut global_max = 0f64;
    let mut sum = 0f64;
    for v in heights {
        if v > global_max {
            global_max = v;
        }
        sum += v;
    }
    let mut middle_max = 0f64;
    for x in 3..=6 {
        let v = heights[x];
        if v > middle_max {
            middle_max = v;
        }
    }
    let mut holes = 0u32;
    let mut hole_rows = 0u32;
    let mut top_holes = 0u32;
    let mut deep_holes = 0u32;
    let top_cut = (global_max as i64 - 3).max(0) as usize;
    for x in 0..COLS {
        let top = heights[x] as usize;
        let mut deepest = 0usize;
        let mut has_hole = false;
        for y in 0..top {
            if (after[y] & (1u16 << x)) != 0 {
                continue;
            }
            holes += 1;
            has_hole = true;
            let depth = top - y;
            if depth > deepest {
                deepest = depth;
            }
            if y >= top_cut {
                top_holes += 1;
            }
            if depth >= 2 {
                deep_holes += 1;
            }
        }
        if has_hole {
            hole_rows += 1;
        }
    }
    V2BoardStats {
        heights,
        global_max,
        middle_max,
        avg_height: sum / COLS as f64,
        holes,
        hole_rows,
        top_holes,
        deep_holes,
    }
}

pub const GARBAGE_MID_W: f64 = 6.0;
pub const GARBAGE_MID_FLAT: f64 = 2.0;
pub const GARBAGE_TOP_HOLE_W: f64 = 9.0;
pub const GARBAGE_DEEP_HOLE_W: f64 = 3.0;

/// Cold Clear-inspired incoming-garbage defense. Incoming rows shift the whole
/// stack up, so the relevant danger is `stackHeight + pending`.
pub fn v2_garbage_defense(stats: &V2BoardStats, pending_after: i32) -> f64 {
    if pending_after <= 0 {
        return 0.0;
    }
    let pending = pending_after as f64;
    let danger = stats.global_max + pending;
    let mut penalty = 0f64;
    if danger >= 19.0 {
        penalty += (danger - 18.0) * 420.0;
    } else if danger >= 15.0 {
        penalty += (danger - 14.0) * 130.0;
    } else if danger >= 12.0 {
        penalty += (danger - 11.0) * 42.0;
    }
    penalty += stats.middle_max * pending * GARBAGE_MID_W;
    penalty += stats.top_holes as f64 * pending * GARBAGE_TOP_HOLE_W;
    penalty += stats.deep_holes as f64 * pending * GARBAGE_DEEP_HOLE_W;
    penalty += stats.middle_max * GARBAGE_MID_FLAT;
    -penalty
}

#[derive(Clone, Copy, Debug, Default)]
pub struct V2OppModel {
    /// 0..~1.6 estimate of how much pressure the opponent is applying.
    pub danger: f64,
    /// 1 when the opponent just whiffed and cannot cancel our next burst.
    pub vuln: f64,
}

/// Controller telemetry mirrored from the optional `opponent*` snapshot fields.
#[derive(Clone, Copy, Debug, Default)]
pub struct V2OpponentTelemetry {
    pub lock_id: Option<i64>,
    pub last_clear_lines: Option<i64>,
    pub last_native_combo: Option<i64>,
    pub last_native_btb: Option<i64>,
    pub last_raw_attack: Option<i64>,
    pub combo: Option<i64>,
    pub btb: Option<i64>,
}

/// Minimal opponent model from controller telemetry.
pub fn v2_opponent_model(s: &V2OpponentTelemetry) -> V2OppModel {
    let known = s.lock_id.is_some();
    let last_raw = s.last_raw_attack.unwrap_or(0);
    let combo = s.last_native_combo.or(s.combo).unwrap_or(0);
    let btb_raw = s.last_native_btb.or(s.btb).unwrap_or(0);
    let btb = if btb_raw > 0 { 1.0 } else { 0.0 };
    let danger = (1.6f64).min(last_raw as f64 / 4.0 + combo as f64 / 4.0 + btb * 0.4);
    let clear_lines = s.last_clear_lines;
    let whiffed = known && (clear_lines.is_none() || clear_lines == Some(0));
    let vuln = if whiffed && combo == 0 && btb == 0.0 {
        1.0
    } else {
        0.0
    };
    V2OppModel { danger, vuln }
}
