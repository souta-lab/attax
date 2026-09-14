//! Native fighters for the AI-vs-AI Tetris app: the host side of the two
//! verified engines, without wasm.
//!
//! - [`hoiko`]: `RustHoiko` — the exact host logic of
//!   `src/ai/hoiko-rust-core.ts` (snapshot -> `RawSearchRequest` via
//!   `game::contract::bridge`, `hoiko-core` search + OffsetAI gate, NextMino
//!   carry, weight-row carry, frame clock), calling the same
//!   `hoiko_core::ffi::run_search_ffi` the wasm `h_search` ABI wraps.
//! - [`deepseek`]: `DeepSeekV2` — the exact host logic of
//!   `src/ai/deepseek-rust-core.ts` (snapshot -> `V2Input` ->
//!   `find_best_move_v2_details`, `placeAt` with the v2 landing row + T-spin
//!   witness).
//!
//! The fighters are pure and deterministic when configured with a deterministic
//! clock (`HoikoFighter::with_clock`); the default clock is monotonic wall time,
//! used only for the faithful `SetNextOption` beam adaptation. No decision logic
//! lives here: every move comes from the engine crates unchanged.

#![forbid(unsafe_code)]

pub mod clock;
pub mod deepseek;
pub mod hoiko;
pub mod matches;
pub mod presets;

pub use clock::{WallClock, wall_clock, wall_clock_ms};
pub use deepseek::{DeepSeekDebug, DeepSeekFighter, DeepSeekFighterOptions};
pub use hoiko::{HoikoDebug, HoikoFighter, HoikoFighterOptions, HoikoSearchState};
pub use matches::{MatchFighters, MatchOutcome, MatchReport, MatchRun, SideReport, run_match};
pub use presets::{VS_WEIGHT_LIST, weight_list};
