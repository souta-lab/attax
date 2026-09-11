//! Native Board — faithful port of `src/ai/native/board.ts`.
//!
//! `line[32]`, bit `9-col` set for column `col`, bottom-up rows. `stack_height`
//! = highest non-empty row (-1 when empty), `locked_bottom` = bottom of the last
//! lock.

// allow: SIZE_OK — one cohesive native Board type mirroring board.ts; splitting
// the inherent impl would fragment a single concept.

use crate::mino::FallMino;
use crate::shapes::{mino_to_kind, shape_for};
use crate::srs::kick_table;

pub const BOARD_HEIGHT: usize = 32;
pub const BOARD_WIDTH: usize = 10;
pub const FULL_ROW: i32 = 0x3ff;

/// JavaScript `>>` semantics: arithmetic shift with the count masked to 5 bits
/// (JS applies `& 31` to the shift count; Rust would panic on an out-of-range
/// count instead).
#[inline]
pub fn js_shr(v: i32, s: i32) -> i32 {
    v >> (s & 31)
}

/// `Bit::PopCount` — 10-bit popcount.
#[inline]
pub fn popcount(v: i32) -> i32 {
    (v & FULL_ROW).count_ones() as i32
}

/// `Bit::Log2` — column index (source orientation) of a single set bit.
#[inline]
pub fn log2(bit: i32) -> i32 {
    9 - popcount(bit - 1)
}

#[derive(Clone, Copy)]
pub struct Board {
    pub line: [i32; BOARD_HEIGHT],
    pub stack_height: i32,
    pub locked_bottom: i32,
}

impl Default for Board {
    fn default() -> Self {
        Self { line: [0; BOARD_HEIGHT], stack_height: -1, locked_bottom: -1 }
    }
}

#[derive(Clone, Copy)]
enum Spin {
    A,
    B,
}

impl Board {
    pub fn init(&mut self) {
        self.line = [0; BOARD_HEIGHT];
        self.stack_height = -1;
        self.locked_bottom = -1;
    }

    /// `Board.rowAt` — out-of-range rows read as 0 (JS typed-array semantics).
    #[inline]
    pub fn row_at(&self, y: i32) -> i32 {
        if y < 0 || y as usize >= BOARD_HEIGHT { 0 } else { self.line[y as usize] }
    }

    /// Alias kept for the existing foundation tests.
    #[inline]
    pub fn row(&self, y: i32) -> i32 {
        self.row_at(y)
    }

    pub fn update_max_height(&mut self) {
        for y in (0..BOARD_HEIGHT).rev() {
            if self.line[y] != 0 {
                self.stack_height = y as i32;
                return;
            }
        }
        self.stack_height = -1;
    }

    fn hit_at(&self, mino: &FallMino, x: i32, y: i32) -> i32 {
        let sh = shape_for(mino.m, mino.r);
        for cell in &sh.cells {
            let col = x + cell.x;
            let row = y - cell.y;
            if col < 0 || col >= BOARD_WIDTH as i32 || row < 0 || row >= BOARD_HEIGHT as i32 {
                continue;
            }
            if (self.line[row as usize] & (1 << (9 - col))) != 0 {
                return 1;
            }
        }
        0
    }

    /// `Board.CollisionBoard`: bounds + the anchor rows.
    pub fn collision_board(&self, mino: &FallMino) -> i32 {
        let sh = shape_for(mino.m, mino.r);
        if mino.x + sh.min_x < 0 {
            return 1;
        }
        if mino.x + sh.max_x >= BOARD_WIDTH as i32 {
            return 1;
        }
        if mino.y - sh.max_y < 0 {
            return 1;
        }
        self.hit_at(mino, mino.x, mino.y)
    }

    /// `Board.CollisionBottom`: one row down (the floor counts as a collision).
    pub fn collision_bottom(&self, mino: &FallMino) -> i32 {
        let sh = shape_for(mino.m, mino.r);
        if mino.y - sh.max_y < 1 {
            return 1;
        }
        self.hit_at(mino, mino.x, mino.y - 1)
    }

    pub fn collision_left(&self, mino: &FallMino) -> i32 {
        let sh = shape_for(mino.m, mino.r);
        if mino.x + sh.min_x < 1 {
            return 1;
        }
        self.hit_at(mino, mino.x - 1, mino.y)
    }

    pub fn collision_right(&self, mino: &FallMino) -> i32 {
        let sh = shape_for(mino.m, mino.r);
        if mino.x + sh.max_x >= BOARD_WIDTH as i32 - 1 {
            return 1;
        }
        self.hit_at(mino, mino.x + 1, mino.y)
    }

    /// `Board.CollisionDistance` — rows the piece can still fall.
    pub fn collision_distance(&self, mino: &FallMino) -> i32 {
        let limit = mino.y.min(self.stack_height + 40) + 4;
        let mut s = 1i32;
        while s <= limit {
            if self.hit_at(mino, mino.x, mino.y - s) != 0 {
                break;
            }
            if mino.y - s - shape_for(mino.m, mino.r).max_y < 0 {
                break;
            }
            s += 1;
        }
        let drop = s - 1;
        if drop > 0 { drop } else { 0 }
    }

    /// `Board.GetSpawnHeight` — checks only local rows y=1 and y=0.
    pub fn get_spawn_height(&self, mino: &FallMino) -> i32 {
        if self.stack_height + 1 <= 19 {
            return 20;
        }
        let sh = shape_for(mino.m, mino.r);
        let m1 = sh.row_mask[1] >> 3;
        let m0 = sh.row_mask[0] >> 3;
        let mut hit = 0;
        if (self.row_at(19) & m1) != 0 {
            hit += 1;
        }
        if (self.row_at(20) & m0) != 0 {
            hit += 1;
        }
        if hit == 0 {
            return 20;
        }
        hit = 0;
        if (self.row_at(20) & m1) != 0 {
            hit += 1;
        }
        if (self.row_at(21) & m0) != 0 {
            hit += 1;
        }
        if hit == 0 { 21 } else { -1 }
    }

    fn srs_spin(&self, mino: &mut FallMino, spins: Spin) -> i32 {
        match spins {
            Spin::A => mino.spin_a(),
            Spin::B => mino.spin_b(),
        }
        if self.collision_board(mino) == 0 {
            return 1;
        }
        let kind = match mino_to_kind(mino.m) {
            Some(k) => k,
            None => {
                match spins {
                    Spin::A => mino.spin_b(),
                    Spin::B => mino.spin_a(),
                }
                return 0;
            }
        };
        let new_r = mino.r;
        let old_r = match spins {
            Spin::A => (new_r + 3) % 4,
            Spin::B => (new_r + 1) % 4,
        };
        let kicks = kick_table(kind.srs_index(), old_r, new_r);
        let x0 = mino.x;
        let y0 = mino.y;
        for i in 0..4 {
            let Some(k) = kicks.get((i + 1) as usize) else { break };
            mino.x = x0 + k.0;
            mino.y = y0 + k.1;
            if self.collision_board(mino) == 0 {
                return i + 2;
            }
        }
        mino.x = x0;
        mino.y = y0;
        match spins {
            Spin::A => mino.spin_b(),
            Spin::B => mino.spin_a(),
        }
        0
    }

    /// `Board.SrsA` — CW rotation with the 4 native kick tests; returns 0..5.
    pub fn srs_a(&self, mino: &mut FallMino) -> i32 {
        self.srs_spin(mino, Spin::A)
    }

    /// `Board.SrsB` — CCW rotation.
    pub fn srs_b(&self, mino: &mut FallMino) -> i32 {
        self.srs_spin(mino, Spin::B)
    }

    /// `Board.LockMino` — returns cleared rows, or -1 on top-out.
    pub fn lock_mino(&mut self, mino: &FallMino) -> i32 {
        let sh = shape_for(mino.m, mino.r);
        if mino.y - sh.max_y > 19 {
            return -1;
        }
        for cell in &sh.cells {
            let row = mino.y - cell.y;
            let col = mino.x + cell.x;
            if row < 0 || row >= BOARD_HEIGHT as i32 || col < 0 || col >= BOARD_WIDTH as i32 {
                continue;
            }
            self.line[row as usize] |= 1 << (9 - col);
        }
        let mut cleared = 0;
        for k in (0..4).rev() {
            let row = mino.y - k;
            if row >= 0 && row < BOARD_HEIGHT as i32 && self.line[row as usize] == FULL_ROW {
                cleared += 1;
            }
        }
        let top = mino.y - sh.min_y;
        if self.stack_height < top {
            self.stack_height = top;
        }
        self.locked_bottom = mino.y - sh.max_y;
        cleared
    }

    pub fn clear_line(&mut self) {
        let mut i = self.locked_bottom;
        let mut end = self.stack_height;
        while i <= end {
            if self.line[i as usize] == FULL_ROW {
                let mut k = i;
                while k < end {
                    self.line[k as usize] = self.line[(k + 1) as usize];
                    k += 1;
                }
                self.line[end as usize] = 0;
                i -= 1;
                end -= 1;
                self.stack_height -= 1;
            }
            i += 1;
        }
    }

    /// `Board.GetColumnHeight` — fills `ch` with -1 first, then accumulates, and
    /// returns the garbage height (the `buildColumnHeight` call site).
    pub fn get_column_height(&self, ch: &mut [i32; BOARD_WIDTH]) -> i32 {
        ch.fill(-1);
        self.get_column_height_zeroed(ch)
    }

    /// `Board.GetColumnHeight` with a caller-supplied starting array — the raw
    /// native method. The offset driver passes a zero-filled `Int32Array`, so
    /// the result is absolute column heights (not garbage-relative).
    pub fn get_column_height_zeroed(&self, ch: &mut [i32; BOARD_WIDTH]) -> i32 {
        let mut bit = 0i32;
        let mut min = 0i32;
        let mut y = self.stack_height;
        while y >= 0 {
            bit |= self.line[y as usize];
            if bit == FULL_ROW {
                min = y + 1;
                break;
            }
            for x in 0..BOARD_WIDTH as i32 {
                if bit & (0x200 >> x) != 0 {
                    ch[x as usize] += 1;
                }
            }
            y -= 1;
        }
        if min > 0 {
            for ch in ch.iter_mut() {
                *ch += min;
            }
        }
        min - 1
    }

    /// `Board.PopCount`.
    pub fn pop_count(&self) -> i32 {
        let mut total = 0;
        let mut y = self.stack_height;
        while y >= 0 {
            total += popcount(self.line[y as usize]);
            y -= 1;
        }
        total
    }

    pub fn is_even_pop(&self) -> bool {
        self.pop_count() & 1 == 0
    }

    /// `Board.IsTspin` — 0 none, 1 T-spin, 2 mini.
    pub fn is_tspin(&self, mino: &FallMino) -> i32 {
        if mino.m != 4 {
            return 0;
        }
        if mino.last_srs == 0 {
            return 0;
        }
        let x = mino.x;
        let y = mino.y;
        let l0 = if y - 2 >= 0 { self.row_at(y) } else { 0 };
        let l1 = if y - 2 >= 0 { self.row_at(y - 2) } else { 0 };
        let mut corners = [0i32; 4];
        let mut fill = 0;
        if x < 0 || (l0 & js_shr(512, x)) != 0 {
            corners[0] = 1;
            fill += 1;
        }
        if x >= 8 || (l0 & js_shr(512, x + 2)) != 0 {
            corners[1] = 1;
            fill += 1;
        }
        if x >= 8 || y - 2 < 0 || (l1 & js_shr(512, x + 2)) != 0 {
            corners[2] = 1;
            fill += 1;
        }
        if x < 0 || y - 2 < 0 || (l1 & js_shr(512, x)) != 0 {
            corners[3] = 1;
            fill += 1;
        }
        if fill < 3 {
            return 0;
        }
        let nr = if mino.r > 2 { 0 } else { mino.r + 1 };
        if corners[mino.r as usize] != corners[nr as usize] && mino.last_srs != 5 {
            return 2;
        }
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mino::FallMino;
    use crate::shapes::MINO_I;

    #[test]
    fn popcount_and_log2() {
        assert_eq!(popcount(0x3ff), 10);
        assert_eq!(popcount(0), 0);
        assert_eq!(log2(512), 0);
        assert_eq!(log2(1), 9);
    }

    #[test]
    fn column_height_flat() {
        let mut b = Board::default();
        b.line[0] = 0x3ff;
        b.line[1] = 0x3ff;
        b.update_max_height();
        let mut ch = [-1i32; 10];
        let garbage = b.get_column_height(&mut ch);
        assert_eq!(garbage, 1);
        assert_eq!(ch[0], 1);
    }

    #[test]
    fn column_height_golden() {
        let mut b = Board::default();
        b.line[0] = 1023;
        b.line[1] = 0b11;
        b.stack_height = 1;
        let mut ch = [-1i32; 10];
        let g = b.get_column_height(&mut ch);
        assert_eq!(g, 0);
        assert_eq!(ch, [0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
    }

    #[test]
    fn hard_drop_distance_golden() {
        let b = Board::default();
        let mut f = FallMino::default();
        f.m = MINO_I;
        f.y = 20;
        assert_eq!(b.collision_distance(&f), 19);
    }
}
