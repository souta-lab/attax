//! Fixed-position DeepSeek benchmark: reports ms/move.
//!
//! Run: cargo run --release --example bench_deepseek --manifest-path rust/Cargo.toml

use std::time::Instant;

use deepseek_rust::{BestMoveInput, Board, PieceKind, best_move};
use serde_json::Value;

fn parse_kind(s: &str) -> PieceKind {
    PieceKind::from_char(s.chars().next().unwrap_or('?')).expect("piece kind")
}

struct Position {
    board: Board,
    active: PieceKind,
    next: Vec<PieceKind>,
    hold: Option<PieceKind>,
    can_hold: bool,
    b2b: bool,
    combo: i32,
    pending: i32,
    pieces: u32,
}

fn load_positions() -> Vec<Position> {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/deepseek_parity.json"
    );
    let text = std::fs::read_to_string(path).expect("read fixture");
    let json: Value = serde_json::from_str(&text).expect("parse fixture");
    json["cases"]
        .as_array()
        .expect("cases")
        .iter()
        .map(|case| {
            let mut board: Board = [0; 20];
            for (i, v) in case["board"].as_array().expect("board").iter().enumerate() {
                board[i] = v.as_u64().unwrap_or(0) as u16;
            }
            Position {
                board,
                active: parse_kind(case["active"].as_str().unwrap_or("?")),
                next: case["next"]
                    .as_array()
                    .expect("next")
                    .iter()
                    .map(|v| parse_kind(v.as_str().unwrap_or("?")))
                    .collect(),
                hold: case["hold"].as_str().map(parse_kind),
                can_hold: case["canHold"].as_bool().unwrap_or(false),
                b2b: case["b2b"].as_bool().unwrap_or(false),
                combo: case["combo"].as_i64().unwrap_or(0) as i32,
                pending: case["pendingGarbage"].as_i64().unwrap_or(0) as i32,
                pieces: case["pieces"].as_u64().unwrap_or(1) as u32,
            }
        })
        .collect()
}

fn run(position: &Position) -> Option<deepseek_rust::Move> {
    best_move(&BestMoveInput {
        board: &position.board,
        active: position.active,
        next: &position.next,
        hold: position.hold,
        can_hold: position.can_hold,
        b2b: position.b2b,
        combo: position.combo,
        pending_garbage: position.pending,
        pieces: position.pieces,
    })
}

fn main() {
    let positions = load_positions();
    let warmup = 2usize;
    let iterations = 5usize;

    for _ in 0..warmup {
        for position in &positions {
            let _ = run(position);
        }
    }

    let mut total = std::time::Duration::ZERO;
    let mut solved = 0usize;
    for _ in 0..iterations {
        for position in &positions {
            let start = Instant::now();
            let move_ = run(position);
            total += start.elapsed();
            if move_.is_some() {
                solved += 1;
            }
        }
    }

    let moves = (positions.len() * iterations) as f64;
    let ms_total = total.as_secs_f64() * 1000.0;
    println!(
        "deepseek bench: {} positions x {} iterations = {} moves",
        positions.len(),
        iterations,
        positions.len() * iterations
    );
    println!("solved: {solved}");
    println!("total: {ms_total:.2} ms");
    println!("ms/move: {:.4}", ms_total / moves);
}
