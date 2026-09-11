//! `ExpandAI.ExpandNode` / `ExpandBaseNode` / `RegistChildNode` — faithful port
//! of `src/ai/native/expand.ts` (SPEC_ExpandAI §4.1-§4.2, §4.13).
//!
//! Expansion is selected by board state: `!IsSafe ? ExpandBaseNode :
//! ExpandTemplateNode`, then ExpandDeriveNode and RegistChildNode; a hold-swap
//! pass follows when the current piece != hold.

use crate::baby::{
    add_baby, clear_baby_buckets, copy_game, make_root_baby, new_baby_buckets, override_same_node,
    Baby, Buckets, ExpandedChild,
};
use crate::board::Board;
use crate::expand_derive::expand_derive_node;
use crate::expand_template::expand_template_node;
use crate::gamepack::GamePack;

pub const MAX_CHILDREN: usize = 100;
const BASE_PRUNE_THRESHOLD: i32 = 34;
const PRUNE_MARKER: i32 = 1_000_000;
const PRUNE_KEEP_BELOW: i32 = 10_000;
const CHILD_BUCKETS: usize = 64;

#[derive(Clone, Copy)]
enum Cmd {
    Left,
    Right,
    RotB,
    RotA,
}

fn apply(cand: &mut Baby, board: &Board, cmd: Cmd) -> i32 {
    match cmd {
        Cmd::Left => cand.commands.move_left(&mut cand.falling_mino, board),
        Cmd::Right => cand.commands.move_right(&mut cand.falling_mino, board),
        Cmd::RotB => cand.commands.rotate_b(&mut cand.falling_mino, board),
        Cmd::RotA => cand.commands.rotate_a(&mut cand.falling_mino, board),
    }
}

fn get_filtered_count(buckets: &mut [Vec<usize>], babies: &mut [Baby], child_count: i32) -> i32 {
    let mut kept = child_count;
    for bucket in buckets.iter_mut() {
        let c = bucket.len() as i32;
        if c > 1 {
            kept += 1 - c;
            let mut best = bucket[0];
            let mut best_delay = babies[best].commands.move_delay;
            for &bi in bucket.iter() {
                let d = babies[bi].commands.move_delay;
                if d < best_delay {
                    best = bi;
                    best_delay = d;
                }
            }
            for &bi in bucket.iter() {
                if bi != best {
                    babies[bi].commands.move_delay = PRUNE_MARKER;
                }
            }
        }
    }
    kept
}

/// `ExpandBaseNode` (IL 14595): BFS over L,R,B,A from the spawn state.
pub fn expand_base_node(babies: &mut Vec<Baby>, board: &Board, buckets: &mut Buckets) -> i32 {
    let mut num = 0usize;
    let mut num2 = 1usize;
    loop {
        if num < num2 {
            let end = num2;
            for i in num..end {
                let src = babies[i].clone();
                for cmd in [Cmd::Left, Cmd::Right, Cmd::RotB, Cmd::RotA] {
                    let mut cand = src.clone();
                    let ok = apply(&mut cand, board, cmd);
                    if ok == 1 && override_same_node(buckets, babies, &cand) == 0 {
                        let idx = babies.len();
                        add_baby(buckets, &cand, idx);
                        babies.push(cand);
                    }
                }
            }
        }
        if num2 == babies.len() {
            break;
        }
        num = num2;
        num2 = babies.len();
    }
    let count = babies.len() as i32;
    if count > BASE_PRUNE_THRESHOLD {
        let kept = get_filtered_count(buckets, babies, count).max(0) as usize;
        let filtered: Vec<Baby> =
            babies.iter().filter(|b| b.commands.move_delay < PRUNE_KEEP_BELOW).cloned().collect();
        babies.clear();
        babies.extend(filtered.into_iter().take(kept));
        clear_baby_buckets(buckets);
        for i in 0..kept {
            if let Some(b) = babies.get(i).cloned() {
                add_baby(buckets, &b, i);
            }
        }
    }
    babies.len() as i32
}

fn delete_same_node(
    child_buckets: &mut [Vec<usize>],
    out: &mut [ExpandedChild],
    cand: &ExpandedChild,
) -> i32 {
    let lb = cand.game.board.locked_bottom;
    let r = cand.game.locked_mino.r;
    let idx = lb * 2 + (r & 1);
    if idx < 0 || idx >= CHILD_BUCKETS as i32 {
        return 0;
    }
    let bucket = &child_buckets[idx as usize];
    for &si in bucket {
        let matches = {
            let s = &out[si];
            let sb = &s.game.board;
            let cb = &cand.game.board;
            sb.row_at(lb) == cb.row_at(lb)
                && sb.row_at(lb + 1) == cb.row_at(lb + 1)
                && sb.row_at(lb + 2) == cb.row_at(lb + 2)
                && sb.row_at(lb + 3) == cb.row_at(lb + 3)
                && s.game.act == cand.game.act
        };
        if !matches {
            continue;
        }
        if out[si].game.commands.move_delay > cand.game.commands.move_delay {
            copy_game(&mut out[si].game, &cand.game);
            out[si].placed_x = cand.placed_x;
            out[si].placed_r = cand.placed_r;
            out[si].placed_m = cand.placed_m;
            out[si].hold_used = cand.hold_used;
            out[si].act = cand.act;
        }
        return 1;
    }
    0
}

fn regist_child_node(
    babies: &[Baby],
    parent: &GamePack,
    hold_used: bool,
) -> Vec<ExpandedChild> {
    let mut child_buckets: Vec<Vec<usize>> = (0..CHILD_BUCKETS).map(|_| Vec::new()).collect();
    let mut out: Vec<ExpandedChild> = Vec::new();
    for baby in babies {
        let mut g = GamePack::default();
        g.board.line = parent.board.line;
        g.board.stack_height = parent.board.stack_height;
        g.board.locked_bottom = parent.board.locked_bottom;
        g.combo = parent.combo;
        g.btb = parent.btb;
        g.falling_mino = baby.falling_mino;
        g.hold = baby.hold;
        g.next_it.copy_from(&baby.next_it);
        g.commands.s.clear();
        g.commands.s.extend_from_slice(&baby.commands.s);
        g.commands.move_delay = baby.commands.move_delay;
        if g.lock_down() == 0 {
            continue;
        }
        let cand = ExpandedChild {
            hold_used,
            placed_x: g.locked_mino.x,
            placed_r: g.locked_mino.r,
            placed_m: g.locked_mino.m,
            act: g.act,
            game: g,
        };
        if delete_same_node(&mut child_buckets, &mut out, &cand) == 1 {
            continue;
        }
        let idx = cand.game.board.locked_bottom * 2 + (cand.game.locked_mino.r & 1);
        if idx >= 0 && idx < CHILD_BUCKETS as i32 {
            child_buckets[idx as usize].push(out.len());
        }
        out.push(cand);
    }
    out
}

/// `ExpandNode` (IL 14207): non-hold + hold passes, capped at MAX_CHILDREN.
pub fn expand_node(parent: &GamePack, allow_hold: bool) -> Vec<ExpandedChild> {
    let mut ch = [-1i32; 10];
    parent.board.get_column_height(&mut ch);
    let safe = parent.is_safe();

    let root = make_root_baby(parent);
    let mut babies: Vec<Baby> = vec![root.clone()];
    let mut buckets = new_baby_buckets();
    add_baby(&mut buckets, &root, 0);
    if safe {
        expand_template_node(&mut babies, &root);
    } else {
        expand_base_node(&mut babies, &parent.board, &mut buckets);
    }
    expand_derive_node(&mut babies, &parent.board, &ch, &mut buckets);
    let mut out = regist_child_node(&babies, parent, false);

    if allow_hold && parent.falling_mino.m != parent.hold.m {
        let mut hold_baby = make_root_baby(parent);
        hold_baby.commands.swap_hold(
            &mut hold_baby.falling_mino,
            &mut hold_baby.hold,
            &parent.board,
            &mut hold_baby.next_it,
        );
        let mut hb: Vec<Baby> = vec![hold_baby.clone()];
        let mut hbuckets = new_baby_buckets();
        add_baby(&mut hbuckets, &hold_baby, 0);
        if safe {
            expand_template_node(&mut hb, &hold_baby);
        } else {
            expand_base_node(&mut hb, &parent.board, &mut hbuckets);
        }
        expand_derive_node(&mut hb, &parent.board, &ch, &mut hbuckets);
        for c in regist_child_node(&hb, parent, true) {
            if out.len() >= MAX_CHILDREN {
                break;
            }
            out.push(c);
        }
    }
    out.truncate(MAX_CHILDREN);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::Board;
    use crate::nextmino::NextMino;
    use crate::shapes::{MINO_I, MINO_L, MINO_NONE, MINO_O, MINO_S, MINO_T, MINO_Z};
    use std::cell::RefCell;
    use std::rc::Rc;

    fn build_root(
        rows: &[i32],
        current: i32,
        queue: &[i32],
        hold: i32,
        combo: i32,
        btb: i32,
    ) -> GamePack {
        let next = Rc::new(RefCell::new(NextMino::default()));
        next.borrow_mut().view_next = 2;
        let mut real_next = Vec::with_capacity(queue.len() + 1);
        real_next.push(current);
        real_next.extend_from_slice(queue);

        let mut g = GamePack::default();
        g.board = Board::default();
        for (y, row) in rows.iter().enumerate().take(32) {
            g.board.line[y] = *row;
        }
        g.board.update_max_height();
        g.hold.init();
        g.hold.m = hold;
        g.commands.init();
        g.combo = combo;
        g.btb = btb;
        g.act = 0;
        g.falling_mino.init();
        g.locked_mino.init();
        next.borrow_mut().init(&real_next);
        g.set_new_current(&next);
        g
    }

    #[test]
    fn expand_empty_i_golden() {
        let g = build_root(
            &[],
            MINO_I,
            &[MINO_O, MINO_T, MINO_S, MINO_Z, MINO_L],
            MINO_NONE,
            0,
            0,
        );
        let children = expand_node(&g, false);
        assert_eq!(children.len(), 17);
        assert!(children.iter().all(|c| !c.hold_used));
    }

    #[test]
    fn expand_empty_i_with_hold_golden() {
        let g = build_root(
            &[],
            MINO_I,
            &[MINO_O, MINO_T, MINO_S, MINO_Z, MINO_L],
            MINO_NONE,
            0,
            0,
        );
        let children = expand_node(&g, true);
        assert_eq!(children.len(), 26);
        assert_eq!(children.iter().filter(|c| c.hold_used).count(), 9);
    }

    #[test]
    fn expand_topped_out_is_empty() {
        let g = build_root(&[0x3ff; 20], MINO_I, &[MINO_O, MINO_T], MINO_NONE, 0, 0);
        let children = expand_node(&g, false);
        assert!(children.is_empty());
    }
}
