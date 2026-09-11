//! Delay / next-option helpers split out of `search.ts` (`ClearAct` timing and
//! `SearchAI.SetNextOption`).

use crate::shapes::{ACT_NONE, ACT_PC};
use crate::search::SearchState;

pub const TAKE_OVER_TIME: i32 = 5;

pub fn clear_delay(act: i32) -> i32 {
    match act {
        ACT_NONE => 0,
        1 | 5 | 8 => 36,
        2 | 3 | 6 | 7 => 41,
        4 => 46,
        ACT_PC => 1,
        _ => 0,
    }
}

pub fn get_delay(move_delay: i32, act: i32) -> i32 {
    clear_delay(act) * 16 + move_delay
}

/// `SearchAI.SetNextOption` (IL 15892): readies the globals for the next search.
pub fn set_next_option(
    state: &mut SearchState,
    over_time: f64,
    depth: i32,
    move_delay: i32,
    act: i32,
    safe: bool,
) {
    if over_time > 0.0 {
        state.max_beam_size += (depth - 14) * 10;
        state.max_beam_size = state.max_beam_size.clamp(50, 500);
    } else if over_time < -33.0 && state.timer_limit_ms < 336 {
        state.max_beam_size += ((over_time + 16.0) * 0.06).trunc() as i32 * -10;
        state.max_beam_size = state.max_beam_size.clamp(50, 500);
    }
    state.timer_limit_ms = get_delay(move_delay, act) - TAKE_OVER_TIME;
    state.beam_size_limit =
        ((state.max_beam_size * state.timer_limit_ms) as f64 / 112.0).trunc() as i32;
    state.beam_size_limit = state.beam_size_limit.min(state.max_beam_size * 3);
    if !safe {
        state.beam_size_limit = (state.beam_size_limit as f64 * 0.8).trunc() as i32;
    }
    state.depth_limit = 14;
}
