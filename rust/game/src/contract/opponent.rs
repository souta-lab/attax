//! Versus opponent-aware `EvaluateAI` inputs (`PPT2AI.ObserveOpponent`): the
//! four statics the shipping binary feeds to the search each turn.
//!
//! Faithful port of `src/ai/hoiko-opponent.ts`. Shared by the native app so the
//! Hoiko engine receives the same values the exe-verified adapter produced.

use crate::types::{BoardView, COLS, ROWS};

/// `src/ai/hoiko-opponent.ts` `boardToNativeRows`: bottom-up rows, column `c`
/// maps to bit `(cols - 1 - c)`.
pub fn board_to_native_rows(board: &BoardView) -> Vec<i32> {
    let mut rows = Vec::with_capacity(ROWS);
    for y in 0..ROWS {
        let src = &board.grid[ROWS - 1 - y];
        let mut bits = 0i32;
        for x in 0..COLS {
            if src[x] != 0 {
                bits |= 1 << (COLS - 1 - x);
            }
        }
        rows.push(bits);
    }
    rows
}

/// `src/ai/hoiko-opponent.ts` `nativeStackHeight`: highest non-empty native
/// row, -1 when empty.
pub fn native_stack_height(rows: &[i32]) -> i32 {
    let mut y = rows.len() as i32 - 1;
    while y >= 0 {
        if rows[y as usize] != 0 {
            return y;
        }
        y -= 1;
    }
    -1
}

/// `src/ai/hoiko-opponent.ts` `nativePopCount`: set bits over the live rows.
pub fn native_pop_count(rows: &[i32], stack_height: i32) -> i32 {
    let mut total = 0;
    let mut y = 0;
    while y <= stack_height {
        let mut bits = rows.get(y as usize).copied().unwrap_or(0);
        while bits != 0 {
            bits &= bits - 1;
            total += 1;
        }
        y += 1;
    }
    total
}

/// `src/ai/hoiko-opponent.ts` `opponentIsPCBoard`: a stack below 10 rows whose
/// popcount is even.
pub fn opponent_is_pc_board(rows: &[i32]) -> bool {
    let stack_height = native_stack_height(rows);
    if stack_height + 1 >= 10 {
        return false;
    }
    native_pop_count(rows, stack_height) % 2 == 0
}

/// `src/ai/hoiko-opponent.ts` `opponentIsPowerfulBoard`.
pub fn opponent_is_powerful_board(rows: &[i32], combo: i32, garbage: i32) -> bool {
    if combo >= 5 {
        return true;
    }
    if garbage >= 6 {
        return true;
    }
    let stack_height = native_stack_height(rows);
    let pop = native_pop_count(rows, stack_height);
    let mut same = 0;
    let mut bara = 0;
    let mut well = 0;
    let mut prev = rows.first().copied().unwrap_or(0);
    for y in 1..=stack_height {
        let row = rows.get(y as usize).copied().unwrap_or(0);
        if (row | prev) != prev {
            bara += 1;
            well += if same >= 4 { same } else { 0 };
            same = 0;
        } else if prev == row {
            same += 1;
        }
        prev = row;
    }
    well += if same >= 4 { same } else { 0 };
    if pop % 2 == 0 {
        if stack_height + 1 >= 10 && bara >= 4 && well <= 6 {
            return false;
        }
    } else if well <= 6 {
        return false;
    }
    true
}
