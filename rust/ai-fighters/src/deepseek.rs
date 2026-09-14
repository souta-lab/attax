//! Native DeepSeek v2 fighter — the exact host side of
//! `src/ai/deepseek-rust-core.ts`, calling `deepseek-rust`'s
//! `find_best_move_v2_details` directly instead of through `ds_best_move`.
//!
//! Mapping (mirrored from the TS adapter):
//! - snapshot grid -> bottom-up bit rows (`toBoard`),
//! - `next` 28 slots + length, `hold`, `can_hold`, public `combo`/`b2b`,
//!   `pendingGarbage`, 1-based per-think piece counter,
//! - opponent telemetry with present flags,
//! - result -> `placeAt` (landing row from `y` + `maxNativeY`, T-spin `lastSrs`
//!   from `is_v2_tspin`) or a hold move.

use deepseek_rust::{
    Board, PieceKind, V2_DEFAULT_DEPTH, V2_DEFAULT_TOP_K, V2_DEFAULT_WIDTH, V2Input, V2MoveDetails,
    V2OpponentTelemetry, V2Options, find_best_move_v2_details, is_v2_tspin,
};
use game::AiFighter;
use game::types::{AiExecutionPlan, AiMove, AiStep, GameSnapshot, PieceKind as GamePiece, ROWS};

/// `src/ai/deepseek-rust-core.ts` `NEXT_SLOTS`.
const NEXT_SLOTS: usize = 28;

/// `src/ai/deepseek-v2.ts` `DeepSeekV2Options` with the same defaults the wasm
/// adapter resolves.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DeepSeekFighterOptions {
    pub depth: usize,
    pub width: usize,
    pub top_k: usize,
    pub use_kicks: bool,
    pub use_opponent: bool,
    pub use_garbage_defense: bool,
    pub use_downstack: bool,
}

impl Default for DeepSeekFighterOptions {
    fn default() -> DeepSeekFighterOptions {
        DeepSeekFighterOptions {
            depth: V2_DEFAULT_DEPTH,
            width: V2_DEFAULT_WIDTH,
            top_k: V2_DEFAULT_TOP_K,
            use_kicks: true,
            use_opponent: true,
            use_garbage_defense: true,
            use_downstack: true,
        }
    }
}

impl From<V2Options> for DeepSeekFighterOptions {
    fn from(options: V2Options) -> DeepSeekFighterOptions {
        DeepSeekFighterOptions {
            depth: options.depth,
            width: options.width,
            top_k: options.top_k,
            use_kicks: options.use_kicks,
            use_opponent: options.use_opponent,
            use_garbage_defense: options.use_garbage_defense,
            use_downstack: options.use_downstack,
        }
    }
}

impl From<DeepSeekFighterOptions> for V2Options {
    fn from(options: DeepSeekFighterOptions) -> V2Options {
        V2Options {
            depth: options.depth,
            width: options.width,
            top_k: options.top_k,
            use_kicks: options.use_kicks,
            use_opponent: options.use_opponent,
            use_garbage_defense: options.use_garbage_defense,
            use_downstack: options.use_downstack,
        }
    }
}

/// `deepseek-rust-core.ts` `RustDeepSeekFighter.getDebug`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DeepSeekDebug {
    pub score: f64,
    pub fire_score: f64,
    pub lines_cleared: u32,
    pub is_tspin: bool,
    pub search_depth: usize,
    pub top_holes: u32,
    pub top_max_height: f64,
    pub pieces: u32,
}

/// The native DeepSeek v2 fighter. One instance per side;
/// [`AiFighter::reset`] clears the per-match piece counter like the TS
/// adapter's `reset`.
pub struct DeepSeekFighter {
    options: DeepSeekFighterOptions,
    piece_index: u32,
    last_debug: Option<DeepSeekDebug>,
}

impl DeepSeekFighter {
    pub fn new(options: DeepSeekFighterOptions) -> DeepSeekFighter {
        DeepSeekFighter {
            options,
            piece_index: 0,
            last_debug: None,
        }
    }

    pub fn options(&self) -> DeepSeekFighterOptions {
        self.options
    }

    pub fn last_debug(&self) -> Option<DeepSeekDebug> {
        self.last_debug
    }

    /// `RustDeepSeekFighter.searchSnapshot`.
    pub fn search_snapshot(&mut self, snapshot: &GameSnapshot) -> Option<AiMove> {
        if snapshot.active.is_none() || snapshot.game_over {
            return None;
        }
        let active = snapshot.active.as_ref()?;
        let board = board_from_snapshot(snapshot);
        let next: Vec<PieceKind> = snapshot
            .next
            .iter()
            .take(NEXT_SLOTS)
            .map(|kind| to_ds(*kind))
            .collect();
        self.piece_index += 1;
        let input = V2Input {
            board: &board,
            active: to_ds(active.kind),
            next: &next,
            hold: snapshot.hold.map(to_ds),
            can_hold: snapshot.can_hold,
            b2b: snapshot.b2b,
            combo: snapshot.combo,
            pending_garbage: snapshot.pending_garbage,
            pieces: self.piece_index,
            opponent: opponent_telemetry(snapshot),
            options: self.options.into(),
        };
        let details = find_best_move_v2_details(&input)?;
        self.last_debug = Some(DeepSeekDebug {
            score: details.score,
            fire_score: details.fire_score,
            lines_cleared: details.lines_cleared,
            is_tspin: details.is_tspin,
            search_depth: details.search_depth,
            top_holes: details.top_holes,
            top_max_height: details.top_max_height,
            pieces: self.piece_index,
        });
        move_from_details(snapshot, &board, &details)
    }
}

impl AiFighter for DeepSeekFighter {
    fn find_best_move(&mut self, snapshot: &GameSnapshot) -> Option<AiMove> {
        self.search_snapshot(snapshot)
    }

    fn reset(&mut self) {
        self.piece_index = 0;
        self.last_debug = None;
    }
}

/// `deepseek-v2.ts` `maxNativeY`: the piece's lowest offset in native (upward-y)
/// cells, `cellsFor(kind, rotation)`.
fn max_native_y(kind: GamePiece, rotation: i32) -> i32 {
    let mut max = 0;
    for cell in deepseek_rust::pieces::cells_for(to_ds(kind), rotation) {
        if cell.y > max {
            max = cell.y;
        }
    }
    max
}

/// `deepseek.ts` `toBoard`: top-down grid -> bottom-up bit rows (bit x = col x).
fn board_from_snapshot(snapshot: &GameSnapshot) -> Board {
    let mut board = [0u16; ROWS];
    for (y, row_bits) in board.iter_mut().enumerate() {
        let row = &snapshot.board.grid[ROWS - 1 - y];
        let mut bits = 0u16;
        for (x, cell) in row.iter().enumerate() {
            if *cell != 0 {
                bits |= 1u16 << x;
            }
        }
        *row_bits = bits;
    }
    board
}

/// `deepseek-rust-core.ts` `writeInput` opponent slots, in order.
fn opponent_telemetry(snapshot: &GameSnapshot) -> V2OpponentTelemetry {
    match &snapshot.opponent {
        Some(opponent) => V2OpponentTelemetry {
            lock_id: Some(i64::from(opponent.lock_id)),
            last_clear_lines: opponent.last_clear_lines.map(i64::from),
            last_native_combo: opponent.last_native_combo.map(i64::from),
            last_native_btb: opponent.last_native_btb.map(i64::from),
            last_raw_attack: opponent.last_raw_attack.map(i64::from),
            combo: Some(i64::from(opponent.combo)),
            btb: Some(i64::from(opponent.btb)),
        },
        None => V2OpponentTelemetry {
            lock_id: None,
            last_clear_lines: None,
            last_native_combo: None,
            last_native_btb: None,
            last_raw_attack: None,
            combo: None,
            btb: None,
        },
    }
}

/// `deepseek-rust-core.ts` `moveFromOut` + `deepseek-v2.ts` `buildPlaceAt`.
fn move_from_details(
    snapshot: &GameSnapshot,
    board: &Board,
    details: &V2MoveDetails,
) -> Option<AiMove> {
    let active = snapshot.active.as_ref()?;
    let rotation = ((details.mv.rotation % 4) + 4) % 4;
    if details.mv.use_hold {
        return Some(AiMove {
            target_x: details.mv.x,
            target_rotation: rotation,
            use_hold: true,
            garbage_wait: None,
            execution: None,
        });
    }
    let top_row = ROWS as i32 - 1 - max_native_y(active.kind, rotation) - details.y;
    let last_srs = if is_v2_tspin(board, to_ds(active.kind), rotation, details.mv.x, details.y) {
        1
    } else {
        0
    };
    Some(AiMove {
        target_x: details.mv.x,
        target_rotation: rotation,
        use_hold: false,
        garbage_wait: None,
        execution: Some(AiExecutionPlan {
            target_x: details.mv.x,
            target_rotation: rotation,
            steps: vec![AiStep::PlaceAt {
                rotation,
                x: details.mv.x,
                top_row: Some(top_row),
                last_srs: Some(last_srs),
            }],
            expected_board: Vec::new(),
            expected_lines_cleared: 0,
            source_active_kind: active.kind,
            source_rotation: 0,
            source_x: 3,
            source_board_fingerprint: game::board_fingerprint(snapshot),
            source_hold: snapshot.hold,
            source_can_hold: snapshot.can_hold,
        }),
    })
}

fn to_ds(kind: GamePiece) -> PieceKind {
    match kind {
        GamePiece::I => PieceKind::I,
        GamePiece::O => PieceKind::O,
        GamePiece::T => PieceKind::T,
        GamePiece::S => PieceKind::S,
        GamePiece::Z => PieceKind::Z,
        GamePiece::J => PieceKind::J,
        GamePiece::L => PieceKind::L,
    }
}
