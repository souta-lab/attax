//! Versus controller: two fighters, fair step model, garbage exchange, rematch.
//!
//! Faithful port of `src/versus/controller.ts` plus the canonical match config
//! resolver from `src/versus/config.ts` and the speed multipliers from
//! `src/versus/speed.ts`.

mod controller;
mod flow;
mod state;
mod step;

#[cfg(test)]
mod tests;

pub use controller::step_side;
pub use state::{SideState, VersusController, VersusResult, Winner};
pub use step::{board_fingerprint, execution_matches, plan_steps};

use crate::garbage::GARBAGE_DELAY;
use crate::types::{AiMove, GameSnapshot};

/// `src/versus/controller.ts` `MAX_TICK_MS`.
const MAX_TICK_MS: f64 = 250.0;
/// `src/versus/controller.ts` `MAX_CATCHUP_ITERATIONS`.
const MAX_CATCHUP_ITERATIONS: i32 = 256;

/// `src/versus/controller.ts` `SideState.side` (also the winner identity).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Left,
    Right,
}

/// `src/versus/controller.ts` `VersusFighter`, minus the display fields: the
/// native app owns names/colors in its own view layer.
pub trait AiFighter {
    fn find_best_move(&mut self, snapshot: &GameSnapshot) -> Option<AiMove>;
    /// `VersusFighter.reset` — per-match state reset invoked on rematch.
    fn reset(&mut self) {}
}

/// `src/versus/controller.ts` `VersusControllerOptions`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct VersusControllerOptions {
    pub step_interval_ms: f64,
    pub gravity_ms: f64,
    pub auto_rematch_ms: f64,
}

/// `src/versus/controller.ts` `VERSUS_DEFAULTS`.
pub const VERSUS_DEFAULTS: VersusControllerOptions = VersusControllerOptions {
    step_interval_ms: 120.0,
    gravity_ms: 500.0,
    auto_rematch_ms: 2500.0,
};

/// `src/versus/controller.ts` `VersusControllerConfig` (partial overrides).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VersusConfig {
    pub garbage_delay: Option<i32>,
    pub garbage_aligned: Option<bool>,
}

/// Fully-resolved engine rules (`src/versus/config.ts` `VERSUS_MATCH_CONFIG`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResolvedVersusConfig {
    pub garbage_delay: i32,
    pub garbage_aligned: bool,
}

/// `src/versus/config.ts` `VERSUS_MATCH_CONFIG`.
pub const VERSUS_MATCH_CONFIG: ResolvedVersusConfig = ResolvedVersusConfig {
    garbage_delay: GARBAGE_DELAY,
    garbage_aligned: true,
};

/// `src/versus/config.ts` `resolveVersusConfig`: omitted fields fall back to the
/// canonical config, never to engine defaults.
pub fn resolve_versus_config(config: &VersusConfig) -> ResolvedVersusConfig {
    ResolvedVersusConfig {
        garbage_delay: config.garbage_delay.unwrap_or(VERSUS_MATCH_CONFIG.garbage_delay),
        garbage_aligned: config
            .garbage_aligned
            .unwrap_or(VERSUS_MATCH_CONFIG.garbage_aligned),
    }
}

/// `src/versus/speed.ts` `speedOptions`.
pub fn speed_options(multiplier: f64) -> VersusControllerOptions {
    VersusControllerOptions {
        step_interval_ms: VERSUS_DEFAULTS.step_interval_ms / multiplier,
        gravity_ms: VERSUS_DEFAULTS.gravity_ms / multiplier,
        auto_rematch_ms: VERSUS_DEFAULTS.auto_rematch_ms,
    }
}

