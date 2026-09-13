//! Real core engine: 7-bag + SRS-lite + hold + guideline scoring.
//!
//! Faithful port of `src/core/engine.ts` (the app's `CorePort` implementation):
//! same spawn/lock/clear order, same attack/combo/b2b bookkeeping, same lock
//! transition witness, and the same garbage flow (`waitGarbage`, per-lock
//! pending tick, aligned/per-row holes). The only difference is that the random
//! source is injected ([`crate::rng::Rng`]) instead of defaulting to
//! `Math.random`, so the core stays deterministic and WASM-friendly.

mod actions;
mod lock;
mod spawn;

#[cfg(test)]
mod tests;

use crate::garbage::{GARBAGE_DELAY, PendingChunk};
use crate::pieces::cells_for;
use crate::rng::Rng;
use crate::types::{
    ActivePieceView, BoardView, GameSnapshot, Grid, LockAction, LockTransition, PieceKind,
};
use std::collections::VecDeque;

use spawn::empty_grid;
pub(crate) use spawn::grid_to_bottom_up_rows;

/// `src/core/engine.ts` `EngineOptions` with the random source supplied by the
/// caller. `garbage_delay` mirrors `garbageDelay` (default `GARBAGE_DELAY`) and
/// `garbage_aligned` mirrors `garbageAligned` (default off = per-row holes).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EngineConfig {
    pub garbage_delay: i32,
    pub garbage_aligned: bool,
}

impl Default for EngineConfig {
    fn default() -> EngineConfig {
        EngineConfig {
            garbage_delay: GARBAGE_DELAY,
            garbage_aligned: false,
        }
    }
}

/// `src/core/engine.ts` `SpawnState`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct SpawnState {
    pub kind: PieceKind,
    pub rotation: i32,
    pub x: i32,
    pub y: i32,
    pub last_srs: i32,
}

/// `src/core/engine.ts` `createEngine` state.
pub struct Game {
    rng: Box<dyn Rng>,
    config: EngineConfig,
    pub(super) grid: Grid,
    pub(super) queue: VecDeque<PieceKind>,
    pub(super) active: Option<SpawnState>,
    hold: Option<PieceKind>,
    can_hold: bool,
    score: i32,
    lines: i32,
    level: i32,
    combo: i32,
    b2b: bool,
    native_combo: i32,
    native_btb: i32,
    lock_id: i32,
    last_action: LockAction,
    last_raw_attack: i32,
    last_sent_attack: i32,
    game_over: bool,
    pending: Vec<PendingChunk>,
    outbox: i32,
    last_attack: i32,
    last_blocked: i32,
    prev_garbage_hole: i32,
    last_lock_transition: Option<LockTransition>,
    wait_garbage: bool,
}

impl Game {
    pub fn new(rng: Box<dyn Rng>) -> Game {
        Game::with_config(rng, EngineConfig::default())
    }

    pub fn with_config(rng: Box<dyn Rng>, config: EngineConfig) -> Game {
        let mut game = Game {
            rng,
            config,
            grid: empty_grid(),
            queue: VecDeque::new(),
            active: None,
            hold: None,
            can_hold: true,
            score: 0,
            lines: 0,
            level: 1,
            combo: -1,
            b2b: false,
            native_combo: 0,
            native_btb: 0,
            lock_id: 0,
            last_action: LockAction::None,
            last_raw_attack: 0,
            last_sent_attack: 0,
            game_over: false,
            pending: Vec::new(),
            outbox: 0,
            last_attack: 0,
            last_blocked: 0,
            prev_garbage_hole: 4,
            last_lock_transition: None,
            wait_garbage: false,
        };
        let queue = game.four_bags();
        game.queue = queue;
        game.spawn();
        game
    }

    fn four_bags(&mut self) -> VecDeque<PieceKind> {
        let mut queue = VecDeque::with_capacity(28);
        for _ in 0..4 {
            for kind in spawn::shuffled_bag(self.rng.as_mut()) {
                queue.push_back(kind);
            }
        }
        queue
    }

    /// `src/core/engine.ts` `reset`.
    pub fn reset(&mut self) {
        self.grid = empty_grid();
        let queue = self.four_bags();
        self.queue = queue;
        self.hold = None;
        self.can_hold = true;
        self.score = 0;
        self.lines = 0;
        self.level = 1;
        self.combo = -1;
        self.b2b = false;
        self.native_combo = 0;
        self.native_btb = 0;
        self.lock_id = 0;
        self.last_action = LockAction::None;
        self.last_raw_attack = 0;
        self.last_sent_attack = 0;
        self.game_over = false;
        self.active = None;
        self.pending.clear();
        self.wait_garbage = false;
        self.last_lock_transition = None;
        self.outbox = 0;
        self.last_attack = 0;
        self.last_blocked = 0;
        self.prev_garbage_hole = 4;
        self.spawn();
        self.can_hold = true;
    }

    /// `src/core/engine.ts` `getSnapshot` (without the opponent telemetry, which
    /// the versus controller adds).
    pub fn snapshot(&self) -> GameSnapshot {
        let active = self.active.map(|a| ActivePieceView {
            kind: a.kind,
            rotation: a.rotation,
            cells: cells_for(a.kind, a.rotation),
            pos_x: a.x,
            pos_y: a.y,
        });
        let ghost_y = self.active.map(|a| self.ghost_y_for(&a));
        GameSnapshot {
            board: BoardView { grid: self.grid },
            active,
            ghost_y,
            hold: self.hold,
            can_hold: self.can_hold,
            next: self.queue.iter().take(20).copied().collect(),
            score: self.score,
            lines: self.lines,
            level: self.level,
            game_over: self.game_over,
            combo: self.combo,
            b2b: self.b2b,
            native_combo: self.native_combo,
            native_btb: self.native_btb,
            lock_id: self.lock_id,
            last_action: self.last_action,
            last_raw_attack: self.last_raw_attack,
            pending_garbage: crate::garbage::pending_total(&self.pending),
            last_attack: self.last_attack,
            last_blocked: self.last_blocked,
            opponent: None,
        }
    }

    /// `src/core/engine.ts` `getLastLockTransition`.
    pub fn last_lock_transition(&self) -> Option<&LockTransition> {
        self.last_lock_transition.as_ref()
    }

    pub fn game_over(&self) -> bool {
        self.game_over
    }

    pub fn config(&self) -> EngineConfig {
        self.config
    }
}

/// `src/core/engine.ts` `actionForClear`.
pub(super) fn action_for_clear(cleared: i32, tspin: crate::types::TspinKind, perfect_clear: bool) -> LockAction {
    if cleared == 0 {
        return LockAction::None;
    }
    if perfect_clear {
        return LockAction::Pc;
    }
    if cleared == 4 {
        return LockAction::Quad;
    }
    if tspin == crate::types::TspinKind::Mini {
        return LockAction::Tsm;
    }
    if tspin == crate::types::TspinKind::Full {
        if cleared == 1 {
            return LockAction::Tss;
        }
        if cleared == 2 {
            return LockAction::Tsd;
        }
        return LockAction::Tst;
    }
    if cleared == 1 {
        return LockAction::Single;
    }
    if cleared == 2 {
        return LockAction::Double;
    }
    LockAction::Triple
}
