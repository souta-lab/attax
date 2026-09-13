//! Versus controller differential: replays the TS-recorded AI decisions from
//! `evidence/native-app/versus.json` and asserts identical lock events, garbage
//! exchange, execution counters and match results.
//!
//! Every decision is replayed by call index (no decision logic to mirror); a
//! diverging board surfaces as a snapshot/event mismatch.

mod common;

use game::{
    board_fingerprint, AiExecutionPlan, AiFighter, AiMove, AiStep, GameSnapshot, VersusConfig,
    VersusController, VERSUS_DEFAULTS,
};
use serde_json::Value;
use std::cell::Cell;
use std::rc::Rc;

struct Decision {
    use_hold: bool,
    fallback: bool,
    x: i32,
    rotation: i32,
    top_row: i32,
    last_srs: i32,
    garbage_wait: bool,
}

struct RecordedFighter {
    side: &'static str,
    decisions: Rc<Vec<Decision>>,
    cursor: Rc<Cell<usize>>,
}

impl RecordedFighter {
    fn new(side: &'static str, value: &Value) -> (RecordedFighter, Rc<Cell<usize>>) {
        let decisions: Vec<Decision> = value
            .as_array()
            .unwrap()
            .iter()
            .map(|d| Decision {
                use_hold: common::flag(&d["useHold"]),
                fallback: common::flag(&d["fallback"]),
                x: common::int(&d["x"]),
                rotation: common::int(&d["rotation"]),
                top_row: common::int(&d["topRow"]),
                last_srs: common::int(&d["lastSrs"]),
                garbage_wait: common::flag(&d["garbageWait"]),
            })
            .collect();
        let cursor = Rc::new(Cell::new(0));
        (
            RecordedFighter {
                side,
                decisions: Rc::new(decisions),
                cursor: Rc::clone(&cursor),
            },
            cursor,
        )
    }
}

impl AiFighter for RecordedFighter {
    fn find_best_move(&mut self, snapshot: &GameSnapshot) -> Option<AiMove> {
        let index = self.cursor.get();
        let Some(decision) = self.decisions.get(index) else {
            return None;
        };
        self.cursor.set(index + 1);
        assert!(
            snapshot.active.is_some(),
            "{} decision {index} replays with no active piece",
            self.side
        );
        assert!(
            !snapshot.game_over,
            "{} decision {index} replays after game over",
            self.side
        );
        let active = snapshot.active.unwrap();
        let base = AiMove {
            target_x: decision.x,
            target_rotation: decision.rotation,
            use_hold: decision.use_hold,
            garbage_wait: Some(decision.garbage_wait),
            execution: None,
        };
        if decision.use_hold || decision.fallback {
            return Some(base);
        }
        Some(AiMove {
            execution: Some(AiExecutionPlan {
                target_x: decision.x,
                target_rotation: decision.rotation,
                steps: vec![AiStep::PlaceAt {
                    rotation: decision.rotation,
                    x: decision.x,
                    top_row: Some(decision.top_row),
                    last_srs: Some(decision.last_srs),
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
            ..base
        })
    }
}

struct SideRecord {
    lock: i32,
    over: bool,
    lines: i32,
    pending: i32,
    sent: i32,
    blocked: i32,
    board: String,
    act: String,
}

fn side_record(controller: &VersusController, side: game::Side) -> SideRecord {
    let state = match side {
        game::Side::Left => &controller.left,
        game::Side::Right => &controller.right,
    };
    let snapshot = state.core.snapshot();
    SideRecord {
        lock: snapshot.lock_id,
        over: snapshot.game_over,
        lines: snapshot.lines,
        pending: snapshot.pending_garbage,
        sent: state.sent_total,
        blocked: state.blocked_total,
        board: board_fingerprint(&snapshot),
        act: snapshot.last_action.as_str().to_string(),
    }
}

fn assert_side(record: &SideRecord, expect: &Value, ctx: &str) {
    assert_eq!(record.lock, common::int(&expect["lock"]), "{ctx} lock");
    assert_eq!(record.over, common::flag(&expect["over"]), "{ctx} over");
    assert_eq!(record.lines, common::int(&expect["lines"]), "{ctx} lines");
    assert_eq!(record.pending, common::int(&expect["pending"]), "{ctx} pending");
    assert_eq!(record.sent, common::int(&expect["sent"]), "{ctx} sent");
    assert_eq!(record.blocked, common::int(&expect["blocked"]), "{ctx} blocked");
    assert_eq!(record.board, expect["board"].as_str().unwrap(), "{ctx} board");
    assert_eq!(record.act, expect["act"].as_str().unwrap(), "{ctx} action");
}

#[test]
fn versus_differential_replays_recorded_decisions() {
    let fixture = common::fixture("versus.json");
    assert!(
        !fixture["scenarios"].as_array().unwrap().is_empty(),
        "fixture has no scenarios"
    );
    let mut total_decisions = 0;
    let mut total_sent = 0;
    for scenario in fixture["scenarios"].as_array().unwrap() {
        let seed = common::int(&scenario["seed"]);
        let max_ticks = scenario["maxTicks"].as_i64().unwrap();
        let (left, left_cursor) = RecordedFighter::new("left", &scenario["leftDecisions"]);
        let (right, right_cursor) = RecordedFighter::new("right", &scenario["rightDecisions"]);
        let left_total = left.decisions.len();
        let right_total = right.decisions.len();
        let mut controller =
            VersusController::new(Box::new(left), Box::new(right), seed, VersusConfig::default());

        let mut ticks: i64 = 0;
        let mut last_pieces = 0;
        let mut event_index = 0usize;
        let expected_events = scenario["events"].as_array().unwrap();
        while controller.result.is_none() && ticks < max_ticks {
            controller.tick(16.0, &VERSUS_DEFAULTS);
            ticks += 1;
            if controller.pieces != last_pieces {
                last_pieces = controller.pieces;
                let expect = expected_events
                    .get(event_index)
                    .unwrap_or_else(|| panic!("seed {seed}: extra lock event at tick {ticks}"));
                let ctx = format!("seed {seed} event {event_index} tick {ticks}");
                assert_eq!(ticks as i32, common::int(&expect["tick"]), "{ctx} tick");
                assert_eq!(
                    controller.pieces,
                    common::int(&expect["pieces"]),
                    "{ctx} pieces"
                );
                assert_side(
                    &side_record(&controller, game::Side::Left),
                    &expect["left"],
                    &format!("{ctx} left"),
                );
                assert_side(
                    &side_record(&controller, game::Side::Right),
                    &expect["right"],
                    &format!("{ctx} right"),
                );
                event_index += 1;
            }
        }
        assert_eq!(event_index, expected_events.len(), "seed {seed}: missing lock events");
        assert_eq!(ticks as i32, common::int(&scenario["ticks"]), "seed {seed}: tick count");

        let expected_result = &scenario["result"];
        if expected_result.is_null() {
            assert!(controller.result.is_none(), "seed {seed}: unexpected result");
        } else {
            let result = controller
                .result
                .as_ref()
                .unwrap_or_else(|| panic!("seed {seed}: missing result"));
            let winner = match result.winner {
                game::Winner::Left => "left",
                game::Winner::Right => "right",
                game::Winner::Draw => "draw",
            };
            assert_eq!(winner, expected_result["winner"].as_str().unwrap(), "seed {seed} winner");
            assert_eq!(result.reason, expected_result["reason"].as_str().unwrap());
            assert_eq!(result.pieces, common::int(&expected_result["pieces"]));
            assert_eq!(result.lines_left, common::int(&expected_result["linesLeft"]));
            assert_eq!(result.lines_right, common::int(&expected_result["linesRight"]));
            assert_eq!(result.sent_left, common::int(&expected_result["sentLeft"]));
            assert_eq!(result.sent_right, common::int(&expected_result["sentRight"]));
        }

        let final_expect = &scenario["final"];
        assert_eq!(
            controller.pieces,
            common::int(&final_expect["pieces"]),
            "seed {seed}: final pieces"
        );
        assert_side(
            &side_record(&controller, game::Side::Left),
            &final_expect["left"],
            &format!("seed {seed} final left"),
        );
        assert_side(
            &side_record(&controller, game::Side::Right),
            &final_expect["right"],
            &format!("seed {seed} final right"),
        );
        assert_eq!(
            controller.left.execution_source_mismatches,
            common::int(&final_expect["left"]["mismatches"]),
            "seed {seed}: left mismatches"
        );
        assert_eq!(
            controller.right.execution_source_mismatches,
            common::int(&final_expect["right"]["mismatches"]),
            "seed {seed}: right mismatches"
        );
        assert_eq!(
            controller.left.execution_expected_board_failures,
            common::int(&final_expect["left"]["boardFailures"]),
            "seed {seed}: left board failures"
        );
        assert_eq!(
            controller.right.execution_expected_board_failures,
            common::int(&final_expect["right"]["boardFailures"]),
            "seed {seed}: right board failures"
        );
        assert_eq!(
            left_cursor.get(),
            left_total,
            "seed {seed}: left AI calls != recorded decisions (unreplayed decisions exist)"
        );
        assert_eq!(
            right_cursor.get(),
            right_total,
            "seed {seed}: right AI calls != recorded decisions"
        );
        total_decisions += left_total + right_total;
        total_sent += controller.left.sent_total + controller.right.sent_total;
    }
    assert!(total_decisions > 100, "fixture is too small to be meaningful");
    assert!(total_sent > 0, "fixture never exercises garbage exchange");
}
