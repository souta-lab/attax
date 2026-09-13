//! Hoiko input-contract helpers for the native app: the faithful shipping
//! binary config, the carried `NextMino` state machine, the opponent-aware
//! `EvaluateAI` statics and the snapshot->search-request mapping.
//!
//! All of these are pure functions over the game's own types; the AI engines
//! (`hoiko-core`) consume the produced values. The carried weight row lives in
//! the search engine's own state (`hoiko_core::SearchState.weight_index`, the
//! `TransitionWeight` carry the adapter preserves across searches), and the
//! combo sign is produced by [`crate::engine`]'s `applyClear`.

#[cfg(test)]
mod tests;

pub mod bridge;
pub mod faithful;
pub mod next;
pub mod opponent;

pub use bridge::{
    cosmetic_steps, frame_step_ms, make_place_at_move, raw_request_from_snapshot,
    sync_from_snapshot, RawRequestOptions, RawSearchRequest, SyncFields,
    GAME_FRAMES_PER_MS,
};
pub use faithful::{
    resolve_faithful_hoiko_options, EvenMode, FaithfulConfigError, FaithfulHoiko,
    FaithfulHoikoEnv, FaithfulHoikoOptions, WeightPreset, FAITHFUL_HOIKO,
};
pub use next::{bag_remains_start, trust_range, NextState, NEXT_SIZE};
pub use opponent::{
    board_to_native_rows, native_pop_count, native_stack_height, opponent_is_pc_board,
    opponent_is_powerful_board,
};
