//! T-spin classification.
//!
//! Faithful port of `src/core/tspin.ts`: the native four-corner count plus the
//! last-SRS rule. Corners follow the piece's facing per rotation
//! (`FRONT_CORNER_PAIRS`), and `lastSrs == 5` (the TST kick) promotes a
//! differing front pair to a full spin.

use crate::board::BitBoard;
use crate::types::{Cell, TspinKind, COLS};

fn filled(board: &BitBoard, x: i32, y: i32) -> bool {
    if x < 0 || x >= COLS as i32 || y < 0 {
        return true;
    }
    if y >= board.len() as i32 {
        return false;
    }
    (board[y as usize] & (1u16 << x)) != 0
}

/// `src/core/tspin.ts` `FRONT_CORNER_PAIRS` (indices into `[BL, BR, TR, TL]`).
const FRONT_CORNER_PAIRS: [(usize, usize); 4] = [(2, 3), (1, 2), (0, 1), (3, 0)];

/// `src/core/tspin.ts` `classifyTspin`.
pub fn classify_tspin(
    board: &BitBoard,
    cells: &[Cell],
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

    let index = ((rotation % 4) + 4) % 4;
    let (front_a, front_b) = FRONT_CORNER_PAIRS[index as usize];
    if occupied[front_a] != occupied[front_b] && last_srs != 5 {
        TspinKind::Mini
    } else {
        TspinKind::Full
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::create_board;
    use crate::types::{cell, TspinKind};

    const PX: i32 = 3;
    const NY: i32 = 6;

    // Bottom-up corners of the T's 3x3 box: [BL, BR, TR, TL].
    const CORNERS: [(i32, i32); 4] = [
        (PX, NY),
        (PX + 2, NY),
        (PX + 2, NY - 2),
        (PX, NY - 2),
    ];

    const T_CELLS: [Cell; 1] = [cell(1, 0)];

    fn board_with_corners(indices: &[usize]) -> BitBoard {
        let mut board = create_board();
        for index in indices {
            let (x, y) = CORNERS[*index];
            board[y as usize] |= 1u16 << x;
        }
        board
    }

    fn classify(indices: &[usize], rotation: i32, last_srs: i32) -> TspinKind {
        classify_tspin(
            &board_with_corners(indices),
            &T_CELLS,
            PX,
            NY,
            rotation,
            last_srs,
        )
    }

    #[test]
    fn requires_a_nonzero_srs_result() {
        assert_eq!(classify(&[0, 2, 3], 0, 0), TspinKind::None);
    }

    #[test]
    fn none_when_fewer_than_three_corners_are_occupied() {
        assert_eq!(classify(&[0, 2], 0, 1), TspinKind::None);
    }

    #[test]
    fn full_when_matching_front_corners_face_up() {
        assert_eq!(classify(&[0, 2, 3], 0, 1), TspinKind::Full);
    }

    #[test]
    fn full_when_matching_front_corners_face_down() {
        assert_eq!(classify(&[0, 1, 2], 2, 1), TspinKind::Full);
    }

    #[test]
    fn full_for_matching_front_corners_on_rot1_and_rot3() {
        assert_eq!(classify(&[0, 1, 2], 1, 1), TspinKind::Full);
        assert_eq!(classify(&[0, 2, 3], 3, 1), TspinKind::Full);
    }

    #[test]
    fn mini_when_front_corners_differ_while_facing_up() {
        assert_eq!(classify(&[0, 1, 2], 0, 1), TspinKind::Mini);
    }

    #[test]
    fn mini_when_front_corners_differ_while_facing_down() {
        assert_eq!(classify(&[0, 2, 3], 2, 1), TspinKind::Mini);
    }

    #[test]
    fn mini_when_front_corners_differ_on_rot1_and_rot3() {
        assert_eq!(classify(&[0, 2, 3], 1, 1), TspinKind::Mini);
        assert_eq!(classify(&[0, 1, 2], 3, 1), TspinKind::Mini);
    }

    #[test]
    fn last_srs_kick_promotes_a_differing_front_pair_to_full_tst() {
        assert_eq!(classify(&[0, 1, 2], 0, 5), TspinKind::Full);
        assert_eq!(classify(&[0, 2, 3], 2, 5), TspinKind::Full);
    }

    #[test]
    fn corners_above_the_field_are_empty_not_walls() {
        // py=30 pushes all four corner probes above the 20-row board, where
        // `filled` returns false (unlike y < 0, which is treated as a wall).
        assert_eq!(
            classify_tspin(&create_board(), &T_CELLS, PX, 30, 0, 1),
            TspinKind::None
        );
    }
}
