//! Headless match runner: the versus controller driven to KO or tick cap, plus
//! the per-side metrics the app and the native evidence runs report.
//!
//! Mirrors `scripts/gate-v2.ts` `runMatch`: same `tick(16ms)` loop, same
//! `MAX_TICKS` cap, same result fields. The fighters are constructed by the
//! caller (fresh state per match); nothing here touches decision logic.

use game::{
    AiFighter, Side, SideState, VERSUS_DEFAULTS, VersusConfig, VersusController,
    VersusControllerOptions, Winner,
};

/// `scripts/gate-v2.ts` `MAX_TICKS`.
pub const MAX_TICKS: u64 = 12_000;
/// `scripts/gate-v2.ts` `TICK_MS`.
pub const TICK_MS: f64 = 16.0;

/// The two fighters of one match, with their view-layer names.
pub struct MatchFighters<'a> {
    pub left: Box<dyn AiFighter>,
    pub right: Box<dyn AiFighter>,
    pub left_name: &'a str,
    pub right_name: &'a str,
}

/// One headless match configuration.
pub struct MatchRun<'a> {
    pub seed: i32,
    pub fighters: MatchFighters<'a>,
    pub max_ticks: u64,
    pub tick_ms: f64,
    pub options: VersusControllerOptions,
    pub config: VersusConfig,
}

impl<'a> MatchRun<'a> {
    /// Gate defaults: 12000 ticks at 16 ms, canonical versus config.
    pub fn new(seed: i32, fighters: MatchFighters<'a>) -> MatchRun<'a> {
        MatchRun {
            seed,
            fighters,
            max_ticks: MAX_TICKS,
            tick_ms: TICK_MS,
            options: VERSUS_DEFAULTS,
            config: VersusConfig::default(),
        }
    }
}

/// Match outcome: a side won, a draw, or the tick cap was reached.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MatchOutcome {
    Win(Side),
    Draw,
    Cap,
}

/// Per-side summary (gate `SideMetrics` minus the display heuristics).
#[derive(Clone, Debug, PartialEq)]
pub struct SideReport {
    pub name: String,
    pub wins: i32,
    pub lines: i32,
    pub sent: i32,
    pub pending: i32,
    pub last_attack: i32,
    pub locks: i32,
    pub mismatches: i32,
    pub board_failures: i32,
    pub think_ms: f64,
    pub think_count: i32,
}

/// Full match report, printable as JSON-ish evidence.
#[derive(Clone, Debug, PartialEq)]
pub struct MatchReport {
    pub seed: i32,
    pub outcome: MatchOutcome,
    pub reason: String,
    pub ticks: u64,
    pub pieces: i32,
    pub left: SideReport,
    pub right: SideReport,
}

impl MatchReport {
    /// Winner's display name, `None` for a draw or tick cap.
    pub fn winner_name(&self) -> Option<&str> {
        match self.outcome {
            MatchOutcome::Win(Side::Left) => Some(&self.left.name),
            MatchOutcome::Win(Side::Right) => Some(&self.right.name),
            MatchOutcome::Draw | MatchOutcome::Cap => None,
        }
    }

    /// Compact one-line summary for the CLI and tests.
    pub fn summary_line(&self) -> String {
        let outcome = match self.outcome {
            MatchOutcome::Win(side) => {
                let name = if side == Side::Left {
                    &self.left.name
                } else {
                    &self.right.name
                };
                format!("{name} wins ({})", self.reason)
            }
            MatchOutcome::Draw => format!("draw ({})", self.reason),
            MatchOutcome::Cap => format!("cap after {} ticks", self.max_ticks_hint()),
        };
        format!(
            "seed {}: {outcome} | ticks {} pieces {} | lines {}-{} sent {}-{} | mismatch {}/{} boardFail {}/{}",
            self.seed,
            self.ticks,
            self.pieces,
            self.left.lines,
            self.right.lines,
            self.left.sent,
            self.right.sent,
            self.left.mismatches,
            self.right.mismatches,
            self.left.board_failures,
            self.right.board_failures,
        )
    }

    fn max_ticks_hint(&self) -> u64 {
        self.ticks
    }
}

fn side_report(state: &SideState, name: &str) -> SideReport {
    let snapshot = state.core.snapshot();
    SideReport {
        name: name.to_string(),
        wins: state.wins,
        lines: snapshot.lines,
        sent: state.sent_total,
        pending: snapshot.pending_garbage,
        last_attack: snapshot.last_attack,
        locks: snapshot.lock_id,
        mismatches: state.execution_source_mismatches,
        board_failures: state.execution_expected_board_failures,
        think_ms: state.think_ms,
        think_count: state.think_count,
    }
}

/// Run one match to KO or the tick cap (gate `runMatch`).
pub fn run_match(run: MatchRun<'_>) -> MatchReport {
    let MatchRun {
        seed,
        fighters,
        max_ticks,
        tick_ms,
        options,
        config,
    } = run;
    let left_name = fighters.left_name.to_string();
    let right_name = fighters.right_name.to_string();
    let mut controller = VersusController::new(fighters.left, fighters.right, seed, config);
    controller.set_clock(crate::clock::wall_clock());
    let mut ticks: u64 = 0;
    while controller.result.is_none() && ticks < max_ticks {
        controller.tick(tick_ms, &options);
        ticks += 1;
    }
    let result = controller.result.as_ref();
    let (outcome, reason) = match result {
        Some(result) => {
            let outcome = match result.winner {
                Winner::Left => MatchOutcome::Win(Side::Left),
                Winner::Right => MatchOutcome::Win(Side::Right),
                Winner::Draw => MatchOutcome::Draw,
            };
            (outcome, result.reason.clone())
        }
        None => (MatchOutcome::Cap, "max-ticks".to_string()),
    };
    MatchReport {
        seed,
        outcome,
        reason,
        ticks,
        pieces: result.map_or(controller.pieces, |result| result.pieces),
        left: side_report(&controller.left, &left_name),
        right: side_report(&controller.right, &right_name),
    }
}
