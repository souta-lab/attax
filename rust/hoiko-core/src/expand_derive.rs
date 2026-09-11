//! `ExpandAI.ExpandDeriveNode` + TryDerive helpers and GetAboveCell — faithful
//! port of `src/ai/native/expand-derive.ts` (SPEC_ExpandAI §4.3-§4.10).
//!
//! Derived placements are soft-dropped tucks (T-spins, spins into gaps); they are
//! only emitted when the derive guard detects an overhang/hole (or the piece is T).

use crate::baby::{add_baby, override_same_node, Baby, Buckets};
use crate::board::{js_shr, Board};
use crate::shapes::shape_for;

#[derive(Clone, Copy)]
enum Dir {
    Left,
    Right,
}

fn step(target: &mut Baby, board: &Board, dir: Dir) -> i32 {
    match dir {
        Dir::Left => target.commands.move_left(&mut target.falling_mino, board),
        Dir::Right => target.commands.move_right(&mut target.falling_mino, board),
    }
}

pub fn get_above_cell(column_height: &[i32; 10], mino: &crate::mino::FallMino) -> i32 {
    let cells = shape_for(mino.m, mino.r).cells();
    for c in cells {
        let col = mino.x + c.x;
        let row = mino.y - c.y;
        let ch = if (0..10).contains(&col) { column_height[col as usize] } else { -1 };
        if ch > row {
            return 1;
        }
    }
    0
}

fn derive_guard(root: &Baby, column_height: &[i32; 10], board: &Board) -> bool {
    if root.falling_mino.m == 4 {
        return true;
    }
    let mut min_h = column_height[0];
    for x in 1..10 {
        min_h = min_h.min(column_height[x]);
    }
    let mut acc = board.row_at(board.stack_height.max(0));
    let mut y = board.stack_height - 1;
    while y > min_h {
        let row = board.row_at(y);
        if ((row ^ 0x3ff) & acc) != 0 {
            return true;
        }
        acc |= row;
        y -= 1;
    }
    false
}

fn try_derive_rotate_b(
    target: &mut Baby,
    board: &Board,
    ch: &[i32; 10],
    buckets: &mut [Vec<usize>],
    babies: &mut [Baby],
) -> i32 {
    if target.commands.rotate_b(&mut target.falling_mino, board) == 0 {
        return 0;
    }
    if get_above_cell(ch, &target.falling_mino) == 0 {
        let f = target.falling_mino;
        let special = f.m == 4
            && f.last_srs == 2
            && f.r == 3
            && ((js_shr(512, f.x + 1) | board.row_at(f.y - 2)) == 1023);
        if !special {
            return 0;
        }
    }
    if override_same_node(buckets, babies, target) != 1 { 1 } else { 0 }
}

fn try_derive_rotate_a(
    target: &mut Baby,
    board: &Board,
    ch: &[i32; 10],
    buckets: &mut [Vec<usize>],
    babies: &mut [Baby],
) -> i32 {
    if target.commands.rotate_a(&mut target.falling_mino, board) == 0 {
        return 0;
    }
    if get_above_cell(ch, &target.falling_mino) == 0 {
        let f = target.falling_mino;
        let special = f.m == 4
            && f.last_srs == 2
            && f.r == 1
            && ((js_shr(512, f.x + 1) | board.row_at(f.y - 2)) == 1023);
        if !special {
            return 0;
        }
    }
    if override_same_node(buckets, babies, target) != 1 { 1 } else { 0 }
}

fn try_derive_move(
    target: &mut Baby,
    board: &Board,
    ch: &[i32; 10],
    buckets: &mut [Vec<usize>],
    babies: &mut [Baby],
    dir: Dir,
) -> i32 {
    if step(target, board, dir) == 0 {
        return 0;
    }
    if get_above_cell(ch, &target.falling_mino) == 0 {
        return 0;
    }
    let mut n = 0;
    while step(target, board, dir) != 0 {
        if get_above_cell(ch, &target.falling_mino) != 0 {
            n += 1;
            if n >= 10 {
                break;
            }
            continue;
        }
        return 0;
    }
    if override_same_node(buckets, babies, target) != 1 { 1 } else { 0 }
}

fn try_derive_fin_b(
    target: &mut Baby,
    board: &Board,
    buckets: &mut [Vec<usize>],
    babies: &mut [Baby],
) -> i32 {
    let f = target.falling_mino;
    if (board.row_at(f.y - 2) & js_shr(512, f.x)) > 0 {
        if target.commands.move_right(&mut target.falling_mino, board) == 0 {
            return 0;
        }
        target.commands.move_delay -= 30;
    }
    if target.commands.rotate_b(&mut target.falling_mino, board) == 0 {
        return 0;
    }
    let f = target.falling_mino;
    if f.last_srs == 5 && ((js_shr(512, f.x + 1) | board.row_at(f.y - 2)) == 1023) {
        return if override_same_node(buckets, babies, target) != 1 { 1 } else { 0 };
    }
    0
}

fn try_derive_fin_a(
    target: &mut Baby,
    board: &Board,
    buckets: &mut [Vec<usize>],
    babies: &mut [Baby],
) -> i32 {
    let f = target.falling_mino;
    if (js_shr(512, f.x + 2) & board.row_at(f.y - 2)) > 0 {
        if target.commands.move_left(&mut target.falling_mino, board) == 0 {
            return 0;
        }
        target.commands.move_delay -= 30;
    }
    if target.commands.rotate_a(&mut target.falling_mino, board) == 0 {
        return 0;
    }
    let f = target.falling_mino;
    if f.last_srs == 5 && ((js_shr(512, f.x + 1) | board.row_at(f.y - 2)) == 1023) {
        return if override_same_node(buckets, babies, target) != 1 { 1 } else { 0 };
    }
    0
}

/// `ExpandDeriveNode` (IL 14706); appends derived babies, returns new count.
pub fn expand_derive_node(
    babies: &mut Vec<Baby>,
    board: &Board,
    column_height: &[i32; 10],
    buckets: &mut Buckets,
) -> i32 {
    let Some(root) = babies.first().cloned() else { return babies.len() as i32 };
    if !derive_guard(&root, column_height, board) {
        return babies.len() as i32;
    }
    let mut num = 0usize;
    let mut num2 = babies.len();
    while num < babies.len() {
        let end = babies.len();
        for i in num..end {
            let mut local = babies[i].clone();
            local.commands.soft_drop(&mut local.falling_mino, board);

            let mut cand = local.clone();
            if try_derive_move(&mut cand, board, column_height, buckets, babies, Dir::Left) == 1 {
                let idx = babies.len();
                add_baby(buckets, &cand, idx);
                let pushed = cand.clone();
                babies.push(pushed);
                if cand.falling_mino.m == 4 && cand.falling_mino.r == 2 {
                    let mut fin = cand.clone();
                    if try_derive_fin_b(&mut fin, board, buckets, babies) == 1 {
                        let idx = babies.len();
                        add_baby(buckets, &fin, idx);
                        babies.push(fin);
                    }
                }
            }
            cand = local.clone();
            if try_derive_move(&mut cand, board, column_height, buckets, babies, Dir::Right) == 1 {
                let idx = babies.len();
                add_baby(buckets, &cand, idx);
                let pushed = cand.clone();
                babies.push(pushed);
                if cand.falling_mino.m == 4 && cand.falling_mino.r == 2 {
                    let mut fin = cand.clone();
                    if try_derive_fin_a(&mut fin, board, buckets, babies) == 1 {
                        let idx = babies.len();
                        add_baby(buckets, &fin, idx);
                        babies.push(fin);
                    }
                }
            }
            cand = local.clone();
            if try_derive_rotate_b(&mut cand, board, column_height, buckets, babies) == 1 {
                let idx = babies.len();
                add_baby(buckets, &cand, idx);
                babies.push(cand);
            }
            cand = local.clone();
            if try_derive_rotate_a(&mut cand, board, column_height, buckets, babies) == 1 {
                let idx = babies.len();
                add_baby(buckets, &cand, idx);
                babies.push(cand);
            }
        }
        if num2 == babies.len() {
            break;
        }
        num = num2;
        num2 = babies.len();
    }
    babies.len() as i32
}
