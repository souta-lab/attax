//! DeepSeek AI decision paths, ported from the TypeScript implementations.
//!
//! `best_move` mirrors v1 `createDeepSeekTetris().findBestMove` (hard-drop
//! enumeration, width-24/topK-16 beam). `find_best_move_v2` mirrors
//! `createDeepSeekV2().findBestMove`: kick/tuck-aware placements, T-spin
//! handling, garbage defense, opponent attack timing, downstack/burst
//! selection, and the default depth-7 beam. Both are pure and deterministic.

#![forbid(unsafe_code)]

pub mod api;
pub mod beam;
pub mod board;
pub mod deepseek_score;
pub mod evaluation;
pub mod features;
pub mod kick;
pub mod pieces;
pub mod scorer;
pub mod search;
pub mod tspin;
pub mod v2;
pub mod v2_score;
pub mod weights;

pub use api::{BestMoveInput, Move, SEARCH_DEPTH, best_move};
pub use board::{Board, COLS, ROWS};
pub use pieces::PieceKind;
pub use tspin::{TspinKind, classify_placement, classify_tspin, is_v2_tspin};
pub use v2::{
    V2_DEFAULT_DEPTH, V2_DEFAULT_TOP_K, V2_DEFAULT_WIDTH, V2Input, V2Move, V2MoveDetails,
    V2Options, find_best_move_v2, find_best_move_v2_details,
};
pub use v2_score::{V2BoardStats, V2OppModel, V2OpponentTelemetry, v2_board_stats, v2_opponent_model};
