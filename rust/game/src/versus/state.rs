//! Versus side state and match result types.
//!
//! Faithful port of the `SideState` / `VersusResult` declarations in
//! `src/versus/controller.ts`.

use super::{AiFighter, ResolvedVersusConfig, Side};
use crate::engine::{EngineConfig, Game};
use crate::rng::SeededRng;
use crate::types::{AiExecutionPlan, AiStep};

/// `src/versus/controller.ts` `SideState`.
pub struct SideState {
    pub side: Side,
    pub core: Game,
    pub fighter: Box<dyn AiFighter>,
    pub think_ms: f64,
    pub think_count: i32,
    pub pending_think: bool,
    pub queue: Vec<AiStep>,
    pub execution: Option<AiExecutionPlan>,
    pub garbage_wait: bool,
    pub acc: f64,
    pub gravity_acc: f64,
    pub sent_total: i32,
    pub blocked_total: i32,
    pub processed_lock_id: i32,
    pub execution_source_mismatches: i32,
    pub execution_expected_board_failures: i32,
    pub last_error: Option<String>,
    pub error_count: i32,
    pub wins: i32,
}

/// `src/versus/controller.ts` `VersusResult.winner` (`VersusSide | "draw"`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Winner {
    Left,
    Right,
    Draw,
}

/// `src/versus/controller.ts` `VersusResult`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VersusResult {
    pub winner: Winner,
    pub reason: String,
    pub pieces: i32,
    pub lines_left: i32,
    pub lines_right: i32,
    pub sent_left: i32,
    pub sent_right: i32,
    pub left_error: Option<String>,
    pub right_error: Option<String>,
}

/// `src/versus/controller.ts` `VersusController`.
pub struct VersusController {
    pub left: SideState,
    pub right: SideState,
    pub pieces: i32,
    pub result: Option<VersusResult>,
    pub rematch_in: Option<f64>,
    pub(super) config: ResolvedVersusConfig,
    pub(super) clock: Box<dyn Fn() -> f64>,
    pub(super) seed_source: Box<dyn FnMut() -> i32>,
}

pub(super) fn make_side(
    side: Side,
    fighter: Box<dyn AiFighter>,
    seed: i32,
    config: &ResolvedVersusConfig,
) -> SideState {
    SideState {
        side,
        core: Game::with_config(
            Box::new(SeededRng::new(seed)),
            EngineConfig {
                garbage_delay: config.garbage_delay,
                garbage_aligned: config.garbage_aligned,
            },
        ),
        fighter,
        think_ms: 0.0,
        think_count: 0,
        pending_think: true,
        queue: Vec::new(),
        execution: None,
        garbage_wait: false,
        acc: 0.0,
        gravity_acc: 0.0,
        sent_total: 0,
        blocked_total: 0,
        processed_lock_id: 0,
        execution_source_mismatches: 0,
        execution_expected_board_failures: 0,
        last_error: None,
        error_count: 0,
        wins: 0,
    }
}

pub(super) fn reset_side(side: &mut SideState, seed: i32, config: &ResolvedVersusConfig) {
    side.core = Game::with_config(
        Box::new(SeededRng::new(seed)),
        EngineConfig {
            garbage_delay: config.garbage_delay,
            garbage_aligned: config.garbage_aligned,
        },
    );
    side.fighter.reset();
    side.think_ms = 0.0;
    side.think_count = 0;
    side.pending_think = true;
    side.queue.clear();
    side.execution = None;
    side.garbage_wait = false;
    side.acc = 0.0;
    side.gravity_acc = 0.0;
    side.sent_total = 0;
    side.blocked_total = 0;
    side.processed_lock_id = 0;
    side.execution_source_mismatches = 0;
    side.execution_expected_board_failures = 0;
    side.last_error = None;
    side.error_count = 0;
}

