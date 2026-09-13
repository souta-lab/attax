//! Contract helper tests.
//!
//! The `NextState` golden vectors are ported verbatim from
//! `tests/hoiko-next.test.ts` (which captured them from the shipping exe stub);
//! they pin the carried-queue state machine to the exe, not to a re-derivation.
//! The opponent-flag corpus differential lives in `tests/differential.rs`.

use super::bridge::*;
use super::faithful::*;
use super::next::*;
use super::opponent::*;
use crate::types::*;

fn bag_sequence(len: usize) -> Vec<i32> {
    (0..len).map(|i| (i % 7) as i32).collect()
}

#[test]
fn fresh_bag_order_and_trust_range_table() {
    let mut n = NextState::new(2);
    n.init(&[]);
    assert_eq!(
        &n.m[..10],
        &[MINO_NONE, MINO_NONE, 4, 3, 1, 2, 0, 6, 5, 4]
    );
    assert_eq!(n.bag_remains, 6);
    assert_eq!(n.trust_end, 3);
    assert_eq!(
        [
            trust_range(6),
            trust_range(5),
            trust_range(4),
            trust_range(0),
            trust_range(7)
        ],
        [2, 1, 0, 3, 0]
    );
}

#[test]
fn shift_and_compare_matches_the_exe_stub_nextdump() {
    let seq = bag_sequence(NEXT_SIZE);
    let mut n = NextState::new(2);
    n.init(&seq);
    n.shift_next();
    n.shift_next();
    n.compare(0, &seq);
    assert_eq!(&n.m[..10], &[0, 1, 6, 5, 4, 3, 2, 6, 5, 4]);
    assert_eq!(n.trust_end, 1);
    assert_eq!(n.bag_remains, 4);
}

#[test]
fn full_array_carry_matches_the_exe_for_every_shift() {
    let live: Vec<i32> = vec![
        6, 5, 4, 3, 1, 2, 0, 6, 5, 4, 3, 1, 2, 0, 6, 5, 4, 3, 1, 2, 0, 6, 5, 4, 3, 1, 2,
    ];
    let mut n = NextState::new(2);
    n.init(&live);
    assert_eq!(&n.m[..10], &[6, 5, 4, 3, 1, 2, 0, 6, 5, 4]);
    assert_eq!(n.trust_end, 3);
    assert_eq!(n.bag_remains, 6);

    let steps: [(i32, i32, [i32; 10]); 3] = [
        (2, 5, [6, 5, 4, 3, 1, 2, 0, 5, 4, 3]),
        (1, 4, [6, 5, 4, 3, 1, 2, 0, 5, 4, 3]),
        (1, 3, [6, 5, 4, 3, 1, 2, 0, 5, 4, 3]),
    ];
    for (trust, remains, expected) in steps {
        n.shift_next();
        n.compare(0, &live);
        assert_eq!(&n.m[..10], &expected);
        assert_eq!(n.trust_end, trust);
        assert_eq!(n.bag_remains, remains);
    }
    for _ in 4..=6 {
        n.shift_next();
        n.compare(0, &live);
    }
    assert_eq!(n.trust_end, 4);
    assert_eq!(n.bag_remains, 0);
    assert_eq!(
        n.m,
        [
            6, 5, 4, 3, 1, 2, 0, 4, 3, 1, 2, 0, 4, 3, 1, 2, 0, 5, 4, 3, 1, 2, 0, 5, 4, 3, 1,
            2
        ]
    );
}

#[test]
fn per_turn_set_ppt_data_composition_matches_exe_shiftiter_dumps() {
    let seq: Vec<i32> = vec![
        0, 3, 4, 5, 6, 1, 2, 0, 3, 4, 5, 6, 1, 2, 0, 3, 4, 5, 6, 1, 2, 0, 3, 4, 5, 6, 1, 2,
    ];
    let golden: [(usize, [i32; NEXT_SIZE], i32, i32); 2] = [
        (
            1,
            [
                0, 3, 6, 5, 4, 1, 2, 6, 5, 4, 3, 1, 2, 6, 5, 4, 3, 1, 2, 0, 6, 5, 4, 3, 1, 2, 0,
                6,
            ],
            2,
            5,
        ),
        (
            4,
            [
                0, 3, 6, 5, 4, 1, 2, 6, 5, 4, 1, 2, 6, 5, 4, 3, 1, 2, 6, 5, 4, 3, 1, 2, 6, 5, 4,
                3,
            ],
            1,
            2,
        ),
    ];
    for (iterations, expected, trust, remains) in golden {
        let mut n = NextState::new(2);
        n.init(&seq);
        for _ in 0..iterations {
            n.shift_next();
            n.compare(0, &seq);
        }
        assert_eq!(n.m, expected);
        assert_eq!(n.trust_end, trust);
        assert_eq!(n.bag_remains, remains);
    }
}

#[test]
fn bag_cursor_cycles_through_all_seven_positions() {
    let mut n = NextState::new(2);
    n.init(&[0, 1, 2, 3]);
    let mut remains = Vec::new();
    for _ in 0..14 {
        n.shift_next();
        remains.push(n.bag_remains);
    }
    assert_eq!(remains, vec![5, 4, 3, 2, 1, 0, 6, 5, 4, 3, 2, 1, 0, 6]);
}

#[test]
fn next_state_defaults_to_two_preview_entries() {
    let n = NextState::default();
    assert_eq!(n.view_next, 2);
    assert_eq!(n.m.len(), NEXT_SIZE);
    assert_eq!(n.bag_remains, bag_remains_start());
}

fn board_with_bottom_cell(col: usize) -> BoardView {
    let mut grid = [[EMPTY_CELL; COLS]; ROWS];
    grid[ROWS - 1][col] = 1;
    BoardView { grid }
}

#[test]
fn board_to_native_rows_uses_bit_nine_minus_col() {
    let board = board_with_bottom_cell(9);
    let rows = board_to_native_rows(&board);
    assert_eq!(rows.len(), ROWS);
    assert_eq!(rows[0], 1);
    assert_eq!(rows[ROWS - 1], 0);

    let board = board_with_bottom_cell(0);
    let rows = board_to_native_rows(&board);
    assert_eq!(rows[0], 1 << 9);
}

#[test]
fn stack_height_and_popcount_only_span_live_rows() {
    assert_eq!(native_stack_height(&[]), -1);
    assert_eq!(native_stack_height(&[0x3ff]), 0);
    assert_eq!(native_stack_height(&[0x3ff, 0, 0x1]), 2);
    assert_eq!(native_pop_count(&[0x3ff, 0x1], 1), 11);
    assert_eq!(native_pop_count(&[0x3ff, 0x1], -1), 0);
}

#[test]
fn opponent_pc_board_matches_the_ts_derivation() {
    assert!(opponent_is_pc_board(&[]));
    // 0x1ff has nine set bits, so the short-stack parity check rejects it.
    assert!(!opponent_is_pc_board(&[0x1ff]));
    // One full row is only ten bits tall, so the even popcount wins.
    assert!(opponent_is_pc_board(&[0x3ff]));
    let full = |n: usize| vec![0x3ff; n];
    assert!(opponent_is_pc_board(&full(9)));
    assert!(!opponent_is_pc_board(&full(10)));
}

#[test]
fn opponent_powerful_board_matches_the_ts_derivation() {
    assert!(opponent_is_powerful_board(&[], 5, 0));
    assert!(opponent_is_powerful_board(&[], 0, 6));
    assert!(!opponent_is_powerful_board(&[0x1ff], 0, 0));
    // Four full rows are a tall, even stack without four bara rows, so the
    // even-parity branch falls through to `true`.
    assert!(opponent_is_powerful_board(&[0x3ff, 0x3ff, 0x3ff, 0x3ff], 0, 0));
    assert!(opponent_is_powerful_board(&[0x3ff], 4, 0));
}

#[test]
fn frame_step_ms_rounds_the_virtual_frame_clock() {
    assert_eq!(frame_step_ms(20), 333.0);
    assert_eq!(frame_step_ms(1), 17.0);
    assert_eq!(frame_step_ms(0), 0.0);
}

#[test]
fn cosmetic_steps_pick_the_short_rotation_and_signed_moves() {
    assert_eq!(
        cosmetic_steps(0, 3, 1, 5),
        vec![AiStep::RotateCW, AiStep::Right, AiStep::Right]
    );
    assert_eq!(
        cosmetic_steps(0, 3, 3, 1),
        vec![AiStep::RotateCCW, AiStep::Left, AiStep::Left]
    );
    assert_eq!(
        cosmetic_steps(0, 0, 2, 0),
        vec![AiStep::RotateCW, AiStep::RotateCW]
    );
}

fn snapshot_with_opponent() -> GameSnapshot {
    let mut grid = [[EMPTY_CELL; COLS]; ROWS];
    grid[ROWS - 1][0] = 1;
    let mut opponent_grid = [[EMPTY_CELL; COLS]; ROWS];
    opponent_grid[ROWS - 1][9] = 1;
    GameSnapshot {
        board: BoardView { grid },
        active: Some(ActivePieceView {
            kind: PieceKind::T,
            rotation: 0,
            cells: crate::pieces::cells_for(PieceKind::T, 0),
            pos_x: 3,
            pos_y: 0,
        }),
        ghost_y: Some(18),
        hold: Some(PieceKind::I),
        can_hold: false,
        next: vec![PieceKind::O, PieceKind::Z],
        score: 0,
        lines: 0,
        level: 1,
        game_over: false,
        combo: 0,
        b2b: true,
        native_combo: 3,
        native_btb: 2,
        lock_id: 4,
        last_action: LockAction::Tsd,
        last_raw_attack: 4,
        pending_garbage: 2,
        last_attack: 3,
        last_blocked: 1,
        opponent: Some(OpponentView {
            combo: 5,
            btb: 1,
            lock_id: 9,
            board: BoardView { grid: opponent_grid },
            last_clear_lines: Some(2),
            last_native_combo: Some(4),
            last_native_btb: Some(1),
            last_raw_attack: Some(3),
        }),
    }
}

#[test]
fn raw_request_from_snapshot_maps_the_versus_input_contract() {
    let snapshot = snapshot_with_opponent();
    let options = RawRequestOptions {
        versus: true,
        use_s4w: true,
        use_pcstack: false,
        view_next: 2,
        is_even_board: true,
        depth: 14,
        even_mode: EvenMode::Auto,
    };
    let request = raw_request_from_snapshot(&snapshot, &options).expect("request");
    assert_eq!(request.current, PieceKind::T.to_mino());
    assert_eq!(request.hold, PieceKind::I.to_mino());
    assert_eq!(
        &request.next[..2],
        &[PieceKind::O.to_mino(), PieceKind::Z.to_mino()]
    );
    assert_eq!(request.combo, 3);
    assert_eq!(request.btb, 2);
    assert_eq!(request.allow_hold, false);
    assert_eq!(request.depth, 14);
    assert!(request.multi_evaluation);
    assert_eq!(request.opponents_combo, 5);
    assert_eq!(request.view_next, 2);
    assert_eq!(request.board[0], 1 << 9);
    assert!(!request.opponent_is_pc_board);
    assert!(request.opponent_is_powerful_board);
}

#[test]
fn raw_request_requires_an_active_piece_and_maps_the_solo_mode() {
    let mut snapshot = snapshot_with_opponent();
    snapshot.active = None;
    assert!(
        raw_request_from_snapshot(
            &snapshot,
            &RawRequestOptions {
                versus: true,
                use_s4w: false,
                use_pcstack: false,
                view_next: 2,
                is_even_board: false,
                depth: 10,
                even_mode: EvenMode::True,
            }
        )
        .is_none()
    );

    let mut snapshot = snapshot_with_opponent();
    snapshot.hold = None;
    snapshot.opponent = None;
    let request = raw_request_from_snapshot(
        &snapshot,
        &RawRequestOptions {
            versus: false,
            use_s4w: false,
            use_pcstack: true,
            view_next: 5,
            is_even_board: false,
            depth: 7,
            even_mode: EvenMode::Auto,
        },
    )
    .expect("request");
    assert_eq!(request.hold, MINO_NONE);
    assert!(!request.multi_evaluation);
    assert_eq!(request.opponents_combo, 0);
    assert!(!request.opponent_is_pc_board);
    assert!(!request.is_even);
    assert!(request.use_pcstack);
}

#[test]
fn sync_from_snapshot_carries_the_opponent_transition_telemetry() {
    let snapshot = snapshot_with_opponent();
    let sync = sync_from_snapshot(&snapshot);
    assert_eq!(sync.lock_id, 4);
    assert_eq!(sync.last_action, LockAction::Tsd);
    assert_eq!(sync.last_attack, 3);
    assert_eq!(sync.opponent_lock_id, Some(9));
    assert_eq!(sync.opponent_last_clear_lines, Some(2));
    assert_eq!(sync.opponent_last_native_btb, Some(1));
    assert_eq!(sync.opponent_last_native_combo, Some(4));

    let mut bare = snapshot;
    bare.opponent = None;
    let sync = sync_from_snapshot(&bare);
    assert_eq!(sync.opponent_lock_id, None);
    assert_eq!(sync.opponent_last_clear_lines, None);
}

#[test]
fn make_place_at_move_builds_a_source_matched_plan() {
    let snapshot = snapshot_with_opponent();
    let mv = make_place_at_move(&snapshot, 5, 1, 17, 5).expect("move");
    assert!(!mv.use_hold);
    assert_eq!(mv.target_x, 5);
    assert_eq!(mv.target_rotation, 1);
    let execution = mv.execution.expect("execution");
    assert_eq!(execution.expected_board, Vec::<u16>::new());
    assert_eq!(execution.expected_lines_cleared, 0);
    assert_eq!(execution.source_active_kind, PieceKind::T);
    assert_eq!(execution.source_rotation, 0);
    assert_eq!(execution.source_x, 3);
    assert_eq!(execution.source_hold, Some(PieceKind::I));
    assert!(!execution.source_can_hold);
    assert_eq!(
        execution.source_board_fingerprint,
        crate::versus::board_fingerprint(&snapshot)
    );
    assert_eq!(
        execution.steps.last(),
        Some(&AiStep::PlaceAt {
            rotation: 1,
            x: 5,
            top_row: Some(17),
            last_srs: Some(5)
        })
    );

    let no_active = GameSnapshot {
        active: None,
        ..snapshot
    };
    assert!(make_place_at_move(&no_active, 0, 0, 0, 0).is_none());
}

#[test]
fn lock_action_codes_match_the_native_clear_act_enum() {
    assert_eq!(LockAction::None.code(), 0);
    assert_eq!(LockAction::Single.code(), 1);
    assert_eq!(LockAction::Double.code(), 2);
    assert_eq!(LockAction::Triple.code(), 3);
    assert_eq!(LockAction::Quad.code(), 4);
    assert_eq!(LockAction::Tss.code(), 5);
    assert_eq!(LockAction::Tsd.code(), 6);
    assert_eq!(LockAction::Tst.code(), 7);
    assert_eq!(LockAction::Tsm.code(), 8);
    assert_eq!(LockAction::Pc.code(), 9);
}
