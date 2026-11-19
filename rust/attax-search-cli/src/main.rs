//! attax-agree — run the Rust search on JSONL cases dumped by
//! `tools/search-port/dump-cases.ts` and compare with the TS result recorded in each case.
//!
//! Usage: attax-agree CASES.jsonl [--repeat N] [--show K] [--out RESULTS.jsonl] [--width N]
//!        attax-agree --oneshot   (one case JSON on stdin -> one result JSON on stdout)
//!        attax-agree --serve     (long-lived: one case JSON per stdin line -> one result JSON per stdout line)
//!        attax-agree --version   (engine identity JSON: engine/binary/version/build)
//!
//! Each case: {"id", "input": SearchInput (TS shape), "options": {width, diverse, exposure,
//! guideline}, "weights": TS Weights object, "expect": TS SearchResult subset | null, "tsMs"}.
//! Reports decision agreement (best placement + hold), full agreement (value bits, nodes,
//! depth, whole planned line, every candidate) and per-case timing vs the TS time.
//!
//! S2 cases (dumped by `tools/search-port/dump-s2-cases.ts`) add "profile": "s2", the
//! S2 input fields (frame, garbageRows, b2bChain, dueThisLock, acceptRootKeys) and the
//! mechanism options (stock, solvency, rootVeto). The oneshot mode is the S2 lab
//! driver's engine boundary: one case in, the TS-shaped SearchResult (or null) out.

use std::io::{BufRead, BufReader, Read, Write};
use std::time::Instant;

use attax_search::features::FEATURE_NAMES;
use attax_search::movegen::GarbageRows;
use attax_search::search::{SearchInput, SearchOptions, SearchProfile, SearchResult, Searcher, Step};
use attax_search::solvency::SolvencyParams;
use attax_search::stock::StockParams;
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
    /// S2 fields (absent on guideline cases).
    #[serde(default)]
    frame: i64,
    #[serde(default)]
    garbage_rows: Option<Vec<u8>>,
    #[serde(default)]
    b2b_chain: Option<i32>,
    #[serde(default)]
    due_this_lock: i32,
    #[serde(default)]
    accept_root_keys: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JStock {
    scale: f64,
    beta_b: f64,
    beta_r: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JSolvency {
    coefficient: f64,
    margin_band: f64,
    doomed_penalty: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct JOptions {
    width: usize,
    #[serde(default)]
    diverse: bool,
    #[serde(default)]
    exposure: f64,
    #[serde(default)]
    guideline: bool,
    /// S2 mechanism options (absent on guideline cases).
    #[serde(default)]
    stock: Option<JStock>,
    #[serde(default)]
    solvency: Option<JSolvency>,
    #[serde(default)]
    root_veto: bool,
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
    #[serde(default)]
    id: String,
    /// "s2" selects the S2 rules profile; anything else (or absent) is guideline.
    #[serde(default)]
    profile: Option<String>,
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

fn opt_num(v: &Value, path: &str) -> f64 {
    if v.is_null() { 0.0 } else { num(v, path) }
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
    // Adopt keys are optional (absent = 0 = off) so corpora dumped before they existed
    // still load with their original meaning.
    w.b2b_state = opt_num(&v["b2bState"], "b2bState");
    for (i, slot) in w.t_slot_chain.iter_mut().enumerate() {
        let key = format!("tSlotChain{i}");
        *slot = opt_num(&v[key.as_str()], &key);
    }
    w.hold_t = opt_num(&v["holdT"], "holdT");
    w.hold_i = opt_num(&v["holdI"], "holdI");
    // S2 keys, likewise optional (the TS decider's merged profiles always carry
    // `conversion`; the rest are absent = 0 = off).
    w.conversion = opt_num(&v["conversion"], "conversion");
    w.hole_runs = opt_num(&v["holeRuns"], "holeRuns");
    w.hole_shifts = opt_num(&v["holeShifts"], "holeShifts");
    w.mini_single_delta = opt_num(&v["miniSingleDelta"], "miniSingleDelta");
    w.mini_double_delta = opt_num(&v["miniDoubleDelta"], "miniDoubleDelta");
    w.mini_triple_delta = opt_num(&v["miniTripleDelta"], "miniTripleDelta");
    w.wasted_t = num(&v["wastedT"], "wastedT");
    w.discount = num(&v["discount"], "discount");
    w
}

fn to_input(j: &JInput) -> SearchInput {
    let mut input = SearchInput::new(
        Board::from_rows(&j.board),
        (kind(&j.active.kind), Pos { rotation: j.active.rotation, x: j.active.x, y: j.active.y }),
        j.hold.as_deref().map(kind),
        j.can_hold,
        j.preview.iter().map(|s| kind(s)).collect(),
        j.b2b,
        j.combo,
        j.pending,
        j.speculative_pieces.iter().map(|s| kind(s)).collect(),
    );
    input.frame = j.frame;
    input.garbage_rows = j.garbage_rows.as_ref().map(|rows| GarbageRows::from_rows(rows));
    input.b2b_chain = j.b2b_chain;
    input.due_this_lock = j.due_this_lock;
    input.accept_root_keys =
        j.accept_root_keys.as_ref().map(|keys| keys.iter().cloned().collect());
    input
}

fn to_options(case: &Case, width_override: Option<usize>) -> SearchOptions {
    SearchOptions {
        weights: weights_from_json(&case.weights),
        width: width_override.unwrap_or(case.options.width),
        diverse: case.options.diverse,
        exposure: case.options.exposure,
        guideline: case.options.guideline,
        profile: if case.profile.as_deref() == Some("s2") {
            SearchProfile::S2
        } else {
            SearchProfile::Guideline
        },
        stock: case.options.stock.as_ref().map(|s| StockParams { scale: s.scale, beta_b: s.beta_b, beta_r: s.beta_r }),
        solvency: case.options.solvency.as_ref().map(|s| SolvencyParams {
            coefficient: s.coefficient,
            margin_band: s.margin_band,
            doomed_penalty: s.doomed_penalty,
        }),
        root_veto: case.options.root_veto,
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

/// Run one case and shape the result like the TS SearchResult (plus the feature
/// breakdown the lab's SearchResult carries and the engine-internal searchMs).
fn run_case(case: &Case, searcher: &mut Searcher) -> Value {
    let input = to_input(&case.input);
    let options = to_options(case, None);
    let t0 = Instant::now();
    let result = searcher.search(&input, &options);
    let search_ms = t0.elapsed().as_secs_f64() * 1000.0;
    match &result {
        None => Value::Null,
        Some(r) => {
            let mut m = serde_json::to_value(to_json(r)).unwrap();
            let breakdown: Map<String, Value> = FEATURE_NAMES
                .iter()
                .zip(r.breakdown.iter())
                .map(|(name, v)| (name.to_string(), serde_json::json!(v)))
                .collect();
            let obj = m.as_object_mut().unwrap();
            obj.insert("breakdown".into(), Value::Object(breakdown));
            // Engine-internal search time; the driver feeds it to the speed
            // tripwire that catches a mis-wired (TS-speed) "Rust" path.
            obj.insert("searchMs".into(), serde_json::json!(search_ms));
            m
        }
    }
}

/// Oneshot mode: one case JSON on stdin, one result JSON on stdout. Kept for
/// debugging; the lab driver uses --serve for real runs.
fn oneshot() {
    let mut text = String::new();
    std::io::stdin().read_to_string(&mut text).expect("read stdin");
    let case: Case = serde_json::from_str(&text).expect("parse case");
    let mut searcher = Searcher::new();
    println!("{}", run_case(&case, &mut searcher));
}

/// Server mode: a long-lived engine process. One case JSON per stdin line, one
/// result JSON per stdout line, in order. The search itself is unchanged (the
/// same run_case the oneshot and batch modes use); only the process boundary
/// moves, so per-decision process startup disappears from match/corpus runs.
fn serve() {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut searcher = Searcher::new();
    for line in stdin.lock().lines() {
        let line = line.expect("read stdin");
        if line.trim().is_empty() {
            continue;
        }
        let case: Case = serde_json::from_str(&line).expect("parse case");
        let out = run_case(&case, &mut searcher);
        let mut lock = stdout.lock();
        writeln!(lock, "{out}").expect("write stdout");
        lock.flush().expect("flush stdout");
    }
}

/// One evaluated batch case: the search result and its best-of-repeat time.
struct Eval {
    result: Option<SearchResult>,
    best_ms: f64,
}

fn eval_case(
    case: &Case,
    searcher: &mut Searcher,
    repeat: usize,
    width_override: Option<usize>,
) -> Eval {
    let input = to_input(&case.input);
    let options = to_options(case, width_override);
    let mut result = None;
    let mut best_ms = f64::INFINITY;
    for _ in 0..repeat {
        let t0 = Instant::now();
        result = searcher.search(&input, &options);
        best_ms = best_ms.min(t0.elapsed().as_secs_f64() * 1000.0);
    }
    Eval { result, best_ms }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--version") {
        // Engine identity handshake: the S2 lab driver runs this before a run
        // and stamps every record with what answers.
        println!(
            "{}",
            serde_json::json!({
                "engine": "rust",
                "binary": "attax-agree",
                "version": env!("CARGO_PKG_VERSION"),
                "build": env!("ATTAX_BUILD"),
            })
        );
        return;
    }
    if args.get(1).map(String::as_str) == Some("--oneshot") {
        oneshot();
        return;
    }
    if args.get(1).map(String::as_str) == Some("--serve") {
        serve();
        return;
    }
    let path = args.get(1).expect("usage: attax-agree CASES.jsonl [--repeat N] [--show K] [--out FILE] [--width N] [--jobs N]");
    let mut repeat = 1usize;
    let mut show = 5usize;
    let mut width_override: Option<usize> = None;
    let mut jobs: Option<usize> = None;
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
            "--width" => {
                width_override = Some(args[i + 1].parse().unwrap());
                i += 1;
            }
            "--jobs" => {
                jobs = Some(args[i + 1].parse().unwrap());
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
    let cases: Vec<Case> = reader
        .lines()
        .map(|l| l.unwrap())
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(&l).expect("parse case"))
        .collect();
    // Case evaluation is embarrassingly parallel: each worker owns a Searcher
    // (the search itself stays single-threaded per decision) and results are
    // reassembled in input order, so agreement output is identical at any
    // --jobs. Default: all cores.
    let jobs = jobs
        .unwrap_or_else(|| std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1))
        .max(1);
    let evals: Vec<Eval> = if jobs == 1 || cases.len() < 2 {
        let mut searcher = Searcher::new();
        cases.iter().map(|c| eval_case(c, &mut searcher, repeat, width_override)).collect()
    } else {
        let chunk = cases.len().div_ceil(jobs);
        std::thread::scope(|s| {
            let handles: Vec<_> = cases
                .chunks(chunk)
                .map(|part| {
                    s.spawn(move || {
                        let mut searcher = Searcher::new();
                        part.iter()
                            .map(|c| eval_case(c, &mut searcher, repeat, width_override))
                            .collect::<Vec<_>>()
                    })
                })
                .collect();
            handles
                .into_iter()
                .flat_map(|h| h.join().unwrap())
                .collect::<Vec<_>>()
        })
    };
    let (mut total, mut moves_ok, mut full_ok, mut both_null) = (0usize, 0usize, 0usize, 0usize);
    let mut shown = 0usize;
    let mut rust_ms: Vec<f64> = Vec::new();
    let mut ts_ms: Vec<f64> = Vec::new();
    let mut ratio: Vec<f64> = Vec::new();
    let mut nodes_total = 0u64;
    for (case, eval) in cases.iter().zip(evals.iter()) {
        let Eval { result, best_ms } = eval;
        let best_ms = *best_ms;
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
