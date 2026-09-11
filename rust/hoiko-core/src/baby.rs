//! Frozen minimal subset of `src/ai/native/baby.ts` required by expand.
//!
//! `Baby` mirrors the 120-byte native BabyNode. The bucket helpers key a child by
//! `r*12 + (x+2)` and dedup by `(r, x, y)` keeping the smaller
//! `commands.move_delay`.
//!
//! Buckets store indices into the shared `babies` vector so that a dedup that
//! improves a stored baby is visible to that same baby (the TS reference stores
//! object references). Only the primitives `expand.rs` / `expand_derive.rs` need
//! are ported here; the search tree around Baby is out of scope for this task.

use crate::gamepack::GamePack;
use crate::mino::{Command, FallMino, HoldMino};
use crate::nextmino::NextIterator;

pub const MAX_BABYS: usize = 300;
pub const BABY_BUCKETS: usize = 48;

#[derive(Clone, Default)]
pub struct Baby {
    pub falling_mino: FallMino,
    pub commands: Command,
    pub hold: HoldMino,
    pub next_it: NextIterator,
}

impl Baby {
    pub fn copy_from(&mut self, src: &Baby) {
        self.falling_mino = src.falling_mino;
        self.commands.copy_from(&src.commands);
        self.hold = src.hold;
        self.next_it.copy_from(&src.next_it);
    }
}

pub fn make_root_baby(parent: &GamePack) -> Baby {
    let mut b = Baby::default();
    b.falling_mino = parent.falling_mino;
    b.hold = parent.hold;
    b.next_it.copy_from(&parent.next_it);
    b.commands.init();
    b
}

pub type Buckets = Vec<Vec<usize>>;

pub fn new_baby_buckets() -> Buckets {
    (0..BABY_BUCKETS).map(|_| Vec::new()).collect()
}

pub fn clear_baby_buckets(buckets: &mut [Vec<usize>]) {
    for bucket in buckets.iter_mut() {
        bucket.clear();
    }
}

fn bucket_index(baby: &Baby) -> i32 {
    baby.falling_mino.r * 12 + (baby.falling_mino.x + 2)
}

/// Records `babies[idx]` in its `(r,x)` bucket (no-op when out of range).
pub fn add_baby(buckets: &mut [Vec<usize>], baby: &Baby, idx: usize) {
    let b = bucket_index(baby);
    if b < 0 || b as usize >= BABY_BUCKETS {
        return;
    }
    buckets[b as usize].push(idx);
}

/// `OverrideSameNode` (IL 14270): returns 1 when an `(r,x,y)` match exists.
pub fn override_same_node(buckets: &mut [Vec<usize>], babies: &mut [Baby], target: &Baby) -> i32 {
    let idx = bucket_index(target);
    if idx < 0 || idx as usize >= BABY_BUCKETS {
        return 0;
    }
    let y = target.falling_mino.y;
    let bucket = &buckets[idx as usize];
    for &si in bucket {
        let Some(s) = babies.get_mut(si) else { continue };
        if s.falling_mino.y != y {
            continue;
        }
        if s.commands.move_delay > target.commands.move_delay {
            s.copy_from(target);
        }
        return 1;
    }
    0
}

pub struct ExpandedChild {
    pub game: GamePack,
    pub hold_used: bool,
    pub placed_x: i32,
    pub placed_r: i32,
    pub placed_m: i32,
    pub act: i32,
}

pub fn copy_game(dst: &mut GamePack, src: &GamePack) {
    dst.next_it.copy_from(&src.next_it);
    dst.hold = src.hold;
    dst.falling_mino = src.falling_mino;
    dst.locked_mino = src.locked_mino;
    dst.board.line = src.board.line;
    dst.board.stack_height = src.board.stack_height;
    dst.board.locked_bottom = src.board.locked_bottom;
    dst.commands.copy_from(&src.commands);
    dst.combo = src.combo;
    dst.btb = src.btb;
    dst.act = src.act;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shapes::{MINO_I, MINO_NONE};

    fn root_baby(m: i32) -> Baby {
        let mut b = Baby::default();
        b.falling_mino.m = m;
        b.falling_mino.y = 20;
        b.falling_mino.x = 3;
        b.falling_mino.r = 0;
        b.hold.m = MINO_NONE;
        b
    }

    #[test]
    fn override_same_node_keeps_smaller_delay() {
        let mut babies = vec![root_baby(MINO_I)];
        let mut buckets = new_baby_buckets();
        add_baby(&mut buckets, &babies[0], 0);
        babies[0].commands.move_delay = 100;

        let mut bb = root_baby(MINO_I);
        bb.commands.move_delay = 50;
        assert_eq!(override_same_node(&mut buckets, &mut babies, &bb), 1);
        assert_eq!(babies[0].commands.move_delay, 50);
    }

    #[test]
    fn override_same_node_different_y_is_new() {
        let mut babies = vec![root_baby(MINO_I)];
        let mut buckets = new_baby_buckets();
        add_baby(&mut buckets, &babies[0], 0);
        let mut bb = root_baby(MINO_I);
        bb.falling_mino.y = 21;
        assert_eq!(override_same_node(&mut buckets, &mut babies, &bb), 0);
    }
}
