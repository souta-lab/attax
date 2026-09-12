//! C-ABI call surface for the wasm/FFI host.
//!
//! One call per move: `run_search_ffi` builds the root, runs the search,
//! optionally applies own/opponent lock events (`sync`), runs the offset wait
//! gate (`decide`) and writes the first-move result plus the adapted search and
//! offset state for the next call. This module is entirely safe; only the
//! pointer arguments in `hoiko-wasm` touch `unsafe`.
//!
//! Clock: wasm32 has no wall clock, so the host passes `now_ms` and the search
//! sees a constant `now()` — the time-limit cutoffs never fire and the search
//! always runs to `depth_limit`. This is exactly the deterministic depth-10/14
//! configuration the differential verifies; a time-capped shipping search would
//! need a host clock import (UNDETERMINED here, out of scope).
//!
//! Memory layout (`#[repr(C)]`, all fields `i32` except the leading `f64`s):
//! `HSearchInput.nexus` is at byte 0 (4 × 8 B), then `weight`/`column`/
//! `combo_table` (`[i32; 50/10/5]` × 4), then a flat sequence of `i32` fields in
//! declaration order; `HSearchOutput.over_time` is at byte 0, then a flat
//! sequence of `i32`. Both structs contain at most one `f64` run at the start,
//! so no interior padding exists and a host can fill them sequentially.

use crate::offset::{GarbageData, OffsetData, OffsetOffAI};
use crate::offset_driver::{
    DriverSnapshot, HoikoOffsetDriver, LockAction, OffsetDecisionInput,
};
use crate::evaluate::{EvalFlags, VsFlags};
use crate::probe::{build_root, build_root_carried, NextCarry, ProbeInput};
use crate::search::{run_search, set_next_option, SearchState};
use crate::weights::HoikoWeights;

mod layout;
pub use layout::{HSearchInput, HSearchOutput, MAX_PLAN_ACTS, MAX_WEIGHTS};

fn b(v: i32) -> bool {
    v != 0
}

fn i(v: bool) -> i32 {
    if v { 1 } else { 0 }
}

fn optional(has: i32, value: i32) -> Option<i32> {
    if has != 0 { Some(value) } else { None }
}

fn lock_action_from_code(code: i32) -> LockAction {
    match code {
        1 => LockAction::Single,
        2 => LockAction::Double,
        3 => LockAction::Triple,
        4 => LockAction::Quad,
        5 => LockAction::Tss,
        6 => LockAction::Tsd,
        7 => LockAction::Tst,
        8 => LockAction::Tsm,
        9 => LockAction::Pc,
        _ => LockAction::None,
    }
}

fn build_driver(input: &HSearchInput) -> HoikoOffsetDriver {
    let offset = OffsetOffAI {
        use_offset_off: b(input.use_offset_off),
        ofs_data: OffsetData {
            can_wait_garbage: b(input.ofs_can_wait_garbage),
            center4_height: input.ofs_center4_height,
            atk: input.ofs_atk,
            pc_chance: b(input.ofs_pc_chance),
            near_offset: b(input.ofs_near_offset),
        },
        gb_data: GarbageData {
            opponents_atk: input.gb_opponents_atk,
            cool_time: input.gb_cool_time,
            remaining_time: input.gb_remaining_time,
            opponents_lock_count: input.gb_opponents_lock_count,
            first_invalid_lock: b(input.gb_first_invalid_lock),
        },
    };
    HoikoOffsetDriver::from_state(
        offset,
        b(input.offset_enabled),
        optional(input.has_last_own_lock, input.last_own_lock_id),
        optional(input.has_last_opp_lock, input.last_opp_lock_id),
    )
}

fn write_out(out: &mut HSearchOutput, state: &SearchState, driver: &HoikoOffsetDriver) {
    out.max_beam_size = state.max_beam_size;
    out.beam_size_limit = state.beam_size_limit;
    out.timer_limit_ms = state.timer_limit_ms;
    out.weight_index = state.weight_index;
    let ofs = driver.offset.ofs_data;
    let gb = driver.offset.gb_data;
    out.use_offset_off = i(driver.offset.use_offset_off);
    out.ofs_can_wait_garbage = i(ofs.can_wait_garbage);
    out.ofs_center4_height = ofs.center4_height;
    out.ofs_atk = ofs.atk;
    out.ofs_pc_chance = i(ofs.pc_chance);
    out.ofs_near_offset = i(ofs.near_offset);
    out.gb_opponents_atk = gb.opponents_atk;
    out.gb_cool_time = gb.cool_time;
    out.gb_remaining_time = gb.remaining_time;
    out.gb_opponents_lock_count = gb.opponents_lock_count;
    out.gb_first_invalid_lock = i(gb.first_invalid_lock);
    out.has_last_own_lock = i(driver.last_own_lock_id.is_some());
    out.last_own_lock_id = driver.last_own_lock_id.unwrap_or(0);
    out.has_last_opp_lock = i(driver.last_opponent_lock_id.is_some());
    out.last_opp_lock_id = driver.last_opponent_lock_id.unwrap_or(0);
}

/// Run one move. Returns 1 with a filled `out` when a first move exists, else 0.
pub fn run_search_ffi(input: &HSearchInput, out: &mut HSearchOutput) -> i32 {
    out.ok = 0;
    out.garbage_wait = 0;
    out.plan_len = 0;
    out.plan_acts = [0; MAX_PLAN_ACTS];

    let weight_count = input.weight_count.clamp(1, MAX_WEIGHTS as i32) as usize;
    let mut weights = Vec::with_capacity(weight_count);
    for i in 0..weight_count {
        weights.push(HoikoWeights {
            weight: input.weight[i],
            column: input.column[i],
            combo_table: input.combo_table[i],
            nexus: input.nexus[i],
        });
    }

    let mut state = SearchState {
        max_beam_size: input.max_beam_size,
        beam_size_limit: input.beam_size_limit,
        timer_limit_ms: input.timer_limit_ms,
        weight_index: input.weight_index,
        min_depth: input.min_depth,
        depth_limit: input.depth_limit,
    };

    let vs = VsFlags {
        multi_evaluation: b(input.multi_evaluation),
        opponent_is_pc_board: b(input.opponent_is_pc_board),
        opponent_is_powerful_board: b(input.opponent_is_powerful_board),
        opponents_combo: input.opponents_combo,
    };
    let flags = EvalFlags {
        is_even_board: b(input.is_even_board),
        use_s4w: b(input.use_s4w),
        use_pcstack: b(input.use_pcstack),
        vs,
    };
    let probe = ProbeInput {
        board: input.board.to_vec(),
        current: input.current,
        queue: input.next.to_vec(),
        hold: input.hold,
        combo: input.combo,
        btb: input.btb,
        view_next: input.view_next,
        weight_index: input.weight_index,
        is_even: b(input.is_even_board),
        use_s4w: b(input.use_s4w),
        use_pcstack: b(input.use_pcstack),
        vs,
        trust_rate: 1.0,
    };
    let root = if input.next_carry != 0 {
        let mut m = [0i32; 28];
        m.copy_from_slice(&input.next_carry_m);
        build_root_carried(
            &probe,
            &NextCarry {
                m,
                trust_end: input.next_carry_trust_end,
                bag_remains: input.next_carry_bag_remains,
            },
        )
    } else {
        build_root(&probe)
    };

    let mut driver = build_driver(input);
    if input.sync_enabled != 0 {
        driver.sync(
            &DriverSnapshot {
                lock_id: input.sync_lock_id,
                last_action: lock_action_from_code(input.sync_last_action),
                last_attack: input.sync_last_attack,
                opponent_lock_id: optional(input.sync_has_opp_lock, input.sync_opp_lock_id),
                opponent_last_clear_lines: input.sync_opp_clear_lines,
                opponent_last_native_btb: input.sync_opp_btb,
                opponent_last_native_combo: input.sync_opp_combo,
            },
            input.sync_now_ms as f64,
        );
    }

    let now_value = input.now_ms as f64;
    let now = move || now_value;
    let outcome = run_search(
        &mut state,
        &root,
        &weights,
        flags,
        input.view_next,
        &now,
        Some(input.time_limit_ms),
        b(input.allow_hold),
    );

    let Some(o) = outcome else {
        write_out(out, &state, &driver);
        return 0;
    };

    if input.adapt != 0 {
        set_next_option(&mut state, o.over_time, o.depth, o.move_delay, o.first_act, root.is_safe());
    }

    let next_snapshot = root.next_it.snapshot();
    let garbage_wait = driver.decide(
        &OffsetDecisionInput {
            plan_acts: &o.plan_acts,
            depth: o.depth,
            hold: o.first_state.hold_m,
            next: next_snapshot.as_ref(),
            btb: o.first_state.btb,
            is_even_board: b(input.is_even_board),
            board: &o.first_state.board,
            pending_garbage: input.pending_garbage,
        },
        now_value,
    );

    out.ok = 1;
    out.over_time = o.over_time;
    out.x = o.first_x;
    out.rotation = o.first_placement.rotation;
    out.y = o.first_placement.y;
    out.last_srs = o.first_placement.last_srs;
    out.use_hold = i(o.first_hold);
    out.first_r_raw = o.first_r;
    out.first_m = o.first_m;
    out.first_act = o.first_act;
    out.move_delay = o.move_delay;
    let n = o.plan_acts.len().min(MAX_PLAN_ACTS);
    out.plan_len = n as i32;
    out.plan_acts[..n].copy_from_slice(&o.plan_acts[..n]);
    out.score = o.score;
    out.depth = o.depth;
    out.node = o.node;
    out.garbage_wait = i(garbage_wait);
    write_out(out, &state, &driver);
    1
}

#[cfg(test)]
mod tests;
