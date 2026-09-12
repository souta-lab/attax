use deepseek_rust::{
    Board, PieceKind, V2Input, V2Move, V2OpponentTelemetry, V2Options, find_best_move_v2,
};
use serde_json::Value;

fn parse_kind(s: &str) -> PieceKind {
    PieceKind::from_char(s.chars().next().unwrap_or('?')).expect("piece kind")
}

fn opt_i64(v: &Value) -> Option<i64> {
    v.as_i64()
}

fn parse_opponent(case: &Value) -> V2OpponentTelemetry {
    let Some(opp) = case.get("opponent") else {
        return V2OpponentTelemetry::default();
    };
    V2OpponentTelemetry {
        lock_id: opt_i64(&opp["lockId"]),
        last_clear_lines: opt_i64(&opp["lastClearLines"]),
        last_native_combo: opt_i64(&opp["lastNativeCombo"]),
        last_native_btb: opt_i64(&opp["lastNativeBtb"]),
        last_raw_attack: opt_i64(&opp["lastRawAttack"]),
        combo: opt_i64(&opp["combo"]),
        btb: opt_i64(&opp["btb"]),
    }
}

fn parse_options(case: &Value) -> V2Options {
    let mut options = V2Options::default();
    let Some(opts) = case.get("options") else {
        return options;
    };
    if let Some(v) = opts.get("depth").and_then(Value::as_u64) {
        options.depth = v as usize;
    }
    if let Some(v) = opts.get("width").and_then(Value::as_u64) {
        options.width = v as usize;
    }
    if let Some(v) = opts.get("topK").and_then(Value::as_u64) {
        options.top_k = v as usize;
    }
    if let Some(v) = opts.get("useKicks").and_then(Value::as_bool) {
        options.use_kicks = v;
    }
    if let Some(v) = opts.get("useOpponent").and_then(Value::as_bool) {
        options.use_opponent = v;
    }
    if let Some(v) = opts.get("useGarbageDefense").and_then(Value::as_bool) {
        options.use_garbage_defense = v;
    }
    if let Some(v) = opts.get("useDownstack").and_then(Value::as_bool) {
        options.use_downstack = v;
    }
    options
}

#[test]
fn v2_parity_with_typescript_fixture() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/deepseek_v2_parity.json"
    );
    let text = std::fs::read_to_string(path).expect("read fixture");
    let json: Value = serde_json::from_str(&text).expect("parse fixture");
    let cases = json["cases"].as_array().expect("cases array");
    assert!(
        cases.len() >= 60,
        "fixture must have at least 60 cases, got {}",
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
        let expected = V2Move {
            x: exp["targetX"].as_i64().unwrap_or(0) as i32,
            rotation: exp["targetRotation"].as_i64().unwrap_or(0) as i32,
            use_hold: exp["useHold"].as_bool().unwrap_or(false),
        };

        let got = find_best_move_v2(&V2Input {
            board: &board,
            active,
            next: &next,
            hold,
            can_hold,
            b2b,
            combo,
            pending_garbage: pending,
            pieces,
            opponent: parse_opponent(case),
            options: parse_options(case),
        });

        match got {
            Some(m) if m == expected => matched += 1,
            other => mismatches.push(format!("{name}: expected {expected:?}, got {other:?}")),
        }
    }

    eprintln!("deepseek v2 parity: {matched}/{}", cases.len());
    assert!(
        mismatches.is_empty(),
        "v2 parity mismatches ({}):\n{}",
        mismatches.len(),
        mismatches.join("\n")
    );
}
