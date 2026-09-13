//! Versus controller unit tests.
//!
//! Ports of `tests/versus-controller.test.ts`, `tests/versus-config.test.ts`
//! and `tests/versus-rng.test.ts`, plus a deterministic headless smoke match.

use super::*;
use crate::types::{AiExecutionPlan, AiStep, COLS, ROWS};
use crate::Game;

struct ScriptedFighter<F: FnMut(&GameSnapshot) -> Option<AiMove>> {
    f: F,
}

impl<F: FnMut(&GameSnapshot) -> Option<AiMove>> AiFighter for ScriptedFighter<F> {
    fn find_best_move(&mut self, snapshot: &GameSnapshot) -> Option<AiMove> {
        (self.f)(snapshot)
    }
}

fn fighter<F>(f: F) -> Box<dyn AiFighter>
where
    F: FnMut(&GameSnapshot) -> Option<AiMove> + 'static,
{
    Box::new(ScriptedFighter { f })
}

fn plain_move(target_x: i32, target_rotation: i32, use_hold: bool) -> AiMove {
    AiMove {
        target_x,
        target_rotation,
        use_hold,
        garbage_wait: None,
        execution: None,
    }
}

fn spread_move(snapshot: &GameSnapshot) -> Option<AiMove> {
    if snapshot.active.is_none() {
        return None;
    }
    let idx = snapshot.lock_id;
    Some(plain_move((idx * 3) % 7, idx % 4, false))
}

fn spread_fighter() -> Box<dyn AiFighter> {
    fighter(|snapshot| spread_move(snapshot))
}

fn plan_move(snapshot: &GameSnapshot, steps: Vec<AiStep>) -> AiMove {
    let active = snapshot.active.expect("active");
    AiMove {
        target_x: active.pos_x,
        target_rotation: active.rotation,
        use_hold: false,
        garbage_wait: None,
        execution: Some(AiExecutionPlan {
            target_x: active.pos_x,
            target_rotation: active.rotation,
            steps,
            expected_board: Vec::new(),
            expected_lines_cleared: 0,
            source_active_kind: active.kind,
            source_rotation: active.rotation,
            source_x: active.pos_x,
            source_board_fingerprint: board_fingerprint(snapshot),
            source_hold: snapshot.hold,
            source_can_hold: snapshot.can_hold,
        }),
    }
}

fn controller(left: Box<dyn AiFighter>, right: Box<dyn AiFighter>, seed: i32) -> VersusController {
    VersusController::new(left, right, seed, VersusConfig::default())
}

#[test]
fn plan_steps_picks_the_shorter_rotation_and_moves_to_target_x() {
    let cw = plan_steps(0, 3, &plain_move(3, 1, false));
    assert_eq!(cw, vec![AiStep::RotateCW, AiStep::Drop]);

    let ccw = plan_steps(0, 3, &plain_move(3, 3, false));
    assert_eq!(ccw, vec![AiStep::RotateCCW, AiStep::Drop]);

    let right = plan_steps(0, 1, &plain_move(4, 0, false));
    assert_eq!(right, vec![AiStep::Right, AiStep::Right, AiStep::Right, AiStep::Drop]);

    let left = plan_steps(0, 4, &plain_move(1, 0, false));
    assert_eq!(left, vec![AiStep::Left, AiStep::Left, AiStep::Left, AiStep::Drop]);

    let hold = plan_steps(0, 3, &plain_move(3, 0, true));
    assert_eq!(hold, vec![AiStep::Hold, AiStep::Drop]);

    let tie = plan_steps(0, 0, &plain_move(0, 2, false));
    assert_eq!(tie, vec![AiStep::RotateCW, AiStep::RotateCW, AiStep::Drop]);
}

#[test]
fn plan_steps_returns_the_execution_steps_verbatim_without_hold() {
    let snapshot = controller(spread_fighter(), spread_fighter(), 1)
        .left
        .core
        .snapshot();
    let mut mv = plan_move(&snapshot, vec![AiStep::Left, AiStep::Drop]);
    mv.execution.as_mut().unwrap().steps = vec![AiStep::Right, AiStep::Drop];
    assert_eq!(
        plan_steps(0, 3, &mv),
        vec![AiStep::Right, AiStep::Drop]
    );

    let with_hold = AiMove {
        use_hold: true,
        ..mv
    };
    assert_eq!(
        plan_steps(0, 3, &with_hold),
        vec![AiStep::Hold, AiStep::Drop]
    );
}

#[test]
fn board_fingerprint_covers_the_last_column_and_empty_board() {
    let mut ctrl = controller(spread_fighter(), spread_fighter(), 1);
    let mut snapshot = ctrl.left.core.snapshot();
    snapshot.board.grid[ROWS - 1][COLS - 1] = 1;
    let rows: Vec<u16> = board_fingerprint(&snapshot)
        .split(',')
        .map(|value| value.parse().expect("bit row"))
        .collect();
    assert_eq!(rows[0], 1 << (COLS - 1));

    ctrl.left.core = Game::new(Box::new(crate::rng::SeededRng::new(1)));
    let empty = board_fingerprint(&ctrl.left.core.snapshot());
    assert_eq!(empty, vec!["0"; ROWS].join(","));
}

#[test]
fn accumulator_keeps_the_leftover_instead_of_dropping_it() {
    let mut ctrl = controller(
        fighter(|snapshot| snapshot.active.map(|_| plain_move(0, 0, false))),
        fighter(|snapshot| snapshot.active.map(|_| plain_move(0, 0, false))),
        1,
    );
    ctrl.tick(200.0, &VERSUS_DEFAULTS);
    assert_eq!(ctrl.left.acc, 200.0 - VERSUS_DEFAULTS.step_interval_ms);
    assert_eq!(ctrl.right.acc, 200.0 - VERSUS_DEFAULTS.step_interval_ms);
}

#[test]
fn cosmetic_execution_steps_do_not_delay_locks_relative_to_a_bare_place_at() {
    let bare = fighter(|snapshot| {
        snapshot
            .active
            .map(|_| plan_move(snapshot, vec![AiStep::PlaceAt { rotation: 0, x: 0, top_row: Some(18), last_srs: Some(0) }]))
    });
    let cosmetic = fighter(|snapshot| {
        snapshot.active.map(|_| {
            plan_move(
                snapshot,
                vec![
                    AiStep::Left,
                    AiStep::Left,
                    AiStep::PlaceAt { rotation: 0, x: 0, top_row: Some(18), last_srs: Some(0) },
                ],
            )
        })
    });
    let mut ctrl = controller(bare, cosmetic, 1);
    for tick in 1..=8 {
        ctrl.tick(VERSUS_DEFAULTS.step_interval_ms, &VERSUS_DEFAULTS);
        assert_eq!(ctrl.left.core.snapshot().lock_id, tick);
        assert_eq!(ctrl.right.core.snapshot().lock_id, tick);
    }
}

#[test]
fn execution_source_mismatch_resets_to_a_plain_drop_and_counts() {
    let stale = fighter(|snapshot| {
        snapshot.active.map(|_| {
            let mut mv = plan_move(snapshot, vec![AiStep::Drop]);
            let execution = mv.execution.as_mut().unwrap();
            execution.source_board_fingerprint = "1,2,3".to_string();
            mv
        })
    });
    let mut ctrl = controller(stale, spread_fighter(), 1);
    ctrl.tick(16.0, &VERSUS_DEFAULTS);

    assert_eq!(ctrl.left.execution_source_mismatches, 1);
    assert!(ctrl.left.execution.is_none());
    assert_eq!(ctrl.left.queue, vec![AiStep::Drop]);
    assert_eq!(ctrl.left.core.snapshot().lock_id, 0);
}

#[test]
fn malformed_expected_board_aborts_the_queue_and_counts() {
    let malformed = fighter(|snapshot| snapshot.active.map(|_| plan_move(snapshot, vec![AiStep::Drop])));
    let mut ctrl = controller(malformed, spread_fighter(), 1);
    ctrl.tick(VERSUS_DEFAULTS.step_interval_ms, &VERSUS_DEFAULTS);

    assert_eq!(ctrl.left.execution_expected_board_failures, 1);
    assert!(ctrl.left.execution.is_none());
    assert!(ctrl.left.queue.is_empty());
    assert!(ctrl.left.pending_think);
}

#[test]
fn place_at_without_a_top_row_uses_hard_drop_at_and_falls_back_to_hard_drop() {
    let valid = fighter(|snapshot| {
        snapshot.active.map(|_| {
            plan_move(
                snapshot,
                vec![AiStep::PlaceAt { rotation: 0, x: 0, top_row: None, last_srs: None }],
            )
        })
    });
    let invalid = fighter(|snapshot| {
        snapshot.active.map(|_| {
            plan_move(
                snapshot,
                vec![AiStep::PlaceAt { rotation: 0, x: 40, top_row: None, last_srs: None }],
            )
        })
    });
    let mut ctrl = controller(valid, invalid, 1);
    ctrl.tick(VERSUS_DEFAULTS.step_interval_ms, &VERSUS_DEFAULTS);
    assert_eq!(ctrl.left.core.snapshot().lock_id, 1);
    assert_eq!(ctrl.right.core.snapshot().lock_id, 1);
    assert_eq!(ctrl.left.execution_expected_board_failures, 0);
}

#[test]
fn gravity_accumulator_keeps_the_leftover_and_drops_four_times() {
    let mut ctrl = controller(spread_fighter(), spread_fighter(), 1);
    ctrl.left.pending_think = false;
    ctrl.right.pending_think = false;
    ctrl.left.queue.clear();
    ctrl.right.queue.clear();
    let options = VersusControllerOptions {
        gravity_ms: 100.0,
        ..VERSUS_DEFAULTS
    };

    ctrl.tick(250.0, &options);

    assert_eq!(ctrl.left.gravity_acc, 50.0);
    assert_eq!(ctrl.right.gravity_acc, 50.0);
    assert_eq!(ctrl.left.core.snapshot().active.unwrap().pos_y, 2);
    assert_eq!(ctrl.right.core.snapshot().active.unwrap().pos_y, 2);
}

// `placeAt` without a top row hard-drops at the target column: the landing is
// independent of when gravity has moved the piece, and the huge gravity
// interval keeps gravity from ever locking a piece, matching the TS
// accumulator tests (which used a mock core whose `gravityTick` never locks).
fn drop_at_fighter() -> Box<dyn AiFighter> {
    fighter(|snapshot| {
        let active = snapshot.active?;
        let target_x = (snapshot.lock_id * 3) % 7;
        Some(AiMove {
            target_x,
            target_rotation: active.rotation,
            use_hold: false,
            garbage_wait: None,
            execution: Some(AiExecutionPlan {
                target_x,
                target_rotation: active.rotation,
                steps: vec![AiStep::PlaceAt {
                    rotation: active.rotation,
                    x: target_x,
                    top_row: None,
                    last_srs: None,
                }],
                expected_board: Vec::new(),
                expected_lines_cleared: 0,
                source_active_kind: active.kind,
                source_rotation: active.rotation,
                source_x: active.pos_x,
                source_board_fingerprint: board_fingerprint(snapshot),
                source_hold: snapshot.hold,
                source_can_hold: snapshot.can_hold,
            }),
        })
    })
}

fn run_locks(irregular: bool, total_ms: i32) -> (i32, i32) {
    let options = VersusControllerOptions {
        gravity_ms: 1.0e9,
        ..VERSUS_DEFAULTS
    };
    let mut ctrl = controller(drop_at_fighter(), drop_at_fighter(), 1);
    let mut elapsed = 0;
    let pattern = [16.0, 200.0, 37.0];
    let mut index = 0;
    while elapsed < total_ms {
        let dt = if irregular { pattern[index % 3] } else { 1.0 };
        ctrl.tick(dt, &options);
        elapsed += dt as i32;
        index += 1;
    }
    let left = ctrl.left.core.snapshot();
    let right = ctrl.right.core.snapshot();
    (left.lock_id + right.lock_id, ctrl.pieces)
}

#[test]
fn irregular_dt_locks_the_same_number_of_pieces_as_uniform_small_ticks() {
    let total = 2530;
    let (irregular_locks, irregular_pieces) = run_locks(true, total);
    let (uniform_locks, uniform_pieces) = run_locks(false, total);

    assert_eq!(irregular_locks, uniform_locks);
    assert_eq!(irregular_pieces, uniform_pieces);
    assert_eq!(irregular_locks, 2 * (total / VERSUS_DEFAULTS.step_interval_ms as i32));
}

#[test]
fn versus_config_resolves_to_the_canonical_match_rules() {
    assert_eq!(
        resolve_versus_config(&VersusConfig::default()),
        VERSUS_MATCH_CONFIG
    );
    assert_eq!(VERSUS_MATCH_CONFIG.garbage_aligned, true);
    assert_eq!(VERSUS_MATCH_CONFIG.garbage_delay, crate::garbage::GARBAGE_DELAY);
    assert_eq!(
        resolve_versus_config(&VersusConfig {
            garbage_delay: Some(3),
            ..Default::default()
        }),
        ResolvedVersusConfig {
            garbage_delay: 3,
            garbage_aligned: true
        }
    );
    assert_eq!(
        resolve_versus_config(&VersusConfig {
            garbage_aligned: Some(false),
            ..Default::default()
        }),
        ResolvedVersusConfig {
            garbage_delay: crate::garbage::GARBAGE_DELAY,
            garbage_aligned: false
        }
    );
}

#[test]
fn speed_options_scale_the_ai_and_gravity_intervals_only() {
    let fast = speed_options(4.0);
    assert_eq!(fast.step_interval_ms, 30.0);
    assert_eq!(fast.gravity_ms, 125.0);
    assert_eq!(fast.auto_rematch_ms, VERSUS_DEFAULTS.auto_rematch_ms);
    assert_eq!(speed_options(0.5).step_interval_ms, 240.0);
}

#[test]
fn headless_smoke_match_is_deterministic_and_reaches_a_result() {
    let run = || {
        let mut ctrl = controller(spread_fighter(), spread_fighter(), 12345);
        let mut ticks = 0;
        while ctrl.result.is_none() && ticks < 60_000 {
            ctrl.tick(16.0, &VERSUS_DEFAULTS);
            ticks += 1;
        }
        (ticks, ctrl.result.clone(), ctrl.pieces)
    };
    let (ticks, result, pieces) = run();
    let result = result.expect("smoke match should finish");
    assert!(ticks < 60_000);
    assert!(pieces > 0);
    assert!(matches!(result.winner, Winner::Left | Winner::Right | Winner::Draw));
    assert!(result.reason == "KO" || result.reason == "同時死亡");
    assert_eq!(result.pieces, pieces);

    let (ticks2, result2, pieces2) = run();
    assert_eq!(ticks, ticks2);
    assert_eq!(pieces, pieces2);
    assert_eq!(result2, Some(result));

    let mut ctrl = controller(spread_fighter(), spread_fighter(), 12345);
    ctrl.left.execution_expected_board_failures = 0;
    while ctrl.result.is_none() {
        ctrl.tick(16.0, &VERSUS_DEFAULTS);
    }
    assert_eq!(ctrl.left.execution_source_mismatches, 0);
    assert_eq!(ctrl.right.execution_source_mismatches, 0);
}

#[test]
fn rematch_resets_the_match_after_the_countdown() {
    let options = VersusControllerOptions {
        auto_rematch_ms: 10.0,
        ..VERSUS_DEFAULTS
    };
    let mut ctrl = controller(spread_fighter(), spread_fighter(), 12345);
    while ctrl.result.is_none() {
        ctrl.tick(16.0, &options);
    }
    assert_eq!(ctrl.rematch_in, Some(10.0));

    ctrl.tick(16.0, &options);

    assert!(ctrl.result.is_none());
    assert!(ctrl.rematch_in.is_none());
    assert_eq!(ctrl.pieces, 0);
    assert_eq!(ctrl.left.core.snapshot().lock_id, 0);
    assert_eq!(ctrl.right.core.snapshot().lock_id, 0);
}

#[test]
fn inactive_engines_do_not_think_or_queue_steps() {
    let make_thinking = || {
        fighter(|snapshot| {
            assert!(snapshot.active.is_some());
            Some(plain_move(0, 0, false))
        })
    };
    let mut ctrl = controller(make_thinking(), make_thinking(), 1);
    for _ in 0..5 {
        ctrl.tick(16.0, &VERSUS_DEFAULTS);
    }
    assert_eq!(ctrl.left.think_count, 1);
    assert_eq!(ctrl.right.think_count, 1);
    assert_eq!(ctrl.left.execution_source_mismatches, 0);
}

#[test]
fn versus_controller_uses_the_canonical_config_by_default() {
    let mut ctrl = controller(spread_fighter(), spread_fighter(), 7);
    ctrl.left.core.receive_garbage(2);
    ctrl.tick(VERSUS_DEFAULTS.step_interval_ms, &VERSUS_DEFAULTS);
    let fingerprint = |grid: &[[u8; COLS]; ROWS]| {
        (0..ROWS)
            .map(|y| {
                let mut bits = 0u16;
                for x in 0..COLS {
                    if grid[y][x] != 0 {
                        bits |= 1u16 << x;
                    }
                }
                bits.to_string()
            })
            .collect::<Vec<String>>()
            .join(",")
    };
    let snapshot = ctrl.left.core.snapshot();
    let default_aligned = fingerprint(&snapshot.board.grid);

    let mut per_row = VersusController::new(
        spread_fighter(),
        spread_fighter(),
        7,
        VersusConfig {
            garbage_aligned: Some(false),
            ..Default::default()
        },
    );
    per_row.left.core.receive_garbage(2);
    per_row.tick(VERSUS_DEFAULTS.step_interval_ms, &VERSUS_DEFAULTS);
    let per_row_fp = fingerprint(&per_row.left.core.snapshot().board.grid);
    assert_ne!(default_aligned, per_row_fp);

    let mut explicit = VersusController::new(spread_fighter(), spread_fighter(), 7, VersusConfig::default());
    explicit.left.core.receive_garbage(2);
    explicit.tick(VERSUS_DEFAULTS.step_interval_ms, &VERSUS_DEFAULTS);
    assert_eq!(
        fingerprint(&explicit.left.core.snapshot().board.grid),
        default_aligned
    );
}
