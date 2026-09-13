//! Bitboard helpers: 10 cols x 20 rows, index 0 = bottom row, low 10 bits used.
//!
//! Faithful port of `src/core/board.ts` with the fixed engine height
//! ([`ROWS`]); the module is used by T-spin classification and by the
//! lock-transition/AI witness paths. `lockAndClear`/`computeLockAfterstate`
//! mutate/copy in the same order as TS, including the `topOut` flags raised for
//! cells outside the field.

use crate::types::{Cell, COLS, FULL_ROW, ROWS};

/// Bottom-up bitboard rows (`Uint16Array` in `src/core/board.ts`).
pub type BitBoard = [u16; ROWS];

pub fn create_board() -> BitBoard {
    [0; ROWS]
}

/// `src/core/board.ts` `cellAt`.
pub fn cell_at(board: &BitBoard, x: i32, y: i32) -> bool {
    if x < 0 || x >= COLS as i32 || y < 0 || y >= ROWS as i32 {
        return false;
    }
    (board[y as usize] & (1u16 << x)) != 0
}

/// `src/core/board.ts` `collides`.
pub fn collides(board: &BitBoard, cells: &[Cell], px: i32, py: i32) -> bool {
    for c in cells {
        let x = px + c.x;
        let y = py + c.y;
        if x < 0 || x >= COLS as i32 {
            return true;
        }
        if y < 0 {
            return true;
        }
        if y < ROWS as i32 && cell_at(board, x, y) {
            return true;
        }
    }
    false
}

/// `src/core/board.ts` `dropY`.
pub fn drop_y(board: &BitBoard, cells: &[Cell], px: i32, start_y: i32) -> i32 {
    let mut y = start_y;
    let mut guard = ROWS as i32 + 8;
    while !collides(board, cells, px, y - 1) {
        y -= 1;
        guard -= 1;
        if guard <= 0 {
            break;
        }
    }
    y
}

/// `src/core/board.ts` `LockResult`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LockResult {
    pub lines_cleared: i32,
    pub piece_cells_in_cleared_rows: i32,
    pub top_out: bool,
}

/// `src/core/board.ts` `LockAfterstate`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LockAfterstate {
    pub after: BitBoard,
    pub y: i32,
    pub lines_cleared: i32,
    pub piece_cells_in_cleared_rows: i32,
    pub top_out: bool,
}

fn lock_and_clear_in_place(
    board: &mut BitBoard,
    cells: &[Cell],
    px: i32,
    py: i32,
) -> LockResult {
    let mut top_out = false;
    for c in cells {
        let x = px + c.x;
        let y = py + c.y;
        if x < 0 || x >= COLS as i32 {
            continue;
        }
        if y >= ROWS as i32 {
            top_out = true;
            continue;
        }
        if y < 0 {
            top_out = true;
            continue;
        }
        board[y as usize] |= 1u16 << x;
    }

    let mut locked_ys: Vec<i32> = Vec::new();
    for c in cells {
        let y = py + c.y;
        if y >= 0 && y < ROWS as i32 {
            locked_ys.push(y);
        }
    }

    let mut cleared = 0;
    let mut piece_cells_in_cleared = 0;
    let mut kept: Vec<u16> = Vec::with_capacity(ROWS);
    for y in 0..ROWS {
        if board[y] == FULL_ROW {
            cleared += 1;
            piece_cells_in_cleared += locked_ys.iter().filter(|&&v| v == y as i32).count() as i32;
        } else {
            kept.push(board[y]);
        }
    }
    while kept.len() < ROWS {
        kept.push(0);
    }
    for (y, value) in kept.iter().enumerate() {
        board[y] = *value;
    }

    LockResult {
        lines_cleared: cleared,
        piece_cells_in_cleared_rows: piece_cells_in_cleared,
        top_out,
    }
}

/// `src/core/board.ts` `lockAndClear`: lock cells into the board and clear full
/// rows in place.
pub fn lock_and_clear(board: &mut BitBoard, cells: &[Cell], px: i32, py: i32) -> LockResult {
    lock_and_clear_in_place(board, cells, px, py)
}

/// `src/core/board.ts` `computeLockAfterstate`: immutable lock+clear view used
/// by the AI placement witnesses.
pub fn compute_lock_afterstate(
    board: &BitBoard,
    cells: &[Cell],
    px: i32,
    py: i32,
) -> LockAfterstate {
    let mut after = *board;
    let info = lock_and_clear_in_place(&mut after, cells, px, py);
    LockAfterstate {
        after,
        y: py,
        lines_cleared: info.lines_cleared,
        piece_cells_in_cleared_rows: info.piece_cells_in_cleared_rows,
        top_out: info.top_out,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{cell, FULL_ROW};

    fn cells_i_horizontal() -> [Cell; 4] {
        [cell(0, 0), cell(1, 0), cell(2, 0), cell(3, 0)]
    }

    #[test]
    fn collides_on_walls_floor_and_stack() {
        let mut board = create_board();
        board[0] = 0b0000000010; // col 1 occupied on the bottom row
        assert!(!collides(&board, &cells_i_horizontal(), 2, 1));
        assert!(collides(&board, &cells_i_horizontal(), 1, 0));
        assert!(collides(&board, &cells_i_horizontal(), -1, 5));
        assert!(collides(&board, &cells_i_horizontal(), 7, 5));
        assert!(collides(&board, &cells_i_horizontal(), 3, -1));
    }

    #[test]
    fn drop_y_stops_above_stack() {
        let mut board = create_board();
        board[0] = 0b0011111111; // cols 0-7 filled on the bottom row
        let cells = [cell(0, 0), cell(1, 0)];
        assert_eq!(drop_y(&board, &cells, 8, 10), 0);
        assert_eq!(drop_y(&board, &cells, 0, 10), 1);
    }

    #[test]
    fn lock_and_clear_clears_full_row_and_reports_piece_cells() {
        let mut board = create_board();
        board[0] = 0b0011111111; // cols 0-7 filled
        let cells = cells_i_horizontal(); // I at cols 6..9
        let result = lock_and_clear(&mut board, &cells, 6, 0);
        assert_eq!(result.lines_cleared, 1);
        assert_eq!(result.piece_cells_in_cleared_rows, 4);
        assert!(!result.top_out);
        assert_eq!(board[0], 0); // row cleared, everything shifted down
    }

    #[test]
    fn lock_and_clear_tops_out_for_cells_outside_the_field() {
        let mut board = create_board();
        let cells = [cell(0, 0)];
        let visible = (ROWS as i32) - 1;
        assert!(!lock_and_clear(&mut board, &cells, 0, visible).top_out);
        let result = lock_and_clear(&mut board, &cells, 0, visible + 1);
        assert!(result.top_out);
        assert_eq!(result.lines_cleared, 0);
    }

    #[test]
    fn compute_lock_afterstate_leaves_the_source_untouched() {
        let mut board = create_board();
        board[0] = 0x03f;
        let before = board;
        let after = compute_lock_afterstate(&board, &cells_i_horizontal(), 6, 0);
        assert_eq!(board, before);
        assert_eq!(after.y, 0);
        assert_eq!(after.lines_cleared, 1);
        let mut expected = before;
        let expected_info = lock_and_clear(&mut expected, &cells_i_horizontal(), 6, 0);
        assert_eq!(after.after, expected);
        assert_eq!(after.lines_cleared, expected_info.lines_cleared);
        assert_eq!(
            after.piece_cells_in_cleared_rows,
            expected_info.piece_cells_in_cleared_rows
        );
        assert_eq!(after.top_out, expected_info.top_out);
    }

    #[test]
    fn full_row_constant_matches_ts() {
        assert_eq!(FULL_ROW, 0x3ff);
    }
}
