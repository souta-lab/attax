//! Phase 1 native game core: the browser game + versus engine ported from
//! TypeScript, plus the Hoiko input-contract helpers the native app needs.
//!
//! This crate is the canonical game/versus implementation for the native
//! Rust/egui app (DeepSeek-Rust vs RustHoiko). It is pure and deterministic:
//! randomness and the clock are injected, and there are no OS/thread/wall-clock
//! dependencies, so the same code builds natively and for `wasm32-unknown-unknown`.
//!
//! Faithful-port map (TS source -> module):
//! - `src/core/board.ts`     -> [`board`]
//! - `src/core/pieces.ts`    -> [`pieces`]
//! - `src/core/srs.ts`       -> [`srs`]
//! - `src/core/tspin.ts`     -> [`tspin`]
//! - `src/core/garbage.ts`   -> [`garbage`]
//! - `src/core/engine.ts`    -> [`engine`]
//! - `src/versus/controller.ts` + `config.ts` + `speed.ts` -> [`versus`]
//! - `src/ai/hoiko-faithful.ts` / `hoiko-next.ts` / `hoiko-opponent.ts` and the
//!   snapshot->search-input mapping of `hoiko-rust-core.ts` -> [`contract`]
//! - `src/ui/types.ts`       -> [`types`]

#![forbid(unsafe_code)]

pub mod board;
pub mod contract;
pub mod engine;
pub mod garbage;
pub mod pieces;
pub mod rng;
pub mod srs;
pub mod tspin;
pub mod types;
pub mod versus;

pub use board::{compute_lock_afterstate, lock_and_clear, BitBoard, LockAfterstate, LockResult};
pub use engine::{EngineConfig, Game};
pub use garbage::{
    attack_for_clear, combo_bonus, gen_garbage_holes, push_incoming, tick_pending, ClearInfo,
    PendingChunk, GARBAGE_DELAY,
};
pub use pieces::{bottom_cells_of, cells_for, piece_cell_value, rotation_count};
pub use rng::{seeded_random, Rng, SeededRng};
pub use srs::{as_rotation, is_tspin_kick, kick_table, Kick};
pub use tspin::classify_tspin;
pub use types::*;
pub use versus::{
    speed_options, Winner,
    board_fingerprint, plan_steps, resolve_versus_config, AiFighter, Side, SideState,
    VersusConfig, VersusController, VersusControllerOptions, VersusResult, VersusTiming,
    VERSUS_DEFAULTS,
};
