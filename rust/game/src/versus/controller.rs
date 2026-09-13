//! Versus controller: fighters, fair step model and the match tick.
//!
//! Faithful port of `createVersusController` / `think` / `stepSide` /
//! `tickVersus` in `src/versus/controller.ts`.

use super::flow::{exchange_garbage, run_gravity};
use super::state::{make_side, reset_side, SideState, VersusController, VersusResult, Winner};
use super::step::{apply_step, execution_matches, locks_piece, plan_steps, ApplyStepResult};
use super::{
    resolve_versus_config, AiFighter, ResolvedVersusConfig, Side, VersusConfig,
    VersusControllerOptions, MAX_CATCHUP_ITERATIONS, MAX_TICK_MS,
};
use crate::types::{AiStep, OpponentView};

impl VersusController {
    pub fn new(
        left_fighter: Box<dyn AiFighter>,
        right_fighter: Box<dyn AiFighter>,
        seed: i32,
        config: VersusConfig,
    ) -> VersusController {
        let resolved = resolve_versus_config(&config);
        let mut seeds_state: i32 = 0x1234_5678;
        VersusController {
            left: make_side(Side::Left, left_fighter, seed, &resolved),
            right: make_side(Side::Right, right_fighter, seed, &resolved),
            pieces: 0,
            result: None,
            rematch_in: None,
            config: resolved,
            clock: Box::new(|| 0.0),
            seed_source: Box::new(move || {
                seeds_state = (seeds_state.wrapping_mul(1103515245).wrapping_add(12345)) & 0x7fff_ffff;
                seeds_state
            }),
        }
    }

    pub fn config(&self) -> ResolvedVersusConfig {
        self.config
    }

    pub fn set_clock(&mut self, clock: Box<dyn Fn() -> f64>) {
        self.clock = clock;
    }

    pub fn set_seed_source(&mut self, seed_source: Box<dyn FnMut() -> i32>) {
        self.seed_source = seed_source;
    }

    /// `src/versus/controller.ts` `resetMatch`.
    pub fn reset_match(&mut self, seed: i32) {
        let config = self.config;
        reset_side(&mut self.left, seed, &config);
        reset_side(&mut self.right, seed, &config);
        self.pieces = 0;
        self.result = None;
        self.rematch_in = None;
    }

    /// `src/versus/controller.ts` `tick`.
    pub fn tick(&mut self, dt: f64, options: &VersusControllerOptions) {
        let step_dt = if dt > MAX_TICK_MS {
            MAX_TICK_MS
        } else if dt > 0.0 {
            dt
        } else {
            0.0
        };
        if self.result.is_some() {
            match self.rematch_in {
                None => self.rematch_in = Some(options.auto_rematch_ms),
                Some(remaining) => {
                    let next = remaining - step_dt;
                    if next <= 0.0 {
                        let seed = (self.seed_source)();
                        self.reset_match(seed);
                    } else {
                        self.rematch_in = Some(next);
                    }
                }
            }
            return;
        }
        let (locked_l, locked_r) = {
            let VersusController {
                left, right, clock, ..
            } = self;
            let l = step_side(left, right, step_dt, options, &**clock);
            let r = step_side(right, left, step_dt, options, &**clock);
            (l, r)
        };
        exchange_garbage(&mut self.left, &mut self.right);
        self.pieces += locked_l + locked_r;
        let snap_l = self.left.core.snapshot();
        let snap_r = self.right.core.snapshot();
        let execution_in_flight = (self.left.execution.is_some()
            && !self.left.queue.is_empty()
            && !snap_l.game_over)
            || (self.right.execution.is_some() && !self.right.queue.is_empty() && !snap_r.game_over);
        if (snap_l.game_over || snap_r.game_over) && !execution_in_flight {
            let (winner, reason) = if snap_l.game_over && snap_r.game_over {
                (Winner::Draw, "同時死亡")
            } else if snap_r.game_over {
                (Winner::Left, "KO")
            } else {
                (Winner::Right, "KO")
            };
            if winner == Winner::Left {
                self.left.wins += 1;
            }
            if winner == Winner::Right {
                self.right.wins += 1;
            }
            self.result = Some(VersusResult {
                winner,
                reason: reason.to_string(),
                pieces: self.pieces,
                lines_left: snap_l.lines,
                lines_right: snap_r.lines,
                sent_left: self.left.sent_total,
                sent_right: self.right.sent_total,
                left_error: self.left.last_error.clone(),
                right_error: self.right.last_error.clone(),
            });
            self.rematch_in = Some(options.auto_rematch_ms);
        }
    }
}

fn think(side: &mut SideState, opponent: &SideState, clock: &dyn Fn() -> f64) {
    let snapshot = side.core.snapshot();
    let Some(active) = snapshot.active else {
        return;
    };
    if snapshot.game_over {
        return;
    }
    let opponent_snap = opponent.core.snapshot();
    let opponent_transition = opponent.core.last_lock_transition().cloned();
    let mut decision = snapshot.clone();
    decision.opponent = Some(OpponentView {
        combo: opponent_snap.native_combo,
        btb: opponent_snap.native_btb,
        lock_id: opponent_snap.lock_id,
        board: opponent_snap.board,
        last_clear_lines: opponent_transition.as_ref().map(|t| t.lines_cleared),
        last_native_combo: opponent_transition.as_ref().map(|t| t.native_combo),
        last_native_btb: opponent_transition.as_ref().map(|t| t.native_btb),
        last_raw_attack: opponent_transition.as_ref().map(|t| t.raw_attack),
    });
    let t0 = clock();
    let mv = side.fighter.find_best_move(&decision);
    side.think_ms += clock() - t0;
    side.think_count += 1;
    let Some(mv) = mv else {
        side.garbage_wait = false;
        side.execution = None;
        side.queue = vec![AiStep::Drop];
        return;
    };
    side.garbage_wait = mv.garbage_wait.unwrap_or(false);
    if mv.use_hold {
        side.execution = None;
        side.queue = vec![AiStep::Hold];
        side.pending_think = true;
        return;
    }
    if let Some(execution) = &mv.execution {
        if !execution_matches(&snapshot, execution) {
            side.execution_source_mismatches += 1;
            side.execution = None;
            side.queue = vec![AiStep::Drop];
            return;
        }
    }
    side.execution = mv.execution.clone();
    side.queue = plan_steps(active.rotation, active.pos_x, &mv);
}

/// `src/versus/controller.ts` `stepSide`.
pub fn step_side(
    side: &mut SideState,
    opponent: &SideState,
    dt: f64,
    options: &VersusControllerOptions,
    clock: &dyn Fn() -> f64,
) -> i32 {
    let snap = side.core.snapshot();
    if snap.game_over {
        return 0;
    }
    let had_active = snap.active.is_some();
    if side.pending_think && side.queue.is_empty() && snap.active.is_some() {
        side.pending_think = false;
        think(side, opponent, clock);
    }
    side.acc += dt;
    let mut locked = 0;
    let mut iterations = 0;
    while !side.queue.is_empty()
        && options.step_interval_ms > 0.0
        && side.acc >= options.step_interval_ms
        && locked == 0
        && iterations < MAX_CATCHUP_ITERATIONS
    {
        iterations += 1;
        let queue_len = side.queue.len();
        let head = side.queue.remove(0);
        let terminal = locks_piece(&head) || matches!(head, AiStep::Hold);
        if terminal {
            side.acc -= options.step_interval_ms;
        }
        if locks_piece(&head) {
            side.core.set_garbage_wait(side.garbage_wait);
        }
        match apply_step(&mut side.core, &head, side.execution.as_ref()) {
            ApplyStepResult::Applied => {}
            ApplyStepResult::ExpectedBoardFailure => {
                side.execution_expected_board_failures += 1;
                side.execution = None;
                side.queue.clear();
                side.pending_think = true;
                return 0;
            }
        }
        if terminal {
            side.pending_think = queue_len <= 1;
        }
        if locks_piece(&head) {
            side.execution = None;
            side.garbage_wait = false;
            side.core.set_garbage_wait(false);
        }
        if locks_piece(&head) && had_active {
            locked = 1;
        }
    }
    if locked > 0 {
        return locked;
    }
    if side.queue.is_empty() {
        return run_gravity(side, dt, options);
    }
    0
}

