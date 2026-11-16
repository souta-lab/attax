//! Board features — port of `src/ai/bot/features.ts`. Every feature is an integer; the
//! weighted sum is done in `weights.rs` in `BOARD_FEATURES` order so the floating-point
//! result is bit-identical to the TS `dot`.

use crate::movegen::{Board, COLS, FULL_ROW, filled};

/// Number of board features (same order as `BOARD_FEATURES` in features.ts).
pub const N_FEATURES: usize = 11;

pub const FEATURE_NAMES: [&str; N_FEATURES] = [
    "maxHeight",
    "danger",
    "holes",
    "holeCover",
    "holeRows",
    "bumpiness",
    "bumpinessSq",
    "rowTransitions",
    "wellDepth",
    "extraWells",
    "tSlot",
];

pub const F_MAX_HEIGHT: usize = 0;
pub const F_DANGER: usize = 1;
pub const F_TSLOT: usize = 10;

/// Stack height at which garbage pressure starts to matter.
pub const SAFE_HEIGHT: i32 = 10;

pub type Features = [i32; N_FEATURES];

pub fn column_heights(board: &Board) -> [i32; COLS as usize] {
    let mut h = [0i32; COLS as usize];
    let mut seen: u16 = 0;
    let len = board.len;
    let mut row = 0;
    while row < len && seen != FULL_ROW {
        let fresh = board.rows[row] & !seen;
        if fresh != 0 {
            let mut bits = fresh;
            while bits != 0 {
                let x = bits.trailing_zeros() as usize;
                h[x] = (len - row) as i32;
                bits &= bits - 1;
            }
            seen |= fresh;
        }
        row += 1;
    }
    h
}

/// Feature vector for a board that will additionally be lifted by `lift` garbage rows.
pub fn board_features(board: &Board, lift: i32) -> Features {
    let h = column_heights(board);
    let len = board.len as i32;
    let mut max_height = 0;
    let mut well = 0usize;
    for x in 0..COLS as usize {
        let v = h[x];
        if v > max_height {
            max_height = v;
        }
        if v < h[well] {
            well = x;
        }
    }

    let mut holes = 0i32;
    let mut hole_cover = 0i32;
    let mut hole_rows = 0i32;
    let mut row_transitions = 0i32;
    let mut covered: u16 = 0;
    let mut blocks_above = [0i32; COLS as usize];
    for row in 0..board.len {
        let bits = board.rows[row];
        let hole_bits = covered & !bits;
        if hole_bits != 0 {
            hole_rows += 1;
            let mut hb = hole_bits;
            while hb != 0 {
                let x = hb.trailing_zeros() as usize;
                holes += 1;
                hole_cover += blocks_above[x].min(4);
                hb &= hb - 1;
            }
        }
        if bits != 0 {
            let mut b = bits;
            while b != 0 {
                let x = b.trailing_zeros() as usize;
                blocks_above[x] += 1;
                b &= b - 1;
            }
            let with_walls: u32 = ((bits as u32) << 1) | 1 | (1 << (COLS + 1));
            row_transitions += ((with_walls ^ (with_walls >> 1)) & ((1 << (COLS + 1)) - 1)).count_ones() as i32;
        }
        covered |= bits;
    }

    let mut bumpiness = 0i32;
    let mut bumpiness_sq = 0i32;
    for x in 0..(COLS as usize - 1) {
        if x == well || x + 1 == well {
            continue;
        }
        let d = (h[x] - h[x + 1]).abs();
        bumpiness += d;
        bumpiness_sq += d * d;
    }
    let left = if well > 0 { h[well - 1] } else { len };
    let right = if well < COLS as usize - 1 { h[well + 1] } else { len };
    let well_depth = 4.min(left.min(right) - h[well]);

    let mut extra_wells = 0i32;
    for x in 0..COLS as usize {
        if x == well {
            continue;
        }
        let l = if x > 0 { h[x - 1] } else { len };
        let r = if x < COLS as usize - 1 { h[x + 1] } else { len };
        if l.min(r) - h[x] >= 3 {
            extra_wells += 1;
        }
    }

    let over = 0.max(max_height + lift - SAFE_HEIGHT);
    [
        max_height + lift,
        over * over,
        holes,
        hole_cover,
        hole_rows,
        bumpiness,
        bumpiness_sq,
        row_transitions,
        well_depth,
        extra_wells,
        best_tslot(board, &h),
    ]
}

/// Best T-spin slot on the surface (see features.ts `bestTSlot`).
fn best_tslot(board: &Board, h: &[i32; COLS as usize]) -> i32 {
    let len = board.len as i32;
    let mut best = 0;
    for x in 1..(COLS - 1) {
        let row = len - h[x as usize] - 1;
        if row < 2 || row >= len {
            continue;
        }
        if filled(board, x, row) {
            continue;
        }
        if !filled(board, x - 1, row) || !filled(board, x + 1, row) {
            continue;
        }
        let flat = row - 1;
        if filled(board, x - 1, flat) || filled(board, x, flat) || filled(board, x + 1, flat) {
            continue;
        }
        let left_roof = filled(board, x - 1, flat - 1);
        let right_roof = filled(board, x + 1, flat - 1);
        if left_roof == right_roof {
            continue;
        }
        let open_side = if left_roof { x + 1 } else { x - 1 };
        if h[open_side as usize] > len - flat {
            continue;
        }
        let mut lines = 0;
        if board.rows[row as usize] | (1 << x) == FULL_ROW {
            lines += 1;
        }
        if board.rows[flat as usize] | (7 << (x - 1)) == FULL_ROW {
            lines += 1;
        }
        if lines > best {
            best = lines;
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;

    fn board(rows: &[&str], len: usize) -> Board {
        let mut b = Board::new(len);
        let off = len - rows.len();
        for (i, r) in rows.iter().enumerate() {
            let mut bits = 0u16;
            for (x, c) in r.chars().enumerate() {
                if c == '#' {
                    bits |= 1 << x;
                }
            }
            b.rows[off + i] = bits;
        }
        b
    }

    #[test]
    fn empty_board() {
        let f = board_features(&Board::new(20), 0);
        // well = col 0 (first minimum); its right neighbour is also 0, so depth 0.
        assert_eq!(f, [0; N_FEATURES]);
    }

    #[test]
    fn tsd_slot_detected() {
        // TSD slot at x=1: stem in the bottom row, roof over x=0, open over x=2.
        let b = board(&["#.........", "...#######", "#.########"], 20);
        let f = board_features(&b, 0);
        assert_eq!(f[F_TSLOT], 2);
    }

    #[test]
    fn holes_and_lift() {
        let b = board(&["##########", "#.########"], 20);
        let f = board_features(&b, 9);
        assert_eq!(f[2], 1); // holes
        assert_eq!(f[3], 1); // holeCover
        assert_eq!(f[4], 1); // holeRows
        assert_eq!(f[F_MAX_HEIGHT], 2 + 9);
        assert_eq!(f[F_DANGER], 1);
    }
}
