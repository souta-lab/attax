//! Native NextMino / NextIterator — faithful port of `src/ai/native/nextmino.ts`.
//!
//! Binary bag: `bag.remains` starts at 6; `pick(remains)` maps 6->Z, 5->S, 4->T,
//! 3->O, 2->J, 1->L, 0->I; then remains -= 1 and resets to 6 below 0. `m[28]`
//! therefore holds the repeating bag [Z,S,T,O,J,L,I].

use std::cell::RefCell;
use std::rc::Rc;

use crate::mino::NextSource;
use crate::shapes::{MinoType, MINO_I, MINO_J, MINO_L, MINO_NONE, MINO_O, MINO_S, MINO_T, MINO_Z};

pub const NEXT_SIZE: usize = 28;

pub fn trust_range(remains: i32) -> i32 {
    match remains {
        6 => 2,
        5 => 1,
        4 | 3 | 2 | 1 => 0,
        0 => 3,
        _ => 0,
    }
}

fn bag_pick(remains: i32) -> MinoType {
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

#[derive(Clone)]
pub struct NextMino {
    pub m: [MinoType; NEXT_SIZE],
    pub trust_end: i32,
    pub bag_remains: i32,
    pub view_next: i32,
}

impl Default for NextMino {
    fn default() -> Self {
        Self { m: [MINO_NONE; NEXT_SIZE], trust_end: 0, bag_remains: 6, view_next: 2 }
    }
}

impl NextMino {
    pub fn init(&mut self, real_next: &[MinoType]) {
        self.bag_remains = 6;
        for i in 0..NEXT_SIZE {
            self.m[i] = bag_pick(self.bag_remains);
            self.bag_remains -= 1;
            if self.bag_remains < 0 {
                self.bag_remains = 6;
            }
        }
        self.compare(0, real_next);
    }

    #[inline]
    pub fn at(&self, i: i32) -> MinoType {
        if i < 0 || i as usize >= NEXT_SIZE { MINO_NONE } else { self.m[i as usize] }
    }

    pub fn compare(&mut self, cmp_first: i32, nx: &[MinoType]) {
        for i in 0..self.view_next {
            let target = nx.get(i as usize).copied().unwrap_or(MINO_NONE);
            if self.at(cmp_first + i) != target {
                self.swap(cmp_first + i, target);
            }
        }
        self.trust_end = self.view_next - 1 + trust_range(self.bag_remains);
    }

    fn swap(&mut self, cmped_index: i32, nx: MinoType) {
        let mut i = cmped_index + 1;
        while i < NEXT_SIZE as i32 {
            if self.at(i) == nx {
                while i > cmped_index {
                    self.m[i as usize] = self.at(i - 1);
                    i -= 1;
                }
                self.m[cmped_index as usize] = nx;
                return;
            }
            i += 1;
        }
        self.m[cmped_index as usize] = nx;
    }

    pub fn shift_next(&mut self) {
        for i in 0..NEXT_SIZE - 1 {
            self.m[i] = self.at(i as i32 + 1);
        }
        self.m[NEXT_SIZE - 1] = bag_pick(self.bag_remains);
        self.bag_remains -= 1;
        if self.bag_remains < 0 {
            self.bag_remains = 6;
        }
    }
}

/// Pointer-pair iterator (`{m, trustEnd}`) over the shared NextMino array.
#[derive(Clone, Default)]
pub struct NextIterator {
    pub base: i32,
    pub trust_end: i32,
    source: Option<Rc<RefCell<NextMino>>>,
}

impl NextIterator {
    pub fn set_source(&mut self, next: &Rc<RefCell<NextMino>>) {
        self.source = Some(Rc::clone(next));
        self.base = 0;
        self.trust_end = next.borrow().trust_end;
    }

    pub fn get_at(&self, i: i32) -> MinoType {
        match &self.source {
            Some(src) => src.borrow().at(self.base + i),
            None => MINO_NONE,
        }
    }

    pub fn get(&self) -> MinoType {
        self.get_at(0)
    }

    pub fn advance(&mut self) {
        self.base += 1;
    }

    /// `IsTrustNext`: `base + i <= trustEnd`.
    pub fn is_trust_next(&self, i: i32) -> bool {
        self.base + i <= self.trust_end
    }

    pub fn copy_from(&mut self, other: &NextIterator) {
        self.source = other.source.clone();
        self.base = other.base;
        self.trust_end = other.trust_end;
    }
}

impl NextSource for NextIterator {
    fn get(&self) -> MinoType {
        self.get_at(0)
    }

    fn advance(&mut self) {
        self.base += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trust_range_table() {
        assert_eq!(trust_range(6), 2);
        assert_eq!(trust_range(5), 1);
        assert_eq!(trust_range(4), 0);
        assert_eq!(trust_range(0), 3);
        assert_eq!(trust_range(7), 0);
    }

    #[test]
    fn bag_order_and_compare_golden() {
        let mut nm = NextMino::default();
        nm.init(&[]);
        assert_eq!(
            nm.m[..10],
            [MINO_NONE, MINO_NONE, MINO_T, MINO_O, MINO_J, MINO_L, MINO_I, MINO_Z, MINO_S, MINO_T]
        );
        assert_eq!(nm.bag_remains, 6);
        assert_eq!(nm.trust_end, 3);

        let mut nm2 = NextMino::default();
        nm2.view_next = 2;
        nm2.init(&[MINO_I, MINO_J]);
        assert_eq!(nm2.at(0), MINO_I);
        assert_eq!(nm2.at(1), MINO_J);
        assert_eq!(nm2.trust_end, 3);
        assert_eq!(nm2.bag_remains, 6);
    }

    #[test]
    fn shift_next_advances_bag() {
        let mut nm = NextMino::default();
        nm.init(&[]);
        let before = nm.at(1);
        nm.shift_next();
        assert_eq!(nm.at(0), before);
        assert_eq!(nm.bag_remains, 5);
    }
}
