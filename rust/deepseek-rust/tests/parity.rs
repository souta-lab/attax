use deepseek_rust::{BestMoveInput, Board, Move, PieceKind, best_move};
use serde_json::Value;

fn parse_kind(s: &str) -> PieceKind {
    PieceKind::from_char(s.chars().next().unwrap_or('?')).expect("piece kind")
}

#[test]
fn parity_with_typescript_fixture() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/deepseek_parity.json"
    );
    let text = std::fs::read_to_string(path).expect("read fixture");
    let json: Value = serde_json::from_str(&text).expect("parse fixture");
    let cases = json["cases"].as_array().expect("cases array");
    assert!(
        cases.len() >= 30,
        "fixture must have at least 30 cases, got {}",
        cases.len()
    );

    let mut matched = 0usize;
    let mut mismatches: Vec<String> = Vec::new();

    for case in cases {
        let name = case["name"].as_str().unwrap_or("?");
        let mut board: Board = [0; 20];
        for (i, v) in case["board"]
            .as_array()
            .expect("board array")
            .iter()
            .enumerate()
        {
            board[i] = v.as_u64().unwrap_or(0) as u16;
        }
        let active = parse_kind(case["active"].as_str().unwrap_or("?"));
        let next: Vec<PieceKind> = case["next"]
            .as_array()
            .expect("next array")
            .iter()
            .map(|v| parse_kind(v.as_str().unwrap_or("?")))
            .collect();
        let hold = case["hold"].as_str().map(parse_kind);
        let can_hold = case["canHold"].as_bool().unwrap_or(false);
        let b2b = case["b2b"].as_bool().unwrap_or(false);
        let combo = case["combo"].as_i64().unwrap_or(0) as i32;
        let pending = case["pendingGarbage"].as_i64().unwrap_or(0) as i32;
        let pieces = case["pieces"].as_u64().unwrap_or(1) as u32;
        let exp = &case["expected"];
        let expected = Move {
            x: exp["targetX"].as_i64().unwrap_or(0) as i32,
            rotation: exp["targetRotation"].as_i64().unwrap_or(0) as i32,
            use_hold: exp["useHold"].as_bool().unwrap_or(false),
        };

        let got = best_move(&BestMoveInput {
            board: &board,
            active,
            next: &next,
            hold,
            can_hold,
            b2b,
            combo,
            pending_garbage: pending,
            pieces,
        });

        match got {
            Some(m) if m == expected => matched += 1,
            other => mismatches.push(format!(
                "{name}: expected {expected:?}, got {other:?}"
            )),
        }
    }

    eprintln!("deepseek parity: {matched}/{}", cases.len());
    assert!(
        mismatches.is_empty(),
        "parity mismatches ({}):\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}
