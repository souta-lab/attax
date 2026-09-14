//! Headless match mode: run DeepSeek-vs-Hoiko matches with no display and
//! print a per-match summary (text or JSONL) plus an aggregate.

use ai_fighters::{
    DeepSeekFighter, HoikoFighter, MatchFighters, MatchOutcome, MatchReport, MatchRun, SideReport,
    run_match,
};
use game::{Side, VERSUS_DEFAULTS};
use serde_json::json;

use crate::cli::HeadlessArgs;

const LEFT_NAME: &str = "HOIKO";
const RIGHT_NAME: &str = "DEEPSEEK";

/// Run every requested seed, printing each report as it completes.
pub fn run(args: &HeadlessArgs) {
    if args.json {
        println!(
            "{}",
            json!({
                "type": "NATIVE-config",
                "engine": "rust-native",
                "seeds": args.seeds,
                "frames": args.frames,
                "tickMs": args.tick_ms,
                "timing": {
                    "mode": args.timing.timing.as_str(),
                    "inputMs": args.timing.input_ms,
                    "leftLatencyMs": args.timing.left_latency_ms,
                    "rightLatencyMs": args.timing.right_latency_ms,
                },
                "hoiko": {
                    "beamSizeLimit": args.hoiko.beam_size_limit,
                    "depthLimit": args.hoiko.depth_limit,
                    "adapt": args.hoiko.adapt,
                    "offset": args.hoiko.offset,
                    "framesPerThink": args.hoiko.frames_per_think,
                    "weightPreset": args.hoiko.weight_preset.as_str(),
                },
                "deepseek": {
                    "depth": args.deepseek.depth,
                    "width": args.deepseek.width,
                    "topK": args.deepseek.top_k,
                    "kicks": args.deepseek.use_kicks,
                    "opponent": args.deepseek.use_opponent,
                    "garbage": args.deepseek.use_garbage_defense,
                    "downstack": args.deepseek.use_downstack,
                },
            })
        );
    }
    let mut reports = Vec::with_capacity(args.seeds.len());
    for &seed in &args.seeds {
        let report = run_seed(args, seed);
        if args.json {
            println!("{}", match_json(&report));
        } else {
            println!("{}", report.summary_line());
        }
        reports.push(report);
    }
    print_aggregate(&reports, args.json);
}

/// Run one seed with fresh fighters.
pub fn run_seed(args: &HeadlessArgs, seed: i32) -> MatchReport {
    let fighters = MatchFighters {
        left: Box::new(HoikoFighter::new(args.hoiko)),
        right: Box::new(DeepSeekFighter::new(args.deepseek)),
        left_name: LEFT_NAME,
        right_name: RIGHT_NAME,
    };
    run_match(MatchRun {
        max_ticks: args.frames,
        tick_ms: args.tick_ms,
        options: args.timing.apply(VERSUS_DEFAULTS),
        ..MatchRun::new(seed, fighters)
    })
}

fn side_json(side: &SideReport) -> serde_json::Value {
    json!({
        "name": side.name,
        "wins": side.wins,
        "lines": side.lines,
        "sent": side.sent,
        "pending": side.pending,
        "lastAttack": side.last_attack,
        "locks": side.locks,
        "executionSourceMismatches": side.mismatches,
        "executionExpectedBoardFailures": side.board_failures,
        "thinkMs": side.think_ms,
        "thinkCount": side.think_count,
    })
}

/// Gate-compatible winner tag (`left`/`right`/`draw`/`cap`).
fn outcome_tag(report: &MatchReport) -> &'static str {
    match report.outcome {
        MatchOutcome::Win(Side::Left) => "left",
        MatchOutcome::Win(Side::Right) => "right",
        MatchOutcome::Draw => "draw",
        MatchOutcome::Cap => "cap",
    }
}

fn match_json(report: &MatchReport) -> serde_json::Value {
    json!({
        "type": "NATIVE-match",
        "engine": "rust-native",
        "seed": report.seed,
        "left": report.left.name,
        "right": report.right.name,
        "winner": outcome_tag(report),
        "winnerName": report.winner_name(),
        "reason": report.reason,
        "ticks": report.ticks,
        "pieces": report.pieces,
        "leftReport": side_json(&report.left),
        "rightReport": side_json(&report.right),
    })
}

fn print_aggregate(reports: &[MatchReport], json_output: bool) {
    let mut hoiko_wins = 0;
    let mut deepseek_wins = 0;
    let mut draws = 0;
    let mut caps = 0;
    let mut mismatches = 0;
    let mut board_failures = 0;
    for report in reports {
        match report.outcome {
            MatchOutcome::Win(Side::Left) => hoiko_wins += 1,
            MatchOutcome::Win(Side::Right) => deepseek_wins += 1,
            MatchOutcome::Draw => draws += 1,
            MatchOutcome::Cap => caps += 1,
        }
        mismatches += report.left.mismatches + report.right.mismatches;
        board_failures += report.left.board_failures + report.right.board_failures;
    }
    if json_output {
        println!(
            "{}",
            json!({
                "type": "NATIVE-summary",
                "matches": reports.len(),
                "hoikoWins": hoiko_wins,
                "deepseekWins": deepseek_wins,
                "draws": draws,
                "caps": caps,
                "executionSourceMismatches": mismatches,
                "executionExpectedBoardFailures": board_failures,
            })
        );
    } else {
        println!(
            "matches {} | HOIKO {}-{} DEEPSEEK | draws {} caps {} | mismatch {} boardFail {}",
            reports.len(),
            hoiko_wins,
            deepseek_wins,
            draws,
            caps,
            mismatches,
            board_failures
        );
    }
}
