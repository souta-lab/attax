//! attax-agree — run the Rust search on JSONL cases dumped by
//! `tools/search-port/dump-cases.ts` and compare with the TS result recorded in each case.
//!
//! Usage: attax-agree CASES.jsonl [--repeat N] [--show K] [--out RESULTS.jsonl]
//!
//! Each case: {"id", "input": SearchInput (TS shape), "options": {width, diverse, exposure,
//! guideline}, "weights": TS Weights object, "expect": TS SearchResult subset | null, "tsMs"}.
//! Reports decision agreement (best placement + hold), full agreement (value bits, nodes,
//! depth, whole planned line, every candidate) and per-case timing vs the TS time.

use std::io::{BufRead, BufReader, Write};
use std::time::Instant;

use attax_search::features::FEATURE_NAMES;
use attax_search::search::{SearchInput, SearchOptions, SearchResult, Searcher, Step};
use attax_search::weights::{CLEAR_NAMES, Weights};
use attax_search::{Board, Kind, Placement, Pos, Tspin};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JActive {
    kind: String,
    rotation: i32,
    x: i32,
    y: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JInput {
    board: Vec<u16>,
    active: JActive,
    hold: Option<String>,
    can_hold: bool,
    preview: Vec<String>,
    b2b: bool,
    combo: i32,
    pending: i32,
    #[serde(default)]
    speculative_pieces: Vec<String>,
}

#[derive(Deserialize)]
struct JOptions {
    width: usize,
    #[serde(default)]
    diverse: bool,
    #[serde(default)]
    exposure: f64,
    #[serde(default)]
    guideline: bool,
}

#[derive(Deserialize, Serialize, PartialEq, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct JPlacement {
    kind: String,
    rotation: i32,
    x: i32,
    y: i32,
    last_srs: i32,
    tspin: String,
}

#[derive(Deserialize, Serialize, PartialEq, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct JStep {
    placement: JPlacement,
    used_hold: bool,
    lines_cleared: u32,
    attack: i32,
    reward: f64,
}

#[derive(Deserialize, Serialize, PartialEq, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct JCandidate {
    placement: JPlacement,
    used_hold: bool,
    value: f64,
}

#[derive(Deserialize, Serialize, PartialEq, Debug, Clone)]
#[serde(rename_all = "camelCase")]
struct JResult {
    best: JStep,
    line: Vec<JStep>,
    value: f64,
    candidates: Vec<JCandidate>,
    nodes: u64,
    depth: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Case {
    id: String,
    input: JInput,
    options: JOptions,
    weights: Value,
    expect: Option<JResult>,
    #[serde(default)]
    ts_ms: f64,
}

fn kind(s: &str) -> Kind {
    Kind::from_char(s.chars().next().unwrap_or('?')).unwrap_or_else(|| panic!("bad piece {s}"))
}

fn num(v: &Value, path: &str) -> f64 {
    v.as_f64().unwrap_or_else(|| panic!("weights: {path} is not a number"))
}

/// TS `Weights` object (weights.ts shape) -> Rust weights.
fn weights_from_json(v: &Value) -> Weights {
    let mut w = Weights::default();
    for (i, name) in FEATURE_NAMES.iter().enumerate() {
        w.board[i] = num(&v["board"][name], &format!("board.{name}"));
    }
    w.attack = num(&v["attack"], "attack");
    for (i, name) in CLEAR_NAMES.iter().enumerate() {
        w.clear[i] = num(&v["clear"][name], &format!("clear.{name}"));
    }
    w.b2b_break = num(&v["b2bBreak"], "b2bBreak");
    w.wasted_t = num(&v["wastedT"], "wastedT");
    w.discount = num(&v["discount"], "discount");
    w
}

fn to_input(j: &JInput) -> SearchInput {
    SearchInput {
        board: Board::from_rows(&j.board),
        active: (kind(&j.active.kind), Pos { rotation: j.active.rotation, x: j.active.x, y: j.active.y }),
        hold: j.hold.as_deref().map(kind),
        can_hold: j.can_hold,
        preview: j.preview.iter().map(|s| kind(s)).collect(),
        b2b: j.b2b,
        combo: j.combo,
        pending: j.pending,
        speculative: j.speculative_pieces.iter().map(|s| kind(s)).collect(),
    }
}

fn jp(p: &Placement) -> JPlacement {
    JPlacement {
        kind: p.kind.as_char().to_string(),
        rotation: p.rotation as i32,
        x: p.x as i32,
        y: p.y as i32,
        last_srs: p.last_srs as i32,
        tspin: match p.tspin {
            Tspin::None => "none",
            Tspin::Mini => "mini",
            Tspin::Full => "full",
        }
        .to_string(),
    }
}

fn js(s: &Step) -> JStep {
    JStep {
        placement: jp(&s.placement),
        used_hold: s.used_hold,
        lines_cleared: s.lines_cleared,
        attack: s.attack,
        reward: s.reward,
    }
}

fn to_json(r: &SearchResult) -> JResult {
    JResult {
        best: js(&r.best),
        line: r.line.iter().map(js).collect(),
        value: r.value,
        candidates: r
            .candidates
            .iter()
            .map(|c| JCandidate { placement: jp(&c.placement), used_hold: c.used_hold, value: c.value })
            .collect(),
        nodes: r.nodes,
        depth: r.depth,
    }
}

/// Field-level diff for the report (first difference only).
fn first_diff(a: &JResult, b: &JResult) -> String {
    if a.best != b.best {
        return format!("best: ts={:?} rust={:?}", a.best, b.best);
    }
    if a.value.to_bits() != b.value.to_bits() {
        return format!("value: ts={:e} rust={:e}", a.value, b.value);
    }
    if a.nodes != b.nodes {
        return format!("nodes: ts={} rust={}", a.nodes, b.nodes);
    }
    if a.depth != b.depth {
        return format!("depth: ts={} rust={}", a.depth, b.depth);
    }
    if a.line != b.line {
        return format!("line differs (len ts={} rust={})", a.line.len(), b.line.len());
    }
    if a.candidates != b.candidates {
        for (i, (x, y)) in a.candidates.iter().zip(&b.candidates).enumerate() {
            if x != y {
                return format!("candidate {i}: ts={x:?} rust={y:?}");
            }
        }
        return format!("candidates len ts={} rust={}", a.candidates.len(), b.candidates.len());
    }
    "none".into()
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let path = args.get(1).expect("usage: attax-agree CASES.jsonl [--repeat N] [--show K] [--out FILE]");
    let mut repeat = 1usize;
    let mut show = 5usize;
    let mut out: Option<std::fs::File> = None;
    let mut i = 2;
    while i < args.len() {
        match args[i].as_str() {
            "--repeat" => {
                repeat = args[i + 1].parse().unwrap();
                i += 1;
            }
            "--show" => {
                show = args[i + 1].parse().unwrap();
                i += 1;
            }
            "--out" => {
                out = Some(std::fs::File::create(&args[i + 1]).unwrap());
                i += 1;
            }
            other => panic!("unknown arg {other}"),
        }
        i += 1;
    }

    let reader = BufReader::new(std::fs::File::open(path).expect("open cases"));
    let mut searcher = Searcher::new();
    let (mut total, mut moves_ok, mut full_ok, mut both_null) = (0usize, 0usize, 0usize, 0usize);
    let mut shown = 0usize;
    let mut rust_ms: Vec<f64> = Vec::new();
    let mut ts_ms: Vec<f64> = Vec::new();
    let mut ratio: Vec<f64> = Vec::new();
    let mut nodes_total = 0u64;
    for line in reader.lines() {
        let line = line.unwrap();
        if line.trim().is_empty() {
            continue;
        }
        let case: Case = serde_json::from_str(&line).expect("parse case");
        let input = to_input(&case.input);
        let options = SearchOptions {
            weights: weights_from_json(&case.weights),
            width: case.options.width,
            diverse: case.options.diverse,
            exposure: case.options.exposure,
            guideline: case.options.guideline,
        };
        let mut result = None;
        let mut best_ms = f64::INFINITY;
        for _ in 0..repeat {
            let t0 = Instant::now();
            result = searcher.search(&input, &options);
            best_ms = best_ms.min(t0.elapsed().as_secs_f64() * 1000.0);
        }
        let got = result.as_ref().map(to_json);
        total += 1;
        rust_ms.push(best_ms);
        if case.ts_ms > 0.0 {
            ts_ms.push(case.ts_ms);
            ratio.push(case.ts_ms / best_ms.max(1e-6));
        }
        if let Some(r) = &result {
            nodes_total += r.nodes;
        }
        let (move_eq, full_eq, diff) = match (&case.expect, &got) {
            (None, None) => {
                both_null += 1;
                (true, true, String::new())
            }
            (Some(e), Some(g)) => {
                let move_eq = e.best.placement == g.best.placement && e.best.used_hold == g.best.used_hold;
                let full_eq = e.best == g.best
                    && e.value.to_bits() == g.value.to_bits()
                    && e.nodes == g.nodes
                    && e.depth == g.depth
                    && e.line == g.line
                    && e.candidates == g.candidates;
                (move_eq, full_eq, first_diff(e, g))
            }
            (e, g) => (false, false, format!("null mismatch: ts={} rust={}", e.is_some(), g.is_some())),
        };
        if move_eq {
            moves_ok += 1;
        }
        if full_eq {
            full_ok += 1;
        } else if shown < show {
            shown += 1;
            eprintln!("MISMATCH {} (move {}): {}", case.id, if move_eq { "same" } else { "DIFFERENT" }, diff);
        }
        if let Some(f) = out.as_mut() {
            let mut m = Map::new();
            m.insert("id".into(), Value::String(case.id.clone()));
            m.insert("moveAgree".into(), Value::Bool(move_eq));
            m.insert("fullAgree".into(), Value::Bool(full_eq));
            m.insert("rustMs".into(), serde_json::json!(best_ms));
            m.insert("tsMs".into(), serde_json::json!(case.ts_ms));
            m.insert("nodes".into(), serde_json::json!(result.as_ref().map(|r| r.nodes).unwrap_or(0)));
            m.insert("result".into(), serde_json::to_value(&got).unwrap());
            writeln!(f, "{}", Value::Object(m)).unwrap();
        }
    }
    let mut sorted = rust_ms.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut ts_sorted = ts_ms.clone();
    ts_sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut ratio_sorted = ratio.clone();
    ratio_sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mean = |v: &[f64]| if v.is_empty() { 0.0 } else { v.iter().sum::<f64>() / v.len() as f64 };
    let pct = |n: usize| if total == 0 { 0.0 } else { 100.0 * n as f64 / total as f64 };
    println!(
        "cases {total}  decision agreement {moves_ok}/{total} ({:.2}%)  full agreement {full_ok}/{total} ({:.2}%)  both-null {both_null}",
        pct(moves_ok),
        pct(full_ok)
    );
    println!(
        "rust ms/decision: mean {:.2} p50 {:.2} p95 {:.2} max {:.2}   (best of {repeat}; {:.0} nodes/decision, {:.2} Mnodes/s)",
        mean(&rust_ms),
        percentile(&sorted, 0.5),
        percentile(&sorted, 0.95),
        sorted.last().copied().unwrap_or(0.0),
        nodes_total as f64 / total.max(1) as f64,
        nodes_total as f64 / rust_ms.iter().sum::<f64>().max(1e-9) / 1000.0
    );
    if !ts_ms.is_empty() {
        println!(
            "ts   ms/decision: mean {:.2} p50 {:.2} p95 {:.2} max {:.2}   speedup ts/rust: total {:.2}x  per-case p50 {:.2}x",
            mean(&ts_ms),
            percentile(&ts_sorted, 0.5),
            percentile(&ts_sorted, 0.95),
            ts_sorted.last().copied().unwrap_or(0.0),
            ts_ms.iter().sum::<f64>() / rust_ms.iter().sum::<f64>().max(1e-9),
            percentile(&ratio_sorted, 0.5)
        );
    }
    if full_ok != total {
        std::process::exit(1);
    }
}
