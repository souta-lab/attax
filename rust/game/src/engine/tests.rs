//! Engine unit tests.
//!
//! Ports of the TypeScript regressions (`tests/game-logic-regressions.test.ts`,
//! `tests/v13-lock-transition.test.ts`) plus edge cases for garbage, hold and
//! the combo sign. T-spin classification itself is covered by `crate::tspin`;
//! the engine-level wiring of T-spins is covered by the TS differential
//! (`placeMinoAt` ops with nonzero `lastSrs`).

use super::*;
use crate::garbage::GARBAGE_DELAY;
use crate::rng::{Rng, SeededRng};
use crate::types::{PieceKind, TspinKind, COLS, EMPTY_CELL, GARBAGE_CELL, ROWS};

/// `random() => 0.999` makes the shuffle an identity in TS, so bags are
/// `[I, O, T, S, Z, J, L]` (`tests/game-logic-regressions.test.ts`).
struct ConstantRng(f64);

impl Rng for ConstantRng {
    fn next_f64(&mut self) -> f64 {
        self.0
    }
}

fn identity_engine() -> Game {
    Game::new(Box::new(ConstantRng(0.999)))
}

fn place(engine: &mut Game, rotation: i32, x: i32, top_row: i32, last_srs: i32) -> bool {
    engine.place_mino_at(rotation, x, top_row, last_srs)
}

#[test]
fn first_piece_order_is_the_identity_shuffle_bag() {
    let engine = identity_engine();
    let snapshot = engine.snapshot();
    assert_eq!(snapshot.active.unwrap().kind, PieceKind::I);
    assert_eq!(
        &snapshot.next[..6],
        &[
            PieceKind::O,
            PieceKind::T,
            PieceKind::S,
            PieceKind::Z,
            PieceKind::J,
            PieceKind::L
        ]
    );
}

#[test]
fn hard_drop_adds_two_per_cell_fallen() {
    let mut engine = identity_engine();
    let before = engine.snapshot();
    let active = before.active.unwrap();
    let ghost = before.ghost_y.unwrap();
    let distance = ghost - active.pos_y;
    assert!(distance > 0);

    engine.hard_drop();

    assert_eq!(engine.snapshot().score - before.score, 2 * distance);
}

#[test]
fn hard_drop_at_adds_two_per_cell_fallen() {
    let mut engine = identity_engine();
    let before = engine.snapshot();
    let active = before.active.unwrap();
    let ghost = before.ghost_y.unwrap();

    let placed = engine.hard_drop_at(active.rotation, active.pos_x);

    assert!(placed);
    assert_eq!(
        engine.snapshot().score - before.score,
        2 * (ghost - active.pos_y)
    );
}

#[test]
fn garbage_overflow_top_out() {
    // tests/game-logic-regressions.test.ts: the horizontal I locks into the top
    // row, so discarding that occupied top row on the next garbage spawn must
    // top out instead of silently deleting it.
    let mut engine = identity_engine();
    assert_eq!(engine.snapshot().active.unwrap().kind, PieceKind::I);

    assert!(place(&mut engine, 0, 0, -1, 0));
    assert!(!engine.snapshot().game_over);

    engine.receive_garbage(1);
    engine.hard_drop();

    assert!(engine.snapshot().game_over);
}

#[test]
fn lock_out_top_out() {
    let mut engine = identity_engine();
    assert!(place(&mut engine, 0, 0, -3, 0));
    assert!(engine.snapshot().game_over);
}

#[test]
fn a_fully_visible_lock_does_not_top_out() {
    let mut engine = identity_engine();
    assert!(place(&mut engine, 0, 0, 18, 0));
    assert!(!engine.snapshot().game_over);
    assert_eq!(engine.snapshot().lines, 0);
}

#[test]
fn native_combo_break_negates_a_live_combo_and_zero_stays_zero() {
    let mut engine = identity_engine();

    assert!(place(&mut engine, 0, 0, 18, 0)); // I -> row 19 cols 0-3
    assert!(place(&mut engine, 0, 3, 18, 0)); // O -> cols 4-5 rows 18-19
    assert!(place(&mut engine, 0, 6, 18, 0)); // T -> completes most of row 19
    assert!(place(&mut engine, 3, 8, 17, 0)); // S -> completes row 19

    let after_clear = engine.snapshot();
    assert_eq!(after_clear.lines, 1);
    assert_eq!(after_clear.native_combo, 1);
    assert_eq!(after_clear.combo, 0);

    assert!(place(&mut engine, 0, 0, 18, 0)); // Z -> locks without clearing
    assert_eq!(engine.snapshot().native_combo, -1);

    engine.hard_drop(); // J -> second no-clear lock
    assert_eq!(engine.snapshot().native_combo, 0);
}

#[test]
fn lock_transition_reports_the_post_clear_board_and_attack_fields() {
    let mut engine = identity_engine();
    assert!(engine.last_lock_transition().is_none());

    engine.hard_drop();

    let transition = engine.last_lock_transition().expect("transition");
    assert_eq!(transition.lock_id, 1);
    assert_eq!(transition.lines_cleared, 0);
    assert_eq!(transition.garbage_rows_applied, 0);
    assert_eq!(transition.action, LockAction::None);
    assert_eq!(transition.native_combo, 0);
    assert_eq!(transition.raw_attack, 0);
    assert_eq!(transition.sent_attack, 0);
    assert_eq!(transition.board_after_lock_clear.len(), ROWS);
    assert!(transition.board_after_lock_clear.iter().any(|&row| row != 0));
}

#[test]
fn pending_garbage_spawns_after_one_lock_and_is_aligned_per_chunk() {
    let mut engine = Game::with_config(
        Box::new(SeededRng::new(7)),
        EngineConfig {
            garbage_delay: GARBAGE_DELAY,
            garbage_aligned: true,
        },
    );
    engine.receive_garbage(2);
    assert_eq!(engine.snapshot().pending_garbage, 2);

    engine.hard_drop();

    let snapshot = engine.snapshot();
    assert_eq!(snapshot.pending_garbage, 0);
    let bottom = snapshot.board.grid[ROWS - 1];
    let above = snapshot.board.grid[ROWS - 2];
    let hole_of = |row: &[u8; COLS]| -> Option<usize> {
        let holes: Vec<usize> = (0..COLS).filter(|&x| row[x] == EMPTY_CELL).collect();
        if holes.len() == 1 { Some(holes[0]) } else { None }
    };
    assert_eq!(hole_of(&bottom), hole_of(&above));
    assert_eq!(
        bottom.iter().filter(|&&v| v == GARBAGE_CELL).count(),
        COLS - 1
    );
}

#[test]
fn per_row_garbage_can_pick_different_holes() {
    let mut engine = Game::with_config(
        Box::new(SeededRng::new(7)),
        EngineConfig {
            garbage_delay: GARBAGE_DELAY,
            garbage_aligned: false,
        },
    );
    engine.receive_garbage(6);
    engine.hard_drop();

    let grid = engine.snapshot().board.grid;
    let mut distinct = std::collections::HashSet::new();
    for y in ROWS - 6..ROWS {
        let holes: Vec<usize> = (0..COLS).filter(|&x| grid[y][x] == EMPTY_CELL).collect();
        assert_eq!(holes.len(), 1);
        distinct.insert(holes[0]);
    }
    assert!(
        distinct.len() > 1,
        "per-row holes should not all collapse to one column"
    );
}

#[test]
fn garbage_wait_defers_the_pending_tick_to_the_next_lock() {
    let mut engine = Game::with_config(
        Box::new(SeededRng::new(11)),
        EngineConfig {
            garbage_delay: GARBAGE_DELAY,
            garbage_aligned: true,
        },
    );
    engine.receive_garbage(1);
    engine.set_garbage_wait(true);
    engine.hard_drop();

    let after_first = engine.snapshot();
    assert_eq!(after_first.pending_garbage, 1);
    assert!(!after_first.game_over);

    engine.hard_drop();

    assert_eq!(engine.snapshot().pending_garbage, 0);
    assert!(engine.snapshot().board.grid[ROWS - 1].contains(&GARBAGE_CELL));
}

#[test]
fn hold_moves_the_piece_to_hold_and_swaps_back_at_row_zero() {
    let mut engine = identity_engine();
    engine.hold();

    let snapshot = engine.snapshot();
    assert_eq!(snapshot.hold, Some(PieceKind::I));
    assert_eq!(snapshot.active.unwrap().kind, PieceKind::O);
    assert_eq!(snapshot.active.unwrap().pos_y, 0);
    assert!(!snapshot.can_hold);

    engine.hold();
    assert_eq!(engine.snapshot().active.unwrap().kind, PieceKind::O);

    engine.hard_drop();
    assert!(engine.snapshot().can_hold);

    engine.hold();
    let swapped = engine.snapshot();
    assert_eq!(swapped.hold, Some(PieceKind::T));
    assert_eq!(swapped.active.unwrap().kind, PieceKind::I);
    assert_eq!(swapped.active.unwrap().pos_y, 0);
    assert_eq!(swapped.active.unwrap().rotation, 0);
}

#[test]
fn hold_is_blocked_until_the_piece_locks() {
    let mut engine = identity_engine();
    engine.hold();
    engine.hold();
    engine.hold();
    assert_eq!(engine.snapshot().active.unwrap().kind, PieceKind::O);
    assert_eq!(engine.snapshot().hold, Some(PieceKind::I));
}

#[test]
fn soft_drop_scores_one_per_row_and_locks_on_the_floor() {
    let mut engine = identity_engine();
    let before = engine.snapshot();
    engine.soft_drop();
    assert_eq!(engine.snapshot().score - before.score, 1);

    for _ in 0..(ROWS as i32 + 4) {
        engine.soft_drop();
    }
    assert_ne!(engine.snapshot().lock_id, before.lock_id);
}

#[test]
fn movement_clears_last_srs_and_rotation_resets_it() {
    let mut engine = identity_engine();
    engine.rotate_cw();
    engine.rotate_ccw();
    engine.move_left();
    engine.move_left();
    let snapshot = engine.snapshot();
    assert_eq!(snapshot.active.unwrap().rotation, 0);
    assert_eq!(snapshot.active.unwrap().pos_x, 1);
}

#[test]
fn gravity_tick_moves_down_then_locks() {
    let mut engine = identity_engine();
    let start = engine.snapshot().active.unwrap().pos_y;
    assert!(!engine.gravity_tick());
    assert_eq!(engine.snapshot().active.unwrap().pos_y, start + 1);

    let mut locks = 0;
    for _ in 0..(ROWS as i32 + 4) {
        if engine.gravity_tick() {
            locks += 1;
            break;
        }
    }
    assert_eq!(locks, 1);
    assert_eq!(engine.snapshot().lock_id, 1);
}

#[test]
fn outbox_is_zero_without_an_attack_and_drains_once() {
    let mut engine = identity_engine();
    assert_eq!(engine.drain_outbox(), 0);
    assert_eq!(engine.drain_outbox(), 0);

    assert!(place(&mut engine, 0, 0, 18, 0));
    assert!(place(&mut engine, 0, 3, 18, 0));
    assert!(place(&mut engine, 0, 6, 18, 0));
    assert!(place(&mut engine, 3, 8, 17, 0)); // single clear -> 0 attack

    assert_eq!(engine.drain_outbox(), 0);
}

#[test]
fn reset_restores_a_fresh_match_state() {
    let mut engine = identity_engine();
    engine.hold();
    engine.hard_drop();
    engine.receive_garbage(2);
    assert!(engine.snapshot().lock_id > 0);

    engine.reset();

    let snapshot = engine.snapshot();
    assert_eq!(snapshot.lock_id, 0);
    assert_eq!(snapshot.lines, 0);
    assert_eq!(snapshot.score, 0);
    assert_eq!(snapshot.pending_garbage, 0);
    assert_eq!(snapshot.hold, None);
    assert!(snapshot.can_hold);
    assert_eq!(snapshot.active.unwrap().kind, PieceKind::I);
    assert!(engine.last_lock_transition().is_none());
}

#[test]
fn action_for_clear_orders_perfect_clear_before_quad() {
    assert_eq!(
        action_for_clear(0, TspinKind::None, false),
        LockAction::None
    );
    assert_eq!(
        action_for_clear(4, TspinKind::None, true),
        LockAction::Pc
    );
    assert_eq!(
        action_for_clear(4, TspinKind::None, false),
        LockAction::Quad
    );
    assert_eq!(
        action_for_clear(1, TspinKind::Full, false),
        LockAction::Tss
    );
    assert_eq!(
        action_for_clear(2, TspinKind::Mini, false),
        LockAction::Tsm
    );
    assert_eq!(
        action_for_clear(3, TspinKind::Full, false),
        LockAction::Tst
    );
}

#[test]
fn spawn_y_matches_the_ts_non_negative_floor() {
    // TS `spawnY` starts minY at 0 and only lowers it for negative cell rows,
    // so every rotation-0 piece (including I, whose cells are all y >= 1)
    // spawns at row 0.
    for kind in PieceKind::ALL {
        assert_eq!(spawn::spawn_y(kind), 0, "{kind:?}");
    }
}

#[test]
fn board_view_uses_top_down_rows_like_the_ts_grid() {
    let mut engine = identity_engine();
    assert!(place(&mut engine, 0, 0, 18, 0));
    let snapshot = engine.snapshot();
    assert_ne!(snapshot.board.grid[ROWS - 1][0], EMPTY_CELL);
    assert_ne!(snapshot.board.grid[ROWS - 1][3], EMPTY_CELL);
    assert_eq!(snapshot.board.grid[ROWS - 1][4], EMPTY_CELL);
    assert_eq!(snapshot.board.grid[0][0], EMPTY_CELL);
}

#[test]
fn placing_without_an_active_piece_or_after_game_over_fails() {
    let mut engine = identity_engine();
    assert!(place(&mut engine, 0, 0, -3, 0));
    assert!(engine.snapshot().game_over);
    assert!(!place(&mut engine, 0, 0, 18, 0));
    assert!(!engine.hard_drop_at(0, 0));
}
