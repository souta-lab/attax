//! Fighter differential: replays the TS-recorded (wasm-backed) fighter
//! decisions from `evidence/native-app/fighter-differential.json` with the
//! native fighters and asserts every decision (hold / placeAt / garbageWait)
//! and the final side state match.
//!
//! The recording config is reduced (beam 12 / depth 6, DeepSeek depth 3) so the
//! test stays fast in debug; the adapter carry path is config-independent.

use ai_fighters::{DeepSeekFighter, DeepSeekFighterOptions, HoikoFighter, HoikoFighterOptions};
use game::{
    AiFighter, AiMove, AiStep, GameSnapshot, SideState, VERSUS_DEFAULTS, VersusConfig,
    VersusController,
};
use serde_json::Value;
use std::cell::Cell;
use std::path::PathBuf;
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

impl Decision {
    fn from_json(value: &Value) -> Decision {
        let flag = |key: &str| value[key].as_bool().unwrap_or_else(|| panic!("{key} bool"));
        let int = |key: &str| value[key].as_i64().unwrap_or_else(|| panic!("{key} int")) as i32;
        Decision {
            use_hold: flag("useHold"),
            fallback: flag("fallback"),
            x: int("x"),
            rotation: int("rotation"),
            top_row: int("topRow"),
            last_srs: int("lastSrs"),
            garbage_wait: flag("garbageWait"),
        }
    }
}

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("evidence")
        .join("native-app")
        .join("fighter-differential.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

fn place_at(mv: &AiMove) -> Option<(i32, i32)> {
    mv.execution.as_ref().and_then(|execution| {
        execution.steps.iter().find_map(|step| match step {
            AiStep::PlaceAt {
                top_row, last_srs, ..
            } => Some((top_row.unwrap_or(0), last_srs.unwrap_or(0))),
            _ => None,
        })
    })
}

fn assert_decision(expected: &Decision, actual: Option<&AiMove>, ctx: &str) {
    let Some(mv) = actual else {
        assert!(
            expected.fallback,
            "{ctx}: native returned no move, TS had one"
        );
        return;
    };
    assert!(
        !expected.fallback,
        "{ctx}: TS fell back, native returned a move"
    );
    assert_eq!(mv.use_hold, expected.use_hold, "{ctx}: useHold");
    assert_eq!(mv.target_x, expected.x, "{ctx}: x");
    assert_eq!(mv.target_rotation, expected.rotation, "{ctx}: rotation");
    assert_eq!(
        mv.garbage_wait.unwrap_or(false),
        expected.garbage_wait,
        "{ctx}: garbageWait"
    );
    if expected.use_hold {
        return;
    }
    let (top_row, last_srs) =
        place_at(mv).unwrap_or_else(|| panic!("{ctx}: native move has no placeAt step"));
    assert_eq!(top_row, expected.top_row, "{ctx}: topRow");
    assert_eq!(last_srs, expected.last_srs, "{ctx}: lastSrs");
}

struct RecordedFighter<F: AiFighter> {
    inner: F,
    side: &'static str,
    decisions: Rc<Vec<Decision>>,
    cursor: Rc<Cell<usize>>,
}

impl<F: AiFighter> RecordedFighter<F> {
    fn new(side: &'static str, inner: F, value: &Value) -> (RecordedFighter<F>, Rc<Cell<usize>>) {
        let decisions: Vec<Decision> = value
            .as_array()
            .unwrap_or_else(|| panic!("{side} decisions"))
            .iter()
            .map(Decision::from_json)
            .collect();
        let cursor = Rc::new(Cell::new(0));
        (
            RecordedFighter {
                inner,
                side,
                decisions: Rc::new(decisions),
                cursor: Rc::clone(&cursor),
            },
            cursor,
        )
    }
}

impl<F: AiFighter> AiFighter for RecordedFighter<F> {
    fn find_best_move(&mut self, snapshot: &GameSnapshot) -> Option<AiMove> {
        let index = self.cursor.get();
        let expected = self.decisions.get(index).unwrap_or_else(|| {
            panic!(
                "{}: native produced a decision the TS recording does not have (index {index})",
                self.side
            )
        });
        self.cursor.set(index + 1);
        let actual = self.inner.find_best_move(snapshot);
        assert_decision(
            expected,
            actual.as_ref(),
            &format!("{} decision {index}", self.side),
        );
        actual
    }
}

#[derive(Debug, PartialEq, Eq)]
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

fn side_record(state: &SideState) -> SideRecord {
    let snapshot = state.core.snapshot();
    SideRecord {
        lock: snapshot.lock_id,
        over: snapshot.game_over,
        lines: snapshot.lines,
        pending: snapshot.pending_garbage,
        sent: state.sent_total,
        blocked: state.blocked_total,
        board: game::board_fingerprint(&snapshot),
        act: snapshot.last_action.as_str().to_string(),
    }
}

fn int(value: &Value) -> i32 {
    value
        .as_i64()
        .unwrap_or_else(|| panic!("expected int, got {value}")) as i32
}

fn flag(value: &Value) -> bool {
    value
        .as_bool()
        .unwrap_or_else(|| panic!("expected bool, got {value}"))
}

fn hoiko_options(config: &Value) -> HoikoFighterOptions {
    HoikoFighterOptions {
        beam_size_limit: int(&config["beamSizeLimit"]),
        depth_limit: int(&config["depthLimit"]),
        adapt: flag(&config["adapt"]),
        offset: flag(&config["offset"]),
        frames_per_think: int(&config["framesPerThink"]),
        ..HoikoFighterOptions::default()
    }
}

fn deepseek_options(config: &Value) -> DeepSeekFighterOptions {
    DeepSeekFighterOptions {
        depth: int(&config["depth"]) as usize,
        width: int(&config["width"]) as usize,
        top_k: int(&config["topK"]) as usize,
        use_kicks: flag(&config["useKicks"]),
        use_opponent: flag(&config["useOpponent"]),
        use_garbage_defense: flag(&config["useGarbageDefense"]),
        use_downstack: flag(&config["useDownstack"]),
    }
}

#[test]
fn native_fighters_replay_the_ts_decisions_exactly() {
    let fixture = fixture();
    let scenarios = fixture["scenarios"].as_array().expect("scenarios");
    assert!(
        scenarios.len() >= 2,
        "fixture is too small to be meaningful"
    );
    let mut total_decisions = 0;
    for scenario in scenarios {
        let seed = int(&scenario["seed"]);
        let max_ticks = scenario["maxTicks"].as_u64().expect("maxTicks");
        let tick_ms = scenario["tickMs"].as_f64().expect("tickMs");
        let hoiko = HoikoFighter::with_clock(hoiko_options(&scenario["hoiko"]), Box::new(|| 0.0));
        let deepseek = DeepSeekFighter::new(deepseek_options(&scenario["deepseek"]));
        let (left, left_cursor) = RecordedFighter::new("hoiko", hoiko, &scenario["leftDecisions"]);
        let (right, right_cursor) =
            RecordedFighter::new("deepseek", deepseek, &scenario["rightDecisions"]);
        let left_total = left.decisions.len();
        let right_total = right.decisions.len();
        let mut controller = VersusController::new(
            Box::new(left),
            Box::new(right),
            seed,
            VersusConfig::default(),
        );

        let mut ticks: u64 = 0;
        while controller.result.is_none() && ticks < max_ticks {
            controller.tick(tick_ms, &VERSUS_DEFAULTS);
            ticks += 1;
        }

        assert_eq!(
            ticks,
            scenario["ticks"].as_u64().expect("ticks"),
            "seed {seed}: tick count"
        );
        assert_eq!(
            left_cursor.get(),
            left_total,
            "seed {seed}: hoiko decisions not all consumed"
        );
        assert_eq!(
            right_cursor.get(),
            right_total,
            "seed {seed}: deepseek decisions not all consumed"
        );

        let expected_result = &scenario["result"];
        if expected_result.is_null() {
            assert!(
                controller.result.is_none(),
                "seed {seed}: unexpected result"
            );
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
            assert_eq!(winner, expected_result["winner"].as_str().unwrap());
            assert_eq!(result.reason, expected_result["reason"].as_str().unwrap());
            assert_eq!(result.pieces, int(&expected_result["pieces"]));
            assert_eq!(result.lines_left, int(&expected_result["linesLeft"]));
            assert_eq!(result.lines_right, int(&expected_result["linesRight"]));
            assert_eq!(result.sent_left, int(&expected_result["sentLeft"]));
            assert_eq!(result.sent_right, int(&expected_result["sentRight"]));
        }

        let expected_final = &scenario["final"];
        assert_eq!(
            controller.pieces,
            int(&expected_final["pieces"]),
            "seed {seed}: final pieces"
        );
        assert_eq!(
            side_record(&controller.left),
            side_record_from_json(&expected_final["left"]),
            "seed {seed}: final left"
        );
        assert_eq!(
            side_record(&controller.right),
            side_record_from_json(&expected_final["right"]),
            "seed {seed}: final right"
        );
        assert_eq!(
            controller.left.execution_source_mismatches,
            int(&expected_final["leftMismatches"]),
            "seed {seed}: left mismatches"
        );
        assert_eq!(
            controller.right.execution_source_mismatches,
            int(&expected_final["rightMismatches"]),
            "seed {seed}: right mismatches"
        );
        assert_eq!(
            controller.left.execution_expected_board_failures,
            int(&expected_final["leftBoardFailures"]),
            "seed {seed}: left board failures"
        );
        assert_eq!(
            controller.right.execution_expected_board_failures,
            int(&expected_final["rightBoardFailures"]),
            "seed {seed}: right board failures"
        );
        total_decisions += left_total + right_total;
    }
    assert!(
        total_decisions > 100,
        "fixture is too small to be meaningful"
    );
}

fn side_record_from_json(value: &Value) -> SideRecord {
    SideRecord {
        lock: int(&value["lock"]),
        over: flag(&value["over"]),
        lines: int(&value["lines"]),
        pending: int(&value["pending"]),
        sent: int(&value["sent"]),
        blocked: int(&value["blocked"]),
        board: value["board"].as_str().unwrap().to_string(),
        act: value["act"].as_str().unwrap().to_string(),
    }
}
