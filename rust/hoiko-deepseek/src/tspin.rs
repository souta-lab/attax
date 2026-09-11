//! Port of `src/core/tspin.ts` (native four-corner + last-SRS classification).
//!
//! The v2 decision path itself classifies spins geometrically via
//! `beam::is_tspin_shape`; `classify_tspin` is what the engine uses once a
//! `placeAt` step is replayed (`lastSrs != 0`), so it is exposed here for API
//! parity and unit testing.

use crate::board::{Board, COLS, ROWS};
use crate::pieces::{Cell, PieceKind, bottom_cells};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TspinKind {
    None,
    Mini,
    Full,
}

fn filled(board: &Board, x: i32, y: i32) -> bool {
    if x < 0 || x >= COLS as i32 || y < 0 {
        return true;
    }
    if y >= board.len() as i32 {
        return false;
    }
    (board[y as usize] & (1u16 << x)) != 0
}

/// Front-corner index pairs `[BL, BR, TR, TL]` per rotation facing.
fn front_corner_pair(rotation: i32) -> (usize, usize) {
    match (((rotation % 4) + 4) % 4) as usize {
        0 => (2, 3),
        1 => (1, 2),
        2 => (0, 1),
        _ => (3, 0),
    }
}

/// Classify a locked T using the native four-corner and last-SRS rule.
pub fn classify_tspin(
    board: &Board,
    cells: &[Cell; 4],
    px: i32,
    py: i32,
    rotation: i32,
    last_srs: i32,
) -> TspinKind {
    if cells.is_empty() || last_srs == 0 {
        return TspinKind::None;
    }
    let mut max_y = 0;
    for cell in cells {
        if cell.y > max_y {
            max_y = cell.y;
        }
    }
    let native_py = py + max_y;
    let corners = [
        (px, native_py),
        (px + 2, native_py),
        (px + 2, native_py - 2),
        (px, native_py - 2),
    ];
    let occupied = [
        filled(board, corners[0].0, corners[0].1),
        filled(board, corners[1].0, corners[1].1),
        filled(board, corners[2].0, corners[2].1),
        filled(board, corners[3].0, corners[3].1),
    ];
    let count = occupied.iter().filter(|&&o| o).count();
    if count < 3 {
        return TspinKind::None;
    }
    let (front_a, front_b) = front_corner_pair(rotation);
    if occupied[front_a] != occupied[front_b] && last_srs != 5 {
        TspinKind::Mini
    } else {
        TspinKind::Full
    }
}

/// Port of `isV2Tspin`: mark the piece into a board copy, then classify with
/// `lastSrs = 1`.
pub fn is_v2_tspin(board: &Board, kind: PieceKind, rotation: i32, x: i32, y: i32) -> bool {
    if kind != PieceKind::T {
        return false;
    }
    let cells = bottom_cells(kind, rotation);
    let mut pre = *board;
    for c in &cells {
        let cx = x + c.x;
        let cy = y + c.y;
        if cx >= 0 && cx < COLS as i32 && cy >= 0 && cy < ROWS as i32 {
            pre[cy as usize] |= 1u16 << cx;
        }
    }
    classify_tspin(&pre, &cells, x, y, rotation, 1) != TspinKind::None
}

#[cfg(test)]
mod tests {
    use super::{TspinKind, classify_tspin, is_v2_tspin};
    use crate::board::{Board, ROWS};
    use crate::pieces::{PieceKind, bottom_cells};

    fn tsd_board() -> Board {
        let mut board: Board = [0; ROWS];
        board[0] = 0x3ff ^ (1 << 4);
        board[1] = 0x3ff ^ (1 << 3) ^ (1 << 4) ^ (1 << 5);
        board
    }

    #[test]
    fn flags_the_tsd_notch_and_rejects_non_spins() {
        let board = tsd_board();
        assert!(is_v2_tspin(&board, PieceKind::T, 2, 3, 0));
        assert!(!is_v2_tspin(&[0u16; ROWS], PieceKind::T, 0, 3, 0));
        assert!(!is_v2_tspin(&board, PieceKind::I, 2, 3, 0));
    }

    #[test]
    fn last_srs_zero_is_never_a_spin() {
        let board = tsd_board();
        let cells = bottom_cells(PieceKind::T, 2);
        assert_eq!(classify_tspin(&board, &cells, 3, 0, 2, 0), TspinKind::None);
        // `is_v2_tspin` pre-marks the piece, completing the four-corner count.
        assert!(is_v2_tspin(&board, PieceKind::T, 2, 3, 0));
    }
}
