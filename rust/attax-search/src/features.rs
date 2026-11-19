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
pub const F_WELL_DEPTH: usize = 8;
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

/// C3 garbage-aligned hole geometry (`holeGeometry` in src/ai/bot/holes.ts): vertical
/// runs of covered empty cells, and changes between successive nonempty hole masks.
/// Rows are in engine order (top first); bits identify columns.
pub fn hole_geometry(board: &Board) -> (i32, i32) {
    let mut covered: u16 = 0;
    let mut previous_holes: u16 = 0;
    let mut previous_mask: i32 = -1;
    let mut runs = 0i32;
    let mut shifts = 0i32;
    for row in 0..board.len {
        let holes = covered & !board.rows[row];
        let mut fresh = holes & !previous_holes;
        while fresh != 0 {
            runs += 1;
            fresh &= fresh - 1;
        }
        if holes != 0 {
            if previous_mask != -1 && holes as i32 != previous_mask {
                shifts += 1;
            }
            previous_mask = holes as i32;
        }
        previous_holes = holes;
        covered |= board.rows[row];
    }
    (runs, shifts)
}

/// Best T-spin slot on the surface (see features.ts `bestTSlot`).
#[inline(always)]
fn cell_up(board: &Board, x: i32, y: i32) -> bool {
    if y < 0 { return true; }
    if y >= board.len as i32 { return false; }
    board.rows[board.len - 1 - y as usize] & (1 << x) != 0
}

#[inline(always)]
fn column_bits(board: &Board, x: i32, y: i32, n: i32) -> u32 {
    let mut bits = 0;
    for i in 0..n { if cell_up(board, x, y + i) { bits |= 1 << i; } }
    bits
}

#[derive(Clone, Copy)]
enum DonationShape { Down, Left, Right }

fn donation_cells(shape: DonationShape) -> [(i32, i32); 4] {
    match shape {
        DonationShape::Down => [(-1, 0), (0, 0), (1, 0), (0, -1)],
        DonationShape::Left => [(0, -1), (0, 0), (0, 1), (-1, 0)],
        DonationShape::Right => [(0, -1), (0, 0), (0, 1), (1, 0)],
    }
}

fn find_donation_slot(board: &Board, h: &[i32; COLS as usize]) -> Option<(i32, i32, DonationShape)> {
    for x in 0..(COLS - 2) {
        let (h0, h1, h2) = (h[x as usize], h[x as usize + 1], h[x as usize + 2]);
        if h0 > h1 && h0 + 1 < h2 {
            let y = h0 - 1;
            if column_bits(board, x, y, 3) == 1 && column_bits(board, x + 1, y, 3) == 0 && column_bits(board, x + 2, y, 3) == 5 { return Some((x + 1, h0, DonationShape::Down)); }
        }
        if h2 > h1 && h2 + 1 < h0 {
            let y = h2 - 1;
            if column_bits(board, x, y, 3) == 5 && column_bits(board, x + 1, y, 3) == 0 && column_bits(board, x + 2, y, 3) == 1 { return Some((x + 1, h2, DonationShape::Down)); }
        }
        if h1 >= h0 && h1 + 1 < h2 {
            let y = h1 - 3;
            if column_bits(board, x, y, 5) & 24 == 0 && column_bits(board, x + 1, y, 5) & 30 == 4 && column_bits(board, x + 2, y, 5) == 16 && (cell_up(board, x + 1, y) || cell_up(board, x + 2, y - 1)) { return Some((x + 2, h1 - 2, DonationShape::Left)); }
        }
        if h1 >= h2 && h1 + 1 < h0 {
            let y = h1 - 3;
            if column_bits(board, x, y, 5) == 16 && column_bits(board, x + 1, y, 5) & 30 == 4 && column_bits(board, x + 2, y, 5) & 24 == 0 && (cell_up(board, x + 1, y) || cell_up(board, x, y - 1)) { return Some((x, h1 - 2, DonationShape::Right)); }
        }
    }
    None
}

/// C2 T-slot donation counts indexed by lines cleared; input board is never mutated.
pub fn tslot_donations(board: &Board, depth: i32) -> [i32; 4] {
    let mut counts = [0i32; 4];
    let mut current = *board;
    let len = board.len;
    for _ in 0..depth {
        let h = column_heights(&current);
        let Some((cx, cy, shape)) = find_donation_slot(&current, &h) else { break };
        let mut next = current;
        for (dx, dy) in donation_cells(shape) {
            let y = cy + dy;
            if y >= 0 && y < len as i32 { next.rows[len - 1 - y as usize] |= 1 << (cx + dx); }
        }
        let mut write = len as i32 - 1;
        let mut cleared = 0usize;
        for read in (0..len).rev() {
            let row = next.rows[read];
            if row == FULL_ROW { cleared += 1; continue; }
            next.rows[write as usize] = row;
            write -= 1;
        }
        while write >= 0 { next.rows[write as usize] = 0; write -= 1; }
        counts[cleared] += 1;
        if cleared < 2 { break; }
        current = next;
    }
    counts
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

    fn rows_up(rows: &[u16]) -> Board {
        let mut b = Board::new(40);
        let off = 40 - rows.len();
        b.rows[off..].copy_from_slice(rows);
        b
    }
    fn mirror(rows: &[u16]) -> Vec<u16> {
        rows.iter().map(|&r| (0..10).filter(|&x| r & (1 << x) != 0).fold(0u16, |m, x| m | (1 << (9 - x)))).collect()
    }
    const FULL: u16 = 0x3ff;
    const TSD: [u16; 4] = [0b100, FULL ^ 0b111, FULL ^ 0b10, FULL ^ (1 << 9)];
    const TST: [u16; 6] = [0b100, FULL ^ 0b111, FULL ^ 0b100, FULL ^ 0b110, FULL ^ 0b100, FULL ^ (1 << 9)];
    const STACKED: [u16; 6] = [(1 << 2) | (1 << 8), FULL ^ (0b111 << 6), FULL ^ (1 << 7), FULL ^ 0b111, FULL ^ 0b10, FULL ^ (1 << 9)];

    #[test]
    fn c2_donations_match_ts_fixtures() {
        assert_eq!(tslot_donations(&rows_up(&TSD), 1), [0, 0, 1, 0]);
        assert_eq!(tslot_donations(&rows_up(&mirror(&TSD)), 1), [0, 0, 1, 0]);
        assert_eq!(tslot_donations(&rows_up(&TST), 1), [0, 0, 0, 1]);
        assert_eq!(tslot_donations(&rows_up(&mirror(&TST)), 1), [0, 0, 0, 1]);
        assert_eq!(tslot_donations(&rows_up(&TSD), 0), [0, 0, 0, 0]);
        let stacked = rows_up(&STACKED);
        assert_eq!(tslot_donations(&stacked, 1), [0, 0, 1, 0]);
        assert_eq!(tslot_donations(&stacked, 2), [0, 0, 2, 0]);
        assert_eq!(tslot_donations(&stacked, 3), [0, 0, 2, 0]);
        let mut short = TSD; short[2] = FULL ^ 0b10 ^ (1 << 9);
        assert_eq!(tslot_donations(&rows_up(&short), 3), [0, 1, 0, 0]);
        assert_eq!(tslot_donations(&stacked, 3), [0, 0, 2, 0]); // source remains intact
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
