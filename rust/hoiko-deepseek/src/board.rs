pub const ROWS: usize = 20;
pub const COLS: usize = 10;
pub const FULL_ROW: u16 = 0x3ff;

pub type Board = [u16; ROWS];

use crate::pieces::Cell;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LockAfterstate {
    pub after: Board,
    pub y: i32,
    pub lines_cleared: u32,
    pub piece_cells_in_cleared_rows: u32,
    pub top_out: bool,
}

pub fn collides(board: &Board, cells: &[Cell; 4], px: i32, py: i32) -> bool {
    for c in cells {
        let x = px + c.x;
        let y = py + c.y;
        if x < 0 || x >= COLS as i32 {
            return true;
        }
        if y < 0 {
            return true;
        }
        if y < ROWS as i32 && (board[y as usize] & (1u16 << x)) != 0 {
            return true;
        }
    }
    false
}

pub fn drop_y(board: &Board, cells: &[Cell; 4], px: i32, start_y: i32) -> i32 {
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

pub fn count_filled_rows(board: &Board) -> u32 {
    board.iter().filter(|&&row| row != 0).count() as u32
}

pub fn is_empty(board: &Board) -> bool {
    board.iter().all(|&row| row == 0)
}

pub fn compute_lock_afterstate(
    board: &Board,
    cells: &[Cell; 4],
    px: i32,
    py: i32,
) -> LockAfterstate {
    let mut after = *board;
    let mut top_out = false;
    for c in cells {
        let x = px + c.x;
        let y = py + c.y;
        if x < 0 || x >= COLS as i32 {
            continue;
        }
        if y >= ROWS as i32 || y < 0 {
            top_out = true;
            continue;
        }
        after[y as usize] |= 1u16 << x;
    }

    let mut locked_ys: [i32; 4] = [0; 4];
    for (i, c) in cells.iter().enumerate() {
        let y = py + c.y;
        locked_ys[i] = if (0..ROWS as i32).contains(&y) { y } else { -1 };
    }

    let mut cleared = 0u32;
    let mut piece_cells = 0u32;
    let mut kept: [u16; ROWS] = [0; ROWS];
    let mut kept_len = 0usize;
    for y in 0..ROWS {
        let row = after[y];
        if row == FULL_ROW {
            cleared += 1;
            piece_cells += locked_ys.iter().filter(|&&v| v == y as i32).count() as u32;
        } else {
            kept[kept_len] = row;
            kept_len += 1;
        }
    }
    for y in 0..ROWS {
        after[y] = kept[y];
    }

    LockAfterstate {
        after,
        y: py,
        lines_cleared: cleared,
        piece_cells_in_cleared_rows: piece_cells,
        top_out,
    }
}
