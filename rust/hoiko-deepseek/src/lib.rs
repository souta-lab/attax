//! DeepSeek AI decision path, ported from the TypeScript implementation.
//!
//! Pure and deterministic: hard-drop placement enumeration plus a width-24,
//! topK-16 beam search with hold branching. No rotation kicks, no opponent
//! modelling. `best_move` mirrors `createDeepSeekTetris().findBestMove`.

#![forbid(unsafe_code)]

pub mod api;
pub mod beam;
pub mod board;
pub mod deepseek_score;
pub mod evaluation;
pub mod features;
pub mod pieces;
pub mod scorer;
pub mod search;
pub mod weights;

pub use api::{BestMoveInput, Move, SEARCH_DEPTH, best_move};
pub use board::{Board, COLS, ROWS};
pub use pieces::PieceKind;
