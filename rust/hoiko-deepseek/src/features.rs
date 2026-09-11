use crate::board::{Board, COLS, ROWS};

#[derive(Clone, Copy, Debug, Default)]
pub struct FeatureVector {
    pub landing_height: f64,
    pub eroded_cells: f64,
    pub row_transitions: f64,
    pub col_transitions: f64,
    pub holes: f64,
    pub wells: f64,
    pub hole_depth: f64,
    pub rows_with_holes: f64,
    pub bumpiness: f64,
    pub max_height: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct FireContext {
    pub lines_cleared: u32,
    pub tspin: bool,
    pub tspin_lines: u32,
    pub b2b_active: bool,
    pub combo: i32,
    pub perfect_clear: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct FireFeatures {
    pub is_tetris: bool,
    pub is_tspin: bool,
    pub is_tspin_single: bool,
    pub is_tspin_double: bool,
    pub is_tspin_triple: bool,
    pub b2b_bonus: bool,
    pub combo_count: i32,
    pub is_perfect_clear: bool,
}

pub fn extract_features(after: &Board, landing_height: f64, eroded_cells: f64) -> FeatureVector {
    let mut heights = [0f64; COLS];
    for x in 0..COLS {
        for y in (0..ROWS).rev() {
            if (after[y] & (1u16 << x)) != 0 {
                heights[x] = (y + 1) as f64;
                break;
            }
        }
    }

    let mut holes = 0f64;
    let mut hole_depth = 0f64;
    let mut hole_rows_mask: u32 = 0;
    let mut col_transitions = 0f64;

    for x in 0..COLS {
        let top = heights[x];
        let mut prev = 1i32;
        for y in (0..ROWS).rev() {
            let row = after[y];
            let filled = (row & (1u16 << x)) != 0;
            if !filled && (y as f64) < top {
                holes += 1.0;
                hole_depth += top - y as f64;
                hole_rows_mask |= 1u32 << y;
            }
            let cur = if filled { 1 } else { 0 };
            if cur != prev {
                col_transitions += 1.0;
            }
            prev = cur;
        }
        if prev == 0 {
            col_transitions += 1.0;
        }
    }

    let rows_with_holes = (hole_rows_mask.count_ones()) as f64;

    let mut row_transitions = 0f64;
    for y in 0..ROWS {
        let row = after[y] as u32;
        let d = (row | 0b100_0000_0000) ^ (1 | (row << 1));
        row_transitions += popcount11(d) as f64;
    }

    let mut wells = 0f64;
    for x in 0..COLS {
        let h = heights[x];
        let left = if x == 0 {
            f64::INFINITY
        } else {
            heights[x - 1]
        };
        let right = if x == COLS - 1 {
            f64::INFINITY
        } else {
            heights[x + 1]
        };
        let wall = left.min(right);
        if wall > h {
            wells += wall - h;
        }
    }

    let mut bumpiness = 0f64;
    for i in 1..COLS {
        bumpiness += (heights[i] - heights[i - 1]).abs();
    }
    let mut max_height = 0f64;
    for h in heights {
        if h > max_height {
            max_height = h;
        }
    }

    FeatureVector {
        landing_height,
        eroded_cells,
        row_transitions,
        col_transitions,
        holes,
        wells,
        hole_depth,
        rows_with_holes,
        bumpiness,
        max_height,
    }
}

pub fn extract_fire_features(ctx: FireContext) -> FireFeatures {
    let lines = ctx.lines_cleared;
    let tspin = ctx.tspin && ctx.tspin_lines > 0;
    FireFeatures {
        is_tetris: lines == 4,
        is_tspin: tspin,
        is_tspin_single: tspin && ctx.tspin_lines == 1,
        is_tspin_double: tspin && ctx.tspin_lines == 2,
        is_tspin_triple: tspin && ctx.tspin_lines == 3,
        b2b_bonus: ctx.b2b_active && (lines == 4 || tspin),
        combo_count: ctx.combo.max(0),
        is_perfect_clear: ctx.perfect_clear,
    }
}

fn popcount11(v: u32) -> u32 {
    let mut n = v & 0x7ff;
    n -= (n >> 1) & 0x555;
    n = (n & 0x333) + ((n >> 2) & 0x333);
    ((((n + (n >> 4)) & 0xf0f).wrapping_mul(0x101)) >> 8) & 0x7
}
