//! Hoiko engine core — foundation layer (board + bit primitives).
//!
//! Mirrors the verified TypeScript reference in `src/ai/native/` (which itself
//! matches the shipping binary, oracle-verified). Values: `Board.line` uses the
//! native bit orientation (column `c` = bit `9-c`), rows bottom-up.

pub const BOARD_HEIGHT: usize = 32;
pub const BOARD_WIDTH: usize = 10;
pub const FULL_ROW: i32 = 0x3ff;

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

impl Board {
    pub fn init(&mut self) {
        self.line = [0; BOARD_HEIGHT];
        self.stack_height = -1;
        self.locked_bottom = -1;
    }

    pub fn row(&self, y: i32) -> i32 {
        if y < 0 || y as usize >= BOARD_HEIGHT { 0 } else { self.line[y as usize] }
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

    /// `Board.GetColumnHeight`: fills `ch` and returns the garbage height.
    pub fn get_column_height(&self, ch: &mut [i32; BOARD_WIDTH]) -> i32 {
        ch.fill(-1);
        let mut bit = 0i32;
        let mut min = 0i32;
        let mut y = self.stack_height;
        while y >= 0 {
            bit |= self.line[y as usize];
            if bit == FULL_ROW {
                min = y + 1;
                break;
            }
            for x in 0..BOARD_WIDTH {
                if bit & (0x200 >> x) != 0 {
                    ch[x] += 1;
                }
            }
            y -= 1;
        }
        if min > 0 {
            for x in 0..BOARD_WIDTH {
                ch[x] += min;
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
}

/// `Bit.PopCount` — 10-bit popcount.
#[inline]
pub fn popcount(v: i32) -> i32 {
    (v & FULL_ROW).count_ones() as i32
}

/// `Bit.Log2` — column index of a single set bit.
#[inline]
pub fn log2(bit: i32) -> i32 {
    9 - popcount(bit - 1)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
