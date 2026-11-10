//! Lock, clear, T-spin detection and garbage-row application.
//!
//! Faithful port of the `lockAndSpawn` / `applyClear` / `detectTspin` /
//! `spawnGarbageRows` region of `src/core/engine.ts`.

use super::{action_for_clear, Game, SpawnState};
use crate::garbage::{attack_for_clear, cancel_pending, gen_garbage_holes, tick_pending, ClearInfo};
use crate::pieces::{bottom_cells_of, cells_for, piece_cell_value};
use crate::types::{
    LockTransition, TspinKind, COLS, EMPTY_CELL, GARBAGE_CELL, ROWS,
};

const LINE_SCORES: [i32; 5] = [0, 100, 300, 500, 800];

impl Game {
    /// `src/core/engine.ts` `lockAndSpawn`.
    pub(super) fn lock_and_spawn(&mut self) {
        let Some(a) = self.active else {
            return;
        };
        let cells = cells_for(a.kind, a.rotation);
        if cells.iter().all(|c| a.y + c.y < 0) {
            self.game_over = true;
            return;
        }
        let value = piece_cell_value(a.kind);
        for c in &cells {
            let x = a.x + c.x;
            let y = a.y + c.y;
            if y >= 0 && y < ROWS as i32 && x >= 0 && x < COLS as i32 {
                self.grid[y as usize][x as usize] = value;
            }
        }
        let tspin = self.detect_tspin(&a);
        let mut kept: Vec<[u8; COLS]> = Vec::with_capacity(ROWS);
        let mut cleared = 0;
        for row in self.grid.iter() {
            if row.iter().all(|&v| v != EMPTY_CELL) {
                cleared += 1;
            } else {
                kept.push(*row);
            }
        }
        while kept.len() < ROWS {
            kept.insert(0, [EMPTY_CELL; COLS]);
        }
        for (y, row) in kept.iter().enumerate() {
            self.grid[y] = *row;
        }
        let perfect_clear = cleared > 0
            && self
                .grid
                .iter()
                .all(|row| row.iter().all(|&v| v == EMPTY_CELL));
        self.apply_clear(cleared, tspin, perfect_clear);
        self.can_hold = true;
        let due = if self.wait_garbage {
            0
        } else {
            tick_pending(&mut self.pending)
        };
        self.wait_garbage = false;
        self.lock_id += 1;
        self.last_lock_transition = Some(LockTransition {
            board_after_lock_clear: super::grid_to_bottom_up_rows(&self.grid),
            lines_cleared: cleared,
            garbage_rows_applied: due,
            action: self.last_action,
            native_combo: self.native_combo,
            native_btb: self.native_btb,
            raw_attack: self.last_raw_attack,
            sent_attack: self.last_sent_attack,
            lock_id: self.lock_id,
        });
        if !self.game_over {
            if due > 0 {
                self.spawn_garbage_rows(due);
            }
            self.spawn();
        }
    }

    /// `src/core/engine.ts` `applyClear`.
    pub(super) fn apply_clear(&mut self, cleared: i32, tspin: TspinKind, perfect_clear: bool) {
        self.last_action = action_for_clear(cleared, tspin, perfect_clear);
        if cleared == 0 {
            self.native_combo = if self.native_combo > 0 {
                -self.native_combo
            } else {
                0
            };
            self.combo = -1;
            self.last_attack = 0;
            self.last_blocked = 0;
            self.last_raw_attack = 0;
            self.last_sent_attack = 0;
            return;
        }
        if self.native_combo < 0 {
            self.native_combo = 0;
        }
        self.native_combo += 1;
        self.lines += cleared;
        let base = LINE_SCORES
            .get(cleared as usize)
            .copied()
            .unwrap_or(cleared * 200);
        let tspin_lines = if tspin == TspinKind::Full { cleared } else { 0 };
        let difficult = crate::garbage::is_difficult_clear(cleared, tspin);
        let b2b_before = self.b2b;
        let mut gained = base * self.level;
        if difficult && b2b_before {
            gained = (gained as f64 * 1.5).floor() as i32;
        }
        self.combo += 1;
        if self.combo > 0 {
            gained += 50 * self.combo * self.level;
        }
        self.score += gained;
        let attack = attack_for_clear(&ClearInfo {
            lines: cleared,
            tspin_lines,
            combo: self.combo,
            b2b_active: b2b_before,
            perfect_clear,
            tspin_kind: Some(tspin),
        });
        let blocked = cancel_pending(&mut self.pending, attack);
        self.last_raw_attack = attack;
        self.last_blocked = blocked;
        self.last_attack = attack - blocked;
        self.last_sent_attack = attack - blocked;
        self.outbox += attack - blocked;
        if perfect_clear {
            self.native_btb = if cleared >= 4 { self.native_btb + 1 } else { 0 };
        } else if difficult {
            self.native_btb += 1;
        } else {
            self.native_btb = 0;
        }
        self.b2b = self.native_btb > 0;
        self.level = self.lines / 10 + 1;
    }

    /// `src/core/engine.ts` `detectTspin` (board after the piece is written,
    /// before rows are cleared; `bottomCellsOf` re-anchors the piece).
    fn detect_tspin(&self, a: &SpawnState) -> TspinKind {
        if a.kind != crate::types::PieceKind::T || a.last_srs == 0 {
            return TspinKind::None;
        }
        let mut board = crate::board::create_board();
        for y in 0..ROWS {
            let row = &self.grid[ROWS - 1 - y];
            for x in 0..COLS {
                if row[x] != EMPTY_CELL {
                    board[y] |= 1u16 << x;
                }
            }
        }
        let cells = bottom_cells_of(a.kind, a.rotation);
        let mut max_y = 0;
        for cell in &cells {
            if cell.y > max_y {
                max_y = cell.y;
            }
        }
        let py = ROWS as i32 - 1 - a.y - max_y;
        crate::tspin::classify_tspin(&board, &cells, a.x, py, a.rotation, a.last_srs)
    }

    /// `src/core/engine.ts` `spawnGarbageRows`: discard the top row (top-out if
    /// occupied), push a garbage row at the bottom, then lift the active piece.
    fn spawn_garbage_rows(&mut self, count: i32) {
        let (holes, prev_hole) = if self.config.garbage_aligned {
            gen_garbage_holes(1, self.rng.as_mut(), self.prev_garbage_hole)
        } else {
            gen_garbage_holes(count, self.rng.as_mut(), self.prev_garbage_hole)
        };
        self.prev_garbage_hole = prev_hole;
        for i in 0..count {
            let removed = self.grid[0];
            if removed.iter().any(|&v| v != EMPTY_CELL) {
                self.game_over = true;
                return;
            }
            let hole = holes
                .get(if self.config.garbage_aligned { 0 } else { i as usize })
                .copied()
                .unwrap_or(0);
            let mut row = [GARBAGE_CELL; COLS];
            if (0..COLS as i32).contains(&hole) {
                row[hole as usize] = EMPTY_CELL;
            }
            for y in 0..ROWS - 1 {
                self.grid[y] = self.grid[y + 1];
            }
            self.grid[ROWS - 1] = row;
        }
        if let Some(mut active) = self.active {
            active.y -= count;
            self.active = Some(active);
        }
        if self.grid[0].iter().any(|&v| v != EMPTY_CELL) {
            self.game_over = true;
        }
    }
}
