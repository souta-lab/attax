//! `ExpandAI.ExpandNode` / `ExpandBaseNode` / `RegistChildNode` — faithful port
//! of `src/ai/native/expand.ts` (SPEC_ExpandAI §4.1-§4.2, §4.13).
//!
//! Expansion is selected by board state: `!IsSafe ? ExpandBaseNode :
//! ExpandTemplateNode`, then ExpandDeriveNode and RegistChildNode; a hold-swap
//! pass follows when the current piece != hold.

use crate::baby::{
    add_baby, clear_baby_buckets, copy_game, cursor_iterator, make_root_baby, new_baby_buckets,
    override_same_node, Baby, Buckets, ExpandedChild, MAX_BABYS,
};
use crate::board::Board;
use crate::expand_derive::expand_derive_node;
use crate::expand_template::expand_template_node;
use crate::gamepack::GamePack;
use crate::mino::FallMino;
use crate::shapes::ACT_NONE;

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
        babies.retain(|b| b.commands.move_delay < PRUNE_KEEP_BELOW);
        babies.truncate(kept);
        clear_baby_buckets(buckets);
        for i in 0..babies.len() {
            add_baby(buckets, &babies[i], i);
        }
    }
    babies.len() as i32
}

/// Bucket key for `delete_same_node`: the four rows at `locked_bottom` plus
/// `act`, packed into one word so a bucket scan compares one value (the
/// reference compares exactly these five fields).
#[inline]
fn dedup_key(cand: &ExpandedChild) -> u64 {
    let b = &cand.game.board;
    let lb = b.locked_bottom;
    (b.row_at(lb) as u64 & 0x3FF)
        | ((b.row_at(lb + 1) as u64 & 0x3FF) << 10)
        | ((b.row_at(lb + 2) as u64 & 0x3FF) << 20)
        | ((b.row_at(lb + 3) as u64 & 0x3FF) << 30)
        | ((cand.game.act as u64) << 40)
}

fn delete_same_node(
    child_buckets: &mut [Vec<(u64, usize)>],
    out: &mut [ExpandedChild],
    key: u64,
    cand: &ExpandedChild,
) -> i32 {
    let lb = cand.game.board.locked_bottom;
    let r = cand.game.locked_mino.r;
    let idx = lb * 2 + (r & 1);
    if idx < 0 || idx >= CHILD_BUCKETS as i32 {
        return 0;
    }
    let bucket = &child_buckets[idx as usize];
    for &(k, si) in bucket {
        if k != key {
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
    child_buckets: &mut [Vec<(u64, usize)>],
    out: &mut Vec<ExpandedChild>,
) {
    for bucket in child_buckets.iter_mut() {
        bucket.clear();
    }
    out.clear();
    for baby in babies {
        let mut g = GamePack {
            next_it: cursor_iterator(&parent.next_it, baby.next),
            hold: baby.hold,
            falling_mino: baby.falling_mino,
            locked_mino: FallMino::default(),
            board: Board {
                line: parent.board.line,
                stack_height: parent.board.stack_height,
                locked_bottom: parent.board.locked_bottom,
            },
            commands: baby.commands,
            combo: parent.combo,
            btb: parent.btb,
            act: ACT_NONE,
        };
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
        let key = dedup_key(&cand);
        if delete_same_node(child_buckets, out, key, &cand) == 1 {
            continue;
        }
        let idx = cand.game.board.locked_bottom * 2 + (cand.game.locked_mino.r & 1);
        if idx >= 0 && idx < CHILD_BUCKETS as i32 {
            child_buckets[idx as usize].push((key, out.len()));
        }
        out.push(cand);
    }
}

/// Reusable expansion scratch (baby pool, dedup buckets, hold output). One
/// instance lives across every `expand_node` call in a search.
pub struct ExpandScratch {
    babies: Vec<Baby>,
    buckets: Buckets,
    child_buckets: Vec<Vec<(u64, usize)>>,
    hold_out: Vec<ExpandedChild>,
}

impl Default for ExpandScratch {
    fn default() -> Self {
        Self::new()
    }
}

impl ExpandScratch {
    pub fn new() -> Self {
        Self {
            babies: Vec::with_capacity(MAX_BABYS),
            buckets: new_baby_buckets(),
            child_buckets: (0..CHILD_BUCKETS).map(|_| Vec::new()).collect(),
            hold_out: Vec::new(),
        }
    }
}

/// `ExpandNode` (IL 14207): non-hold + hold passes, capped at MAX_CHILDREN.
pub fn expand_node_into(
    parent: &GamePack,
    allow_hold: bool,
    scratch: &mut ExpandScratch,
    out: &mut Vec<ExpandedChild>,
) {
    let ExpandScratch { babies, buckets, child_buckets, hold_out } = scratch;
    let mut ch = [-1i32; 10];
    parent.board.get_column_height(&mut ch);
    let safe = parent.is_safe();

    let root = make_root_baby(parent);
    babies.clear();
    clear_baby_buckets(buckets);
    babies.push(root.clone());
    add_baby(buckets, &root, 0);
    if safe {
        expand_template_node(babies, &root);
    } else {
        expand_base_node(babies, &parent.board, buckets);
    }
    expand_derive_node(babies, &parent.board, &ch, buckets);
    regist_child_node(babies, parent, false, child_buckets, out);

    if allow_hold && parent.falling_mino.m != parent.hold.m {
        let mut hold_baby = make_root_baby(parent);
        let mut hold_it = cursor_iterator(&parent.next_it, hold_baby.next);
        hold_baby.commands.swap_hold(
            &mut hold_baby.falling_mino,
            &mut hold_baby.hold,
            &parent.board,
            &mut hold_it,
        );
        hold_baby.next.base = hold_it.base;
        babies.clear();
        clear_baby_buckets(buckets);
        babies.push(hold_baby.clone());
        add_baby(buckets, &hold_baby, 0);
        if safe {
            expand_template_node(babies, &hold_baby);
        } else {
            expand_base_node(babies, &parent.board, buckets);
        }
        expand_derive_node(babies, &parent.board, &ch, buckets);
        regist_child_node(babies, parent, true, child_buckets, hold_out);
        for c in hold_out.drain(..) {
            if out.len() >= MAX_CHILDREN {
                break;
            }
            out.push(c);
        }
    }
    out.truncate(MAX_CHILDREN);
}

pub fn expand_node(parent: &GamePack, allow_hold: bool) -> Vec<ExpandedChild> {
    let mut scratch = ExpandScratch::new();
    let mut out = Vec::new();
    expand_node_into(parent, allow_hold, &mut scratch, &mut out);
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
