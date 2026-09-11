//! Native Others / GamePack — faithful port of `HEAD:src/ai/native/gamepack.ts`.
//!
//! `Others::totaling` reproduces the binary's combo/btb/ClearAct computation.
//! GamePack mirrors the 304-byte native struct used by ExpandAI/EvaluateAI.

use std::cell::RefCell;
use std::rc::Rc;

use crate::board::{Board, FULL_ROW};
use crate::mino::{Command, FallMino, HoldMino};
use crate::nextmino::{NextIterator, NextMino};
use crate::shapes::{
    MinoType, ACT_DOUBLE, ACT_NONE, ACT_PC, ACT_QUAD, ACT_SINGLE, ACT_TRIPLE, ACT_TSD, ACT_TSM,
    ACT_TSS, ACT_TST,
};

#[derive(Clone, Copy, Default)]
pub struct Others {
    pub combo: i32,
    pub btb: i32,
    pub act: i32,
}

/// `Others.Totaling` (IL 21211). `cleared` is the number of rows LockMino found.
pub fn totaling(others: &mut Others, mino: &FallMino, bd: &Board, cleared: i32) {
    if cleared == 0 {
        if others.combo > 0 {
            others.combo = -others.combo;
        } else {
            others.combo = 0;
        }
        others.act = ACT_NONE;
        return;
    }
    if others.combo < 0 {
        others.combo = 0;
    }
    if bd.row_at(cleared - 1) == FULL_ROW && bd.row_at(cleared) == 0 {
        if cleared >= 4 {
            others.btb += 1;
        } else {
            others.btb = 0;
        }
        others.combo += 1;
        others.act = ACT_PC;
        return;
    }
    if cleared >= 4 {
        others.btb += 1;
        others.act = ACT_QUAD;
    } else {
        let tspin = bd.is_tspin(mino);
        if tspin == 1 {
            others.act = if cleared == 1 {
                ACT_TSS
            } else if cleared == 2 {
                ACT_TSD
            } else {
                ACT_TST
            };
            others.btb += 1;
        } else {
            others.act = if cleared == 1 {
                ACT_SINGLE
            } else if cleared == 2 {
                ACT_DOUBLE
            } else {
                ACT_TRIPLE
            };
            if tspin == 2 {
                others.act = ACT_TSM;
                others.btb += 1;
            } else {
                others.btb = 0;
            }
        }
    }
    others.combo += 1;
}

#[derive(Clone)]
pub struct GamePack {
    pub next_it: NextIterator,
    pub hold: HoldMino,
    pub falling_mino: FallMino,
    pub locked_mino: FallMino,
    pub board: Board,
    pub commands: Command,
    pub combo: i32,
    pub btb: i32,
    pub act: i32,
}

impl Default for GamePack {
    fn default() -> Self {
        Self {
            next_it: NextIterator::default(),
            hold: HoldMino::default(),
            falling_mino: FallMino::default(),
            locked_mino: FallMino::default(),
            board: Board::default(),
            commands: Command::default(),
            combo: 0,
            btb: 0,
            act: ACT_NONE,
        }
    }
}

impl GamePack {
    pub fn init(&mut self, next: &Rc<RefCell<NextMino>>, real_next: &[MinoType]) {
        self.board.init();
        self.hold.init();
        self.commands.init();
        self.combo = 0;
        self.btb = 0;
        self.act = ACT_NONE;
        self.falling_mino.init();
        self.locked_mino.init();
        next.borrow_mut().init(real_next);
        self.set_new_current(next);
    }

    pub fn set_new_current(&mut self, next: &Rc<RefCell<NextMino>>) {
        self.next_it.set_source(next);
        let m = self.next_it.get();
        self.falling_mino.spawn(m, &self.board);
    }

    pub fn advance_mino(&mut self, next: &Rc<RefCell<NextMino>>) {
        self.next_it.set_source(next);
        let m = self.next_it.get();
        self.falling_mino.spawn(m, &self.board);
    }

    pub fn is_safe(&self) -> bool {
        self.board.stack_height < self.falling_mino.y - 3
    }

    /// `GamePack.LockDown` (IL 6928): returns 0 on top-out / blocked spawn.
    pub fn lock_down(&mut self) -> i32 {
        self.commands.hard_drop(&mut self.falling_mino, &self.board);
        let cleared = self.board.lock_mino(&self.falling_mino);
        if cleared == -1 {
            return 0;
        }
        let mut others = Others { combo: self.combo, btb: self.btb, act: self.act };
        totaling(&mut others, &self.falling_mino, &self.board, cleared);
        self.combo = others.combo;
        self.btb = others.btb;
        self.act = others.act;
        if cleared > 0 {
            self.board.clear_line();
        }
        self.hold.swapped_hold = 0;
        self.locked_mino = self.falling_mino;
        self.next_it.advance();
        let m = self.next_it.get();
        self.falling_mino.spawn(m, &self.board)
    }

    /// Consume the current piece outside the search (`NextMino.ShiftNext`).
    pub fn shift_next(&mut self, next: &Rc<RefCell<NextMino>>) {
        next.borrow_mut().shift_next();
        self.next_it.advance();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shapes::{MINO_I, MINO_NONE, MINO_T};

    #[test]
    fn totaling_none_flips_positive_combo() {
        let mut o = Others { combo: 3, btb: 2, act: 0 };
        let bd = Board::default();
        let f = FallMino::default();
        totaling(&mut o, &f, &bd, 0);
        assert_eq!(o.combo, -3);
        assert_eq!(o.act, ACT_NONE);
    }

    #[test]
    fn totaling_single_clears_btb() {
        let mut bd = Board::default();
        bd.line[0] = FULL_ROW;
        bd.line[1] = 1;
        let mut mino = FallMino::default();
        mino.m = MINO_I;
        let mut o = Others { combo: 0, btb: 3, act: 0 };
        totaling(&mut o, &mino, &bd, 1);
        assert_eq!(o.act, ACT_SINGLE);
        assert_eq!(o.btb, 0);
        assert_eq!(o.combo, 1);
    }

    #[test]
    fn totaling_pc_branch() {
        let mut bd = Board::default();
        bd.line[0] = FULL_ROW;
        let mut mino = FallMino::default();
        mino.m = MINO_T;
        let mut o = Others { combo: 0, btb: 0, act: 0 };
        totaling(&mut o, &mino, &bd, 1);
        assert_eq!(o.act, ACT_PC);
        assert_eq!(o.btb, 0);
        assert_eq!(o.combo, 1);
    }

    #[test]
    fn lock_down_on_empty_board_spawns_next() {
        let next = Rc::new(RefCell::new(NextMino::default()));
        let mut g = GamePack::default();
        g.init(&next, &[MINO_I, MINO_NONE]);
        let spawned = g.lock_down();
        assert_eq!(spawned, 1);
        assert_eq!(g.locked_mino.m, MINO_I);
        assert_eq!(g.locked_mino.y, 1);
        assert_eq!(g.commands.move_delay, 112);
    }
}
