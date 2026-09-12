//! Hoiko engine core — faithful Rust port of the stable TypeScript layers in
//! `src/ai/native/` (which are oracle-verified against the shipping binary).
//!
//! Values: `Board.line` uses the native bit orientation (column `c` = bit
//! `9-c`), rows bottom-up. This crate is pure and deterministic: the same code
//! builds natively (`cargo test`) and to `wasm32-unknown-unknown` for shipping.

#![forbid(unsafe_code)]

pub mod baby;
pub mod board;
pub mod evaluate;
pub mod expand;
pub mod expand_derive;
pub mod expand_template;
pub mod ffi;
pub mod gamepack;
pub mod mino;
pub mod nextmino;
pub mod offset;
pub mod offset_driver;
pub mod probe;
pub mod probe_eval;
pub mod probe_trace;
pub mod search;
pub mod shapes;
pub mod srs;
pub mod weight_index;
pub mod weights;

pub use board::{
    js_shr, log2, popcount, Board, BOARD_HEIGHT, BOARD_WIDTH, FULL_ROW,
};
pub use gamepack::{totaling, GamePack, Others};
pub use mino::{Command, FallMino, HoldMino, NextSource};
pub use nextmino::{trust_range, NextIterator, NextMino, NEXT_SIZE};
pub use offset::{GarbageData, OffsetData, OffsetOffAI};
pub use offset_driver::{
    act_from_lock_action, DriverSnapshot, HoikoOffsetDriver, LockAction, OffsetDecisionInput,
};
pub use search::{
    clear_delay, default_search_state, get_delay, run_search, set_next_option, FirstPlacement,
    SearchOutcome, SearchState, TAKE_OVER_TIME,
};
pub use shapes::{
    as_rotation, kind_to_mino, mino_to_kind, shape_for, Cell, MinoType, PieceKind, Shape, ACT_DOUBLE,
    ACT_NONE, ACT_PC, ACT_QUAD, ACT_SINGLE, ACT_TRIPLE, ACT_TSD, ACT_TSM, ACT_TSS, ACT_TST, MINO_I,
    MINO_J, MINO_L, MINO_NONE, MINO_O, MINO_S, MINO_T, MINO_Z,
};
pub use weights::HoikoWeights;
