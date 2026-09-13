//! Snapshot -> search-request mapping and `placeAt` execution witnesses.
//!
//! Faithful port of the pure helpers at the bottom of
//! `src/ai/hoiko-rust-core.ts`: `frameStepMs`, `rawRequestFromSnapshot`,
//! `syncFromSnapshot`, `makePlaceAtMove`, plus `lockActionCode` (exposed as
//! [`crate::types::LockAction::code`]).

use super::opponent::{board_to_native_rows, native_pop_count, native_stack_height, opponent_is_pc_board, opponent_is_powerful_board};
use super::faithful::EvenMode;
use crate::types::{
    AiExecutionPlan, AiMove, AiStep, GameSnapshot, LockAction, PieceKind, MINO_NONE,
};
use crate::versus::board_fingerprint;

/// `src/ai/hoiko-rust-core.ts` `GAME_FRAMES_PER_MS`.
pub const GAME_FRAMES_PER_MS: f64 = 0.06;

/// `src/ai/hoiko-rust-core.ts` `frameStepMs`: the deterministic frame-clock
/// step applied once per think (round, mirroring JS `Math.round`).
pub fn frame_step_ms(frames_per_think: i32) -> f64 {
    (frames_per_think as f64 / GAME_FRAMES_PER_MS).round()
}

/// `src/ai/hoiko-rust-core.ts` `RawSearchRequest`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawSearchRequest {
    /// Native bottom-up rows (row 0 = bottom), column c = bit (9-c). Up to 32.
    pub board: Vec<i32>,
    pub current: i32,
    /// Queue AFTER the current piece, up to 28 entries.
    pub next: Vec<i32>,
    pub hold: i32,
    pub combo: i32,
    pub btb: i32,
    pub is_even: bool,
    pub use_s4w: bool,
    pub use_pcstack: bool,
    pub view_next: i32,
    pub allow_hold: bool,
    pub depth: i32,
    pub multi_evaluation: bool,
    pub opponent_is_pc_board: bool,
    pub opponent_is_powerful_board: bool,
    pub opponents_combo: i32,
}

/// The engine-config subset `rawRequestFromSnapshot` reads in TS.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RawRequestOptions {
    pub versus: bool,
    pub use_s4w: bool,
    pub use_pcstack: bool,
    pub view_next: i32,
    pub is_even_board: bool,
    pub depth: i32,
    pub even_mode: EvenMode,
}

/// `src/ai/hoiko-rust-core.ts` `syncFromSnapshot` / `SyncFields`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SyncFields {
    pub lock_id: i32,
    pub last_action: LockAction,
    pub last_attack: i32,
    pub opponent_lock_id: Option<i32>,
    pub opponent_last_clear_lines: Option<i32>,
    pub opponent_last_native_btb: Option<i32>,
    pub opponent_last_native_combo: Option<i32>,
}

/// `src/ai/hoiko-rust-core.ts` `versusIsEven`.
fn versus_is_even(mode: EvenMode, board: &[i32]) -> bool {
    match mode {
        EvenMode::True => true,
        EvenMode::False => false,
        EvenMode::Auto => native_pop_count(board, native_stack_height(board)) % 2 == 0,
    }
}

/// `src/ai/hoiko-rust-core.ts` `rawRequestFromSnapshot`.
pub fn raw_request_from_snapshot(
    snapshot: &GameSnapshot,
    options: &RawRequestOptions,
) -> Option<RawSearchRequest> {
    let active = snapshot.active.as_ref()?;
    let board = board_to_native_rows(&snapshot.board);
    let next: Vec<i32> = snapshot.next.iter().map(|k| k.to_mino()).collect();
    let opponent_rows = match &snapshot.opponent {
        Some(opponent) => board_to_native_rows(&opponent.board),
        None => Vec::new(),
    };
    let has_opponent = snapshot.opponent.is_some();
    let opponents_combo = if options.versus {
        snapshot.opponent.as_ref().map(|o| o.combo).unwrap_or(0)
    } else {
        0
    };
    let opponent_pc = options.versus && has_opponent && opponent_is_pc_board(&opponent_rows);
    let opponent_powerful = options.versus
        && options.use_s4w
        && has_opponent
        && opponent_is_powerful_board(&opponent_rows, opponents_combo, snapshot.pending_garbage);
    let is_even = if options.versus {
        versus_is_even(options.even_mode, &board)
    } else {
        options.is_even_board
    };
    Some(RawSearchRequest {
        board,
        current: active.kind.to_mino(),
        next,
        hold: snapshot.hold.map(PieceKind::to_mino).unwrap_or(MINO_NONE),
        combo: snapshot.native_combo,
        btb: snapshot.native_btb,
        is_even,
        use_s4w: options.use_s4w,
        use_pcstack: options.use_pcstack,
        view_next: options.view_next,
        allow_hold: snapshot.can_hold,
        depth: options.depth,
        multi_evaluation: options.versus,
        opponent_is_pc_board: opponent_pc,
        opponent_is_powerful_board: opponent_powerful,
        opponents_combo,
    })
}

/// `src/ai/hoiko-rust-core.ts` `syncFromSnapshot`.
pub fn sync_from_snapshot(snapshot: &GameSnapshot) -> SyncFields {
    SyncFields {
        lock_id: snapshot.lock_id,
        last_action: snapshot.last_action,
        last_attack: snapshot.last_attack,
        opponent_lock_id: snapshot.opponent.as_ref().map(|o| o.lock_id),
        opponent_last_clear_lines: snapshot
            .opponent
            .as_ref()
            .and_then(|o| o.last_clear_lines),
        opponent_last_native_btb: snapshot.opponent.as_ref().and_then(|o| o.last_native_btb),
        opponent_last_native_combo: snapshot.opponent.as_ref().and_then(|o| o.last_native_combo),
    }
}

/// `src/ai/hoiko-rust-core.ts` `cosmeticSteps`.
pub fn cosmetic_steps(
    from_rotation: i32,
    from_x: i32,
    to_rotation: i32,
    to_x: i32,
) -> Vec<AiStep> {
    let mut steps = Vec::new();
    let cur = ((from_rotation % 4) + 4) % 4;
    let cw = (to_rotation - cur + 4) % 4;
    let ccw = (cur - to_rotation + 4) % 4;
    let count = if cw <= ccw { cw } else { ccw };
    for _ in 0..count {
        steps.push(if cw <= ccw {
            AiStep::RotateCW
        } else {
            AiStep::RotateCCW
        });
    }
    for _ in 0..(to_x - from_x).abs() {
        steps.push(if to_x < from_x {
            AiStep::Left
        } else {
            AiStep::Right
        });
    }
    steps
}

/// `src/ai/hoiko-rust-core.ts` `makePlaceAtMove`.
pub fn make_place_at_move(
    snapshot: &GameSnapshot,
    target_x: i32,
    target_rotation: i32,
    top_row: i32,
    last_srs: i32,
) -> Option<AiMove> {
    let active = snapshot.active.as_ref()?;
    let mut steps = cosmetic_steps(active.rotation, active.pos_x, target_rotation, target_x);
    steps.push(AiStep::PlaceAt {
        rotation: target_rotation,
        x: target_x,
        top_row: Some(top_row),
        last_srs: Some(last_srs),
    });
    Some(AiMove {
        target_x,
        target_rotation,
        use_hold: false,
        garbage_wait: None,
        execution: Some(AiExecutionPlan {
            target_x,
            target_rotation,
            steps,
            expected_board: Vec::new(),
            expected_lines_cleared: 0,
            source_active_kind: active.kind,
            source_rotation: active.rotation,
            source_x: active.pos_x,
            source_board_fingerprint: board_fingerprint(snapshot),
            source_hold: snapshot.hold,
            source_can_hold: snapshot.can_hold,
        }),
    })
}
