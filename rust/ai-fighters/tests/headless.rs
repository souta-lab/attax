//! Reduced-config fighter integration tests: the full versus pipeline
//! (native Hoiko + native DeepSeek v2 through the controller) terminates
//! without execution mismatches and is deterministic.
//!
//! The faithful-config end-to-end evidence is produced by
//! `cargo run --release -p hoiko-app -- --headless` and compared against
//! `bun scripts/gate-v2.ts`; these tests keep the always-on suite fast in debug.

use ai_fighters::{
    DeepSeekFighter, DeepSeekFighterOptions, HoikoFighter, HoikoFighterOptions, MatchFighters,
    MatchOutcome, MatchReport, MatchRun, WallClock, run_match,
};

fn zero_clock() -> WallClock {
    Box::new(|| 0.0)
}

fn reduced_hoiko() -> HoikoFighter {
    HoikoFighter::with_clock(
        HoikoFighterOptions {
            beam_size_limit: 12,
            depth_limit: 6,
            min_depth: 2,
            adapt: false,
            offset: true,
            ..HoikoFighterOptions::default()
        },
        zero_clock(),
    )
}

fn reduced_deepseek() -> DeepSeekFighter {
    DeepSeekFighter::new(DeepSeekFighterOptions {
        depth: 3,
        width: 8,
        top_k: 4,
        ..DeepSeekFighterOptions::default()
    })
}

fn run_reduced(seed: i32, max_ticks: u64) -> MatchReport {
    run_match(MatchRun {
        max_ticks,
        ..MatchRun::new(
            seed,
            MatchFighters {
                left: Box::new(reduced_hoiko()),
                right: Box::new(reduced_deepseek()),
                left_name: "HOIKO",
                right_name: "DEEPSEEK",
            },
        )
    })
}

fn assert_clean(report: &MatchReport) {
    assert!(
        report.pieces > 0,
        "no pieces placed: {}",
        report.summary_line()
    );
    assert_eq!(report.left.mismatches, 0, "hoiko mismatches");
    assert_eq!(report.right.mismatches, 0, "deepseek mismatches");
    assert_eq!(report.left.board_failures, 0, "hoiko board failures");
    assert_eq!(report.right.board_failures, 0, "deepseek board failures");
    assert!(report.left.think_count > 0, "hoiko never thought");
    assert!(report.right.think_count > 0, "deepseek never thought");
}

#[test]
fn reduced_hoiko_vs_deepseek_runs_to_a_decision() {
    let report = run_reduced(1, 800);
    assert_clean(&report);
    assert!(
        matches!(
            report.outcome,
            MatchOutcome::Win(_) | MatchOutcome::Draw | MatchOutcome::Cap
        ),
        "unexpected outcome {:?}",
        report.outcome
    );
    if let MatchOutcome::Cap = report.outcome {
        assert_eq!(report.ticks, 800);
    }
}

#[test]
fn reduced_matches_are_deterministic_across_runs() {
    let first = run_reduced(7, 800);
    let second = run_reduced(7, 800);
    assert_eq!(first.outcome, second.outcome, "outcome");
    assert_eq!(first.reason, second.reason, "reason");
    assert_eq!(first.ticks, second.ticks, "ticks");
    assert_eq!(first.pieces, second.pieces, "pieces");
    for (left, right) in [(&first.left, &second.left), (&first.right, &second.right)] {
        assert_eq!(left.lines, right.lines, "{} lines", left.name);
        assert_eq!(left.sent, right.sent, "{} sent", left.name);
        assert_eq!(left.locks, right.locks, "{} locks", left.name);
        assert_eq!(left.pending, right.pending, "{} pending", left.name);
        assert_eq!(left.wins, right.wins, "{} wins", left.name);
    }
}

/// A rematch must not inherit carry state: two consecutive matches with the
/// same seed produce identical reports (the controller resets both fighters,
/// and each fighter's `reset` restores the new-match carry).
#[test]
fn rematch_reset_restores_identical_start_state() {
    let first = run_reduced(3, 400);
    let second = run_reduced(3, 400);
    assert_eq!(first.ticks, second.ticks, "ticks");
    assert_eq!(first.pieces, second.pieces, "pieces");
    assert_eq!(first.left.lines, second.left.lines, "hoiko lines");
    assert_eq!(first.right.lines, second.right.lines, "deepseek lines");
}
