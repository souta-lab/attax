//! Gravity stepping and per-tick garbage exchange.
//!
//! Faithful port of `runGravity` / `exchangeGarbage` in
//! `src/versus/controller.ts`.

use super::state::SideState;
use super::{VersusControllerOptions, MAX_CATCHUP_ITERATIONS};

pub(super) fn run_gravity(side: &mut SideState, dt: f64, options: &VersusControllerOptions) -> i32 {
    if options.gravity_ms <= 0.0 {
        return 0;
    }
    side.gravity_acc += dt;
    let mut locked = 0;
    let mut iterations = 0;
    while side.gravity_acc >= options.gravity_ms
        && locked == 0
        && iterations < MAX_CATCHUP_ITERATIONS
    {
        iterations += 1;
        side.gravity_acc -= options.gravity_ms;
        if side.core.gravity_tick() {
            side.pending_think = true;
            locked = 1;
        }
    }
    locked
}

pub(super) fn exchange_garbage(left: &mut SideState, right: &mut SideState) {
    let out_l = left.core.drain_outbox();
    let out_r = right.core.drain_outbox();
    if out_l > 0 {
        right.core.receive_garbage(out_l);
        left.sent_total += out_l;
    }
    if out_r > 0 {
        left.core.receive_garbage(out_r);
        right.sent_total += out_r;
    }
    let snap_l = left.core.snapshot();
    if snap_l.lock_id != left.processed_lock_id {
        left.blocked_total += snap_l.last_blocked;
        left.processed_lock_id = snap_l.lock_id;
    }
    let snap_r = right.core.snapshot();
    if snap_r.lock_id != right.processed_lock_id {
        right.blocked_total += snap_r.last_blocked;
        right.processed_lock_id = snap_r.lock_id;
    }
}

