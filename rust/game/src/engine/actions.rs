//! `CorePort` action surface: movement, rotation, drops, hold and garbage flow.
//!
//! Faithful port of the method bodies in `src/core/engine.ts` (`moveLeft`
//! through `setGarbageWait`).

use super::{Game, SpawnState};
use crate::garbage::push_incoming;
use crate::pieces::cells_for;
use crate::srs::{as_rotation, kick_table};
use crate::types::{COLS, EMPTY_CELL, ROWS};

impl Game {
    /// `src/core/engine.ts` `moveLeft`.
    pub fn move_left(&mut self) {
        if self.active.is_none() || self.game_over {
            return;
        }
        let a = self.active.unwrap();
        if !self.collides(a.kind, a.rotation, a.x - 1, a.y) {
            let mut next = a;
            next.x -= 1;
            next.last_srs = 0;
            self.active = Some(next);
        }
    }

    /// `src/core/engine.ts` `moveRight`.
    pub fn move_right(&mut self) {
        if self.active.is_none() || self.game_over {
            return;
        }
        let a = self.active.unwrap();
        if !self.collides(a.kind, a.rotation, a.x + 1, a.y) {
            let mut next = a;
            next.x += 1;
            next.last_srs = 0;
            self.active = Some(next);
        }
    }

    /// `src/core/engine.ts` `softDrop`.
    pub fn soft_drop(&mut self) {
        if self.active.is_none() || self.game_over {
            return;
        }
        let a = self.active.unwrap();
        if !self.collides(a.kind, a.rotation, a.x, a.y + 1) {
            let mut next = a;
            next.y += 1;
            next.last_srs = 0;
            self.active = Some(next);
            self.score += 1;
        } else {
            self.lock_and_spawn();
        }
    }

    /// `src/core/engine.ts` `rotateCW`.
    pub fn rotate_cw(&mut self) {
        self.try_rotate(1);
    }

    /// `src/core/engine.ts` `rotateCCW`.
    pub fn rotate_ccw(&mut self) {
        self.try_rotate(-1);
    }

    fn try_rotate(&mut self, dir: i32) {
        if self.active.is_none() || self.game_over {
            return;
        }
        let a = self.active.unwrap();
        let from = as_rotation(a.rotation);
        let to = as_rotation(a.rotation + if dir == 1 { 1 } else { 3 });
        let kicks = kick_table(a.kind, from, to);
        for (i, kick) in kicks.iter().enumerate() {
            let nx = a.x + kick.dx;
            let ny = a.y - kick.dy;
            if !self.collides(a.kind, to, nx, ny) {
                let mut next = a;
                next.rotation = to;
                next.x = nx;
                next.y = ny;
                next.last_srs = if i == 0 { 1 } else { i as i32 + 1 };
                self.active = Some(next);
                return;
            }
        }
    }

    /// `src/core/engine.ts` `hardDrop`.
    pub fn hard_drop(&mut self) {
        if self.active.is_none() || self.game_over {
            return;
        }
        let a = self.active.unwrap();
        let landing_y = self.ghost_y_for(&a);
        let fallen = landing_y - a.y;
        if fallen > 0 {
            self.score += 2 * fallen;
        }
        let mut next = a;
        next.y = landing_y;
        self.active = Some(next);
        self.lock_and_spawn();
    }

    /// `src/core/engine.ts` `hardDropAt`.
    pub fn hard_drop_at(&mut self, rotation: i32, x: i32) -> bool {
        if self.active.is_none() || self.game_over {
            return false;
        }
        let a = self.active.unwrap();
        let rot = as_rotation(rotation);
        let cells = cells_for(a.kind, rot);
        if cells
            .iter()
            .any(|c| x + c.x < 0 || x + c.x >= COLS as i32)
        {
            return false;
        }
        if !self.reachable(a.kind, a.rotation, a.x, a.y, rot, x) {
            return false;
        }
        let y = self.ghost_y_from(a.kind, rot, x, a.y);
        let fallen = y - a.y;
        let mut next = a;
        next.rotation = rot;
        next.x = x;
        next.y = y;
        next.last_srs = if rot == a.rotation { a.last_srs } else { 1 };
        self.active = Some(next);
        if fallen > 0 {
            self.score += 2 * fallen;
        }
        self.lock_and_spawn();
        true
    }

    /// `src/core/engine.ts` `placeMinoAt`.
    pub fn place_mino_at(&mut self, rotation: i32, x: i32, top_row: i32, last_srs: i32) -> bool {
        if self.active.is_none() || self.game_over {
            return false;
        }
        let kind = self.active.unwrap().kind;
        let rot = as_rotation(rotation);
        let cells = cells_for(kind, rot);
        for c in &cells {
            let cx = x + c.x;
            let cy = top_row + c.y;
            if cx < 0 || cx >= COLS as i32 || cy >= ROWS as i32 {
                return false;
            }
            if cy >= 0 && self.grid[cy as usize][cx as usize] != EMPTY_CELL {
                return false;
            }
        }
        let mut next = self.active.unwrap();
        next.rotation = rot;
        next.x = x;
        next.y = top_row;
        next.last_srs = last_srs;
        self.active = Some(next);
        self.lock_and_spawn();
        true
    }

    /// `src/core/engine.ts` `hold`.
    pub fn hold(&mut self) {
        if self.active.is_none() || self.game_over || !self.can_hold {
            return;
        }
        let current = self.active.unwrap().kind;
        match self.hold {
            None => {
                self.hold = Some(current);
                self.can_hold = false;
                self.spawn();
                self.can_hold = false;
            }
            Some(swapped) => {
                self.hold = Some(current);
                self.can_hold = false;
                let state = SpawnState {
                    kind: swapped,
                    rotation: 0,
                    x: 3,
                    y: 0,
                    last_srs: 0,
                };
                if self.collides(state.kind, state.rotation, state.x, state.y) {
                    self.game_over = true;
                    self.active = Some(state);
                    return;
                }
                self.active = Some(state);
            }
        }
    }

    /// `src/core/engine.ts` `gravityTick`.
    pub fn gravity_tick(&mut self) -> bool {
        if self.active.is_none() || self.game_over {
            return false;
        }
        let a = self.active.unwrap();
        if !self.collides(a.kind, a.rotation, a.x, a.y + 1) {
            let mut next = a;
            next.y += 1;
            self.active = Some(next);
            return false;
        }
        self.lock_and_spawn();
        true
    }

    /// `src/core/engine.ts` `drainOutbox`.
    pub fn drain_outbox(&mut self) -> i32 {
        let n = self.outbox;
        self.outbox = 0;
        n
    }

    /// `src/core/engine.ts` `receiveGarbage`.
    pub fn receive_garbage(&mut self, rows: i32) {
        if self.game_over || rows <= 0 {
            return;
        }
        push_incoming(&mut self.pending, rows, self.config.garbage_delay);
    }

    /// `src/core/engine.ts` `setGarbageWait`.
    pub fn set_garbage_wait(&mut self, wait: bool) {
        self.wait_garbage = wait;
    }

}
