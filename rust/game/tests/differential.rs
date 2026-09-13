//! Single-board engine differential: replays the TS-recorded op scripts from
//! `evidence/native-app/engine-{aligned,per-row}.json` and asserts identical
//! snapshots, lock transitions and garbage behavior.
//!
//! Run the TS reference generator first: `bun tools/game-diff/reference.ts`.

mod common;

use game::engine::EngineConfig;
use game::{board_fingerprint, Game, GameSnapshot, SeededRng};
use serde_json::Value;

fn engine_config(trace: &Value) -> EngineConfig {
    EngineConfig {
        garbage_delay: common::int(&trace["garbageDelay"]),
        garbage_aligned: common::flag(&trace["garbageAligned"]),
    }
}

fn next_string(snapshot: &GameSnapshot) -> String {
    snapshot
        .next
        .iter()
        .take(5)
        .map(|kind| kind.as_char().to_string())
        .collect::<Vec<String>>()
        .join(",")
}

fn transition_board(transition: &game::LockTransition) -> String {
    transition
        .board_after_lock_clear
        .iter()
        .map(u16::to_string)
        .collect::<Vec<String>>()
        .join(",")
}

fn assert_snapshot(snapshot: &GameSnapshot, expect: &Value, ctx: &str) {
    assert_eq!(snapshot.game_over, common::flag(&expect["over"]), "{ctx} over");
    assert_eq!(snapshot.lock_id, common::int(&expect["lock"]), "{ctx} lock");
    assert_eq!(
        snapshot.active.map(|a| a.kind.as_char().to_string()),
        common::opt_str(&expect["kind"]),
        "{ctx} kind"
    );
    assert_eq!(
        snapshot.active.map(|a| a.rotation).unwrap_or(0),
        common::int(&expect["rot"]),
        "{ctx} rot"
    );
    assert_eq!(
        snapshot.active.map(|a| a.pos_x).unwrap_or(0),
        common::int(&expect["x"]),
        "{ctx} x"
    );
    assert_eq!(
        snapshot.active.map(|a| a.pos_y).unwrap_or(0),
        common::int(&expect["y"]),
        "{ctx} y"
    );
    if expect["ghost"].is_null() {
        assert_eq!(snapshot.ghost_y, None, "{ctx} ghost");
    } else {
        assert_eq!(
            snapshot.ghost_y,
            Some(common::int(&expect["ghost"])),
            "{ctx} ghost"
        );
    }
    assert_eq!(
        snapshot.hold.map(|k| k.as_char().to_string()),
        common::opt_str(&expect["hold"]),
        "{ctx} hold"
    );
    assert_eq!(snapshot.can_hold, common::flag(&expect["canHold"]), "{ctx} canHold");
    assert_eq!(
        snapshot.pending_garbage,
        common::int(&expect["pending"]),
        "{ctx} pending"
    );
    assert_eq!(snapshot.lines, common::int(&expect["lines"]), "{ctx} lines");
    assert_eq!(snapshot.combo, common::int(&expect["combo"]), "{ctx} combo");
    assert_eq!(
        snapshot.native_combo,
        common::int(&expect["nCombo"]),
        "{ctx} nativeCombo"
    );
    assert_eq!(
        snapshot.native_btb,
        common::int(&expect["nBtb"]),
        "{ctx} nativeBtb"
    );
    assert_eq!(snapshot.b2b, common::flag(&expect["b2b"]), "{ctx} b2b");
    assert_eq!(snapshot.score, common::int(&expect["score"]), "{ctx} score");
    assert_eq!(
        snapshot.last_action.as_str(),
        expect["act"].as_str().unwrap(),
        "{ctx} action"
    );
    assert_eq!(
        snapshot.last_raw_attack,
        common::int(&expect["raw"]),
        "{ctx} raw attack"
    );
    assert_eq!(
        snapshot.last_blocked,
        common::int(&expect["blocked"]),
        "{ctx} blocked"
    );
    assert_eq!(
        snapshot.last_attack,
        common::int(&expect["attack"]),
        "{ctx} attack"
    );
    assert_eq!(
        board_fingerprint(snapshot),
        expect["board"].as_str().unwrap(),
        "{ctx} board"
    );
    assert_eq!(next_string(snapshot), expect["next"].as_str().unwrap(), "{ctx} next");
}

fn assert_transition(game: &Game, expect: &Value, ctx: &str) {
    let transition = game
        .last_lock_transition()
        .unwrap_or_else(|| panic!("{ctx}: missing lock transition"));
    assert_eq!(
        transition_board(transition),
        expect["board"].as_str().unwrap(),
        "{ctx} transition board"
    );
    assert_eq!(
        transition.lines_cleared,
        common::int(&expect["lines"]),
        "{ctx} transition lines"
    );
    assert_eq!(
        transition.garbage_rows_applied,
        common::int(&expect["garbage"]),
        "{ctx} transition garbage"
    );
    assert_eq!(
        transition.action.as_str(),
        expect["act"].as_str().unwrap(),
        "{ctx} transition action"
    );
    assert_eq!(
        transition.native_combo,
        common::int(&expect["nCombo"]),
        "{ctx} transition nativeCombo"
    );
    assert_eq!(
        transition.native_btb,
        common::int(&expect["nBtb"]),
        "{ctx} transition nativeBtb"
    );
    assert_eq!(
        transition.raw_attack,
        common::int(&expect["raw"]),
        "{ctx} transition rawAttack"
    );
    assert_eq!(
        transition.sent_attack,
        common::int(&expect["sent"]),
        "{ctx} transition sentAttack"
    );
    assert_eq!(
        transition.lock_id,
        common::int(&expect["lock"]),
        "{ctx} transition lockId"
    );
}

fn replay_file(name: &str) {
    let fixture = common::fixture(name);
    for trace in fixture["traces"].as_array().unwrap() {
        let seed = common::int(&trace["seed"]);
        let chaos = common::flag(&trace["chaos"]);
        let mut game = Game::with_config(
            Box::new(SeededRng::new(seed)),
            engine_config(trace),
        );
        let label = format!(
            "{name} seed {seed}{}",
            if chaos { " (chaos)" } else { "" }
        );
        for (index, op) in trace["ops"].as_array().unwrap().iter().enumerate() {
            let ctx = format!("{label} op {index}");
            match op["op"].as_str().unwrap() {
                "moveLeft" => game.move_left(),
                "moveRight" => game.move_right(),
                "rotateCW" => game.rotate_cw(),
                "rotateCCW" => game.rotate_ccw(),
                "softDrop" => game.soft_drop(),
                "hardDrop" => game.hard_drop(),
                "gravityTick" => {
                    game.gravity_tick();
                }
                "hold" => game.hold(),
                "receiveGarbage" => game.receive_garbage(common::int(&op["rows"])),
                "setGarbageWait" => game.set_garbage_wait(common::flag(&op["wait"])),
                "placeMinoAt" => {
                    game.place_mino_at(
                        common::int(&op["rotation"]),
                        common::int(&op["x"]),
                        common::int(&op["topRow"]),
                        common::int(&op["lastSrs"]),
                    );
                }
                "hardDropAt" => {
                    game.hard_drop_at(common::int(&op["rotation"]), common::int(&op["x"]));
                }
                "drainOutbox" => {
                    let drained = game.drain_outbox();
                    assert_eq!(
                        drained,
                        common::int(&op["drained"]),
                        "{ctx} drained outbox"
                    );
                }
                other => panic!("{ctx}: unknown op {other}"),
            }
            assert_snapshot(&game.snapshot(), &op["expect"], &ctx);
            if !op["transition"].is_null() {
                assert_transition(&game, &op["transition"], &ctx);
            }
        }
    }
}

#[test]
fn engine_differential_aligned() {
    replay_file("engine-aligned.json");
}

#[test]
fn engine_differential_per_row() {
    replay_file("engine-per-row.json");
}
