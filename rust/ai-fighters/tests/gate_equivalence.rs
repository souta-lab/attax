//! Gate equivalence: the committed native headless evidence must match the
//! committed reference gate evidence seed for seed.
//!
//! - native: `evidence/native-app/native-gate32-adapt0.jsonl`
//!   (`hoiko-app --headless --json` at the faithful config, adapt off).
//! - reference: `evidence/hoiko-inputs/audit/gate32-final-adapt0.jsonl`
//!   (`bun scripts/gate-v2.ts` with `HOIKO_ADAPT=0 DSV2_RUST=1`).
//!
//! Orientation differs by design: the gate fights DeepSeek on the left and
//! Hoiko on the right, the native app labels Hoiko left and DeepSeek right.

use serde_json::Value;
use std::path::PathBuf;

fn lines(name: &str) -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    text.lines()
        .map(|line| serde_json::from_str(line).unwrap_or_else(|error| panic!("{name}: {error}")))
        .collect()
}

fn int(value: &Value) -> i64 {
    value
        .as_i64()
        .unwrap_or_else(|| panic!("expected int, got {value}"))
}

fn rows(name: &str, row_type: &str) -> Vec<Value> {
    lines(name)
        .into_iter()
        .filter(|row| row["type"] == row_type)
        .collect()
}

#[test]
fn native_headless_reproduces_the_reference_gate_seed_for_seed() {
    let native = rows(
        "evidence/native-app/native-gate32-adapt0.jsonl",
        "NATIVE-match",
    );
    let gate = rows(
        "evidence/hoiko-inputs/audit/gate32-final-adapt0.jsonl",
        "HOIKO-match",
    );
    assert_eq!(native.len(), 32, "native evidence corpus size");
    assert_eq!(gate.len(), native.len(), "gate evidence corpus size");

    let mut hoiko_wins = 0;
    let mut deepseek_wins = 0;
    for gate_row in &gate {
        let seed = int(&gate_row["seed"]);
        let native_row = native
            .iter()
            .find(|row| int(&row["seed"]) == seed)
            .unwrap_or_else(|| panic!("seed {seed}: missing native row"));
        let gate_who = match gate_row["winner"].as_str().expect("gate winner") {
            "left" => "DEEPSEEK",
            "right" => "HOIKO",
            "draw" => "DRAW",
            "cap" => "CAP",
            other => panic!("seed {seed}: unknown gate winner {other}"),
        };
        let native_who = native_row["winnerName"].as_str().unwrap_or("CAP");
        assert_eq!(native_who, gate_who, "seed {seed}: winner");
        assert_eq!(
            int(&native_row["ticks"]),
            int(&gate_row["ticks"]),
            "seed {seed}: ticks"
        );
        assert_eq!(
            int(&native_row["pieces"]),
            int(&gate_row["pieces"]),
            "seed {seed}: pieces"
        );
        // gate left = DEEPSEEK = native right; gate right = HOIKO = native left.
        for (gate_side, native_side) in [("left", "rightReport"), ("right", "leftReport")] {
            let expected = &gate_row[gate_side];
            let actual = &native_row[native_side];
            for field in ["lines", "sent", "locks"] {
                assert_eq!(
                    int(&actual[field]),
                    int(&expected[field]),
                    "seed {seed}: {gate_side} {field}"
                );
            }
            assert_eq!(
                int(&actual["executionSourceMismatches"]),
                int(&expected["executionSourceMismatches"]),
                "seed {seed}: {gate_side} execution mismatches"
            );
            assert_eq!(
                int(&actual["executionExpectedBoardFailures"]),
                int(&expected["executionExpectedBoardFailures"]),
                "seed {seed}: {gate_side} board failures"
            );
        }
        match gate_who {
            "HOIKO" => hoiko_wins += 1,
            "DEEPSEEK" => deepseek_wins += 1,
            _ => {}
        }
    }
    assert_eq!(
        (hoiko_wins, deepseek_wins),
        (9, 23),
        "documented honest gate is HOIKO 9 - DEEPSEEK 23"
    );
    assert!(
        native.iter().all(
            |row| int(&row["leftReport"]["executionSourceMismatches"]) == 0
                && int(&row["rightReport"]["executionSourceMismatches"]) == 0
        ),
        "every native match must be execution-mismatch free"
    );
}

#[test]
fn native_summary_matches_the_gate_aggregate() {
    let summary = lines("evidence/native-app/native-gate32-adapt0.jsonl")
        .into_iter()
        .find(|row| row["type"] == "NATIVE-summary")
        .expect("native summary row");
    let gate = lines("evidence/hoiko-inputs/audit/gate32-final-adapt0.jsonl")
        .into_iter()
        .find(|row| row["type"] == "HOIKO-summary")
        .expect("gate summary row");
    assert_eq!(int(&summary["matches"]), 32);
    assert_eq!(
        int(&summary["hoikoWins"]),
        int(&gate["aggregate"]["rightWins"])
    );
    assert_eq!(
        int(&summary["deepseekWins"]),
        int(&gate["aggregate"]["leftWins"])
    );
    assert_eq!(int(&summary["executionSourceMismatches"]), 0);
    assert_eq!(int(&summary["executionExpectedBoardFailures"]), 0);
}
