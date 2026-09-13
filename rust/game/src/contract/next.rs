//! Native `NextMino` state machine — the persistent queue the versus game
//! mutates once per piece through `RootNode.SetPPTData`.
//!
//! Faithful port of `src/ai/hoiko-next.ts` (itself exe-verified; the golden
//! vectors in the tests below come from `tests/hoiko-next.test.ts`). It is the
//! game-side carry the native app feeds to `hoiko-core`'s search input.

use crate::types::{MINO_I, MINO_J, MINO_L, MINO_NONE, MINO_O, MINO_S, MINO_T, MINO_Z};

/// `src/ai/hoiko-next.ts` `NEXT_SIZE`.
pub const NEXT_SIZE: usize = 28;
/// `src/ai/hoiko-next.ts` `BAG_START`.
pub const BAG_START: i32 = 6;

/// `src/ai/hoiko-next.ts` `bagRemainsStart`.
pub const fn bag_remains_start() -> i32 {
    BAG_START
}

/// `src/ai/hoiko-next.ts` `trustRange`.
pub fn trust_range(remains: i32) -> i32 {
    match remains {
        6 => 2,
        5 => 1,
        0 => 3,
        _ => 0,
    }
}

fn bag_pick(remains: i32) -> i32 {
    match remains {
        6 => MINO_Z,
        5 => MINO_S,
        4 => MINO_T,
        3 => MINO_O,
        2 => MINO_J,
        1 => MINO_L,
        0 => MINO_I,
        _ => MINO_NONE,
    }
}

/// `src/ai/hoiko-next.ts` `NextState`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NextState {
    pub m: [i32; NEXT_SIZE],
    pub trust_end: i32,
    pub bag_remains: i32,
    pub view_next: i32,
}

impl NextState {
    pub fn new(view_next: i32) -> NextState {
        NextState {
            m: [MINO_NONE; NEXT_SIZE],
            trust_end: 0,
            bag_remains: BAG_START,
            view_next,
        }
    }

    /// `src/ai/hoiko-next.ts` `init`.
    pub fn init(&mut self, real_next: &[i32]) {
        self.bag_remains = BAG_START;
        for i in 0..NEXT_SIZE {
            self.m[i] = bag_pick(self.bag_remains);
            self.bag_remains -= 1;
            if self.bag_remains < 0 {
                self.bag_remains = BAG_START;
            }
        }
        self.compare(0, real_next);
    }

    /// `src/ai/hoiko-next.ts` `at` (out-of-range reads yield `MINO_NONE`).
    pub fn at(&self, index: i32) -> i32 {
        if index < 0 || index >= NEXT_SIZE as i32 {
            return MINO_NONE;
        }
        self.m[index as usize]
    }

    /// `src/ai/hoiko-next.ts` `compare`.
    pub fn compare(&mut self, cmp_first: i32, nx: &[i32]) {
        for i in 0..self.view_next {
            let target = nx.get(i as usize).copied().unwrap_or(MINO_NONE);
            if self.at(cmp_first + i) != target {
                self.swap(cmp_first + i, target);
            }
        }
        self.trust_end = self.view_next - 1 + trust_range(self.bag_remains);
    }

    /// `src/ai/hoiko-next.ts` `shiftNext`.
    pub fn shift_next(&mut self) {
        for i in 0..NEXT_SIZE - 1 {
            self.m[i] = self.at(i as i32 + 1);
        }
        self.m[NEXT_SIZE - 1] = bag_pick(self.bag_remains);
        self.bag_remains -= 1;
        if self.bag_remains < 0 {
            self.bag_remains = BAG_START;
        }
    }

    /// `src/ai/hoiko-next.ts` `swap`.
    fn swap(&mut self, cmped_index: i32, nx: i32) {
        for i in (cmped_index + 1)..NEXT_SIZE as i32 {
            if self.at(i) != nx {
                continue;
            }
            let mut j = i;
            while j > cmped_index {
                let previous = self.at(j - 1);
                self.m[j as usize] = previous;
                j -= 1;
            }
            self.m[cmped_index as usize] = nx;
            return;
        }
        self.m[cmped_index as usize] = nx;
    }
}

impl Default for NextState {
    fn default() -> NextState {
        NextState::new(2)
    }
}
