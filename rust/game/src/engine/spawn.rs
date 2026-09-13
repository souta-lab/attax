//! Spawn, collision, ghost-drop and reachability helpers.
//!
//! Faithful port of the `collides` / `spawn` / `spawnY` / `ghostYFrom` /
//! `reachable` region of `src/core/engine.ts`.

use super::{Game, SpawnState};
use crate::pieces::cells_for;
use crate::rng::Rng;
use crate::srs::{as_rotation, kick_table};
use crate::types::{Grid, PieceKind, COLS, EMPTY_CELL, ROWS};
use std::collections::{HashSet, VecDeque};

pub(super) fn empty_grid() -> Grid {
    [[EMPTY_CELL; COLS]; ROWS]
}

/// `src/core/engine.ts` `shuffledBag` (Fisher-Yates, same `rand()` order).
pub(super) fn shuffled_bag(rng: &mut dyn Rng) -> [PieceKind; 7] {
    let mut bag = PieceKind::ALL;
    let mut i = bag.len();
    while i > 1 {
        i -= 1;
        let j = ((rng.next_f64() * (i as f64 + 1.0)).floor() as usize).min(i);
        bag.swap(i, j);
    }
    bag
}

/// `src/core/engine.ts` `spawnY`.
pub(super) fn spawn_y(kind: PieceKind) -> i32 {
    let cells = cells_for(kind, 0);
    let mut min_y = 0;
    for c in &cells {
        if c.y < min_y {
            min_y = c.y;
        }
    }
    -min_y
}

/// `src/core/engine.ts` `gridToBottomUpRows` (transition witness / AI input).
pub(crate) fn grid_to_bottom_up_rows(grid: &Grid) -> Vec<u16> {
    let mut rows = Vec::with_capacity(ROWS);
    for y in (0..ROWS).rev() {
        let mut bits = 0u16;
        for x in 0..COLS {
            if grid[y][x] != EMPTY_CELL {
                bits |= 1u16 << x;
            }
        }
        rows.push(bits);
    }
    rows
}

impl Game {
    /// `src/core/engine.ts` `collides`.
    pub(super) fn collides(&self, kind: PieceKind, rotation: i32, px: i32, py: i32) -> bool {
        for c in cells_for(kind, rotation) {
            let x = px + c.x;
            let y = py + c.y;
            if x < 0 || x >= COLS as i32 {
                return true;
            }
            if y >= ROWS as i32 {
                return true;
            }
            if y >= 0 && self.grid[y as usize][x as usize] != EMPTY_CELL {
                return true;
            }
        }
        false
    }

    /// `src/core/engine.ts` `spawn`.
    pub(super) fn spawn(&mut self) {
        let Some(kind) = self.queue.pop_front() else {
            return;
        };
        if self.queue.len() < 21 {
            let bag = shuffled_bag(self.rng.as_mut());
            self.queue.extend(bag);
        }
        let state = SpawnState {
            kind,
            rotation: 0,
            x: 3,
            y: spawn_y(kind),
            last_srs: 0,
        };
        if self.collides(state.kind, state.rotation, state.x, state.y) {
            self.game_over = true;
            self.active = Some(state);
            return;
        }
        self.active = Some(state);
    }

    /// `src/core/engine.ts` `ghostYFrom`.
    pub(super) fn ghost_y_from(
        &self,
        kind: PieceKind,
        rotation: i32,
        x: i32,
        start_y: i32,
    ) -> i32 {
        let mut y = start_y;
        let mut guard = ROWS as i32 + 8;
        while !self.collides(kind, rotation, x, y + 1) {
            y += 1;
            guard -= 1;
            if guard <= 0 {
                break;
            }
        }
        y
    }

    /// `src/core/engine.ts` `ghostYFor`.
    pub(super) fn ghost_y_for(&self, active: &SpawnState) -> i32 {
        self.ghost_y_from(active.kind, active.rotation, active.x, active.y)
    }

    /// `src/core/engine.ts` `reachable`: BFS over moves and SRS kicks from the
    /// current placement to `(to_rot, to_x)` at any row.
    pub(super) fn reachable(
        &self,
        kind: PieceKind,
        from_rot: i32,
        from_x: i32,
        from_y: i32,
        to_rot: i32,
        to_x: i32,
    ) -> bool {
        let start_rot = as_rotation(from_rot);
        let end_rot = as_rotation(to_rot);
        let mut seen: HashSet<(i32, i32, i32)> = HashSet::new();
        let mut queue: VecDeque<(i32, i32, i32)> = VecDeque::new();
        queue.push_back((start_rot, from_x, from_y));
        seen.insert((start_rot, from_x, from_y));
        let mut guard = 4000;
        while let Some((cur_rot, cur_x, cur_y)) = queue.pop_front() {
            guard -= 1;
            if guard <= 0 {
                break;
            }
            if cur_rot == end_rot && cur_x == to_x {
                return true;
            }
            let rot_cw = (cur_rot + 1) % 4;
            let rot_ccw = (cur_rot + 3) % 4;
            let mut candidates: Vec<(i32, i32, i32)> = vec![
                (cur_rot, cur_x - 1, cur_y),
                (cur_rot, cur_x + 1, cur_y),
                (cur_rot, cur_x, cur_y + 1),
            ];
            for to in [rot_cw, rot_ccw] {
                let kicks = kick_table(kind, as_rotation(cur_rot), as_rotation(to));
                for kick in kicks {
                    candidates.push((to, cur_x + kick.dx, cur_y - kick.dy));
                }
            }
            for candidate in candidates {
                if seen.contains(&candidate) {
                    continue;
                }
                if candidate.2 > ROWS as i32 + 4 {
                    continue;
                }
                if self.collides(kind, candidate.0, candidate.1, candidate.2) {
                    continue;
                }
                seen.insert(candidate);
                queue.push_back(candidate);
            }
        }
        false
    }
}
