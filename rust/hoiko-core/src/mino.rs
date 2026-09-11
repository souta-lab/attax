//! Native FallMino + Command — faithful port of `src/ai/native/mino.ts`.
//!
//! Move delays (binary): move 30, rotate 16, soft-drop/row 33, hard-drop 112,
//! hold 16. Command opcodes (ASCII): l/r move, a/b rotate, u hard drop, d soft
//! drop (followed by `'A'+y`), g bug-gravity drop, h swap hold, f first hold.

use crate::board::Board;
use crate::shapes::{shape_for, MINO_NONE, MINO_O, MinoType};

/// Minimal view over the shared NextMino array used by `Command::swap_hold`.
pub trait NextSource {
    fn get(&self) -> MinoType;
    fn advance(&mut self);
}

#[derive(Clone, Copy)]
pub struct HoldMino {
    pub m: MinoType,
    pub swapped_hold: i32,
    pub abnormal_hold: i32,
}

impl Default for HoldMino {
    fn default() -> Self {
        Self { m: MINO_NONE, swapped_hold: 0, abnormal_hold: 0 }
    }
}

impl HoldMino {
    pub fn init(&mut self) {
        self.m = MINO_NONE;
        self.swapped_hold = 0;
        self.abnormal_hold = 0;
    }
}

#[derive(Clone, Copy)]
pub struct FallMino {
    pub x: i32,
    pub y: i32,
    pub r: i32,
    pub m: MinoType,
    pub last_srs: i32,
    pub bug_gravity: i32,
}

impl Default for FallMino {
    fn default() -> Self {
        Self { x: 3, y: 20, r: 0, m: MINO_NONE, last_srs: 0, bug_gravity: 0 }
    }
}

impl FallMino {
    pub fn init(&mut self) {
        *self = Self::default();
    }

    pub fn spawn(&mut self, new_m: MinoType, board: &Board) -> i32 {
        self.m = new_m;
        self.x = 3;
        self.y = 20;
        self.r = 0;
        self.last_srs = 0;
        self.bug_gravity = 0;
        let h = board.get_spawn_height(self);
        if h == -1 {
            return 0;
        }
        self.y = h;
        1
    }

    pub fn spin_a(&mut self) {
        self.r = if self.r > 2 { 0 } else { self.r + 1 };
    }

    pub fn spin_b(&mut self) {
        self.r = if self.r < 1 { 3 } else { self.r - 1 };
    }

    pub fn left(&self) -> i32 {
        self.x + shape_for(self.m, self.r).min_x
    }

    pub fn right(&self) -> i32 {
        self.x + shape_for(self.m, self.r).max_x
    }

    pub fn top(&self) -> i32 {
        self.y - shape_for(self.m, self.r).min_y
    }

    pub fn bottom(&self) -> i32 {
        self.y - shape_for(self.m, self.r).max_y
    }
}

#[derive(Clone, Default)]
pub struct Command {
    pub s: Vec<i32>,
    pub move_delay: i32,
}

impl Command {
    pub fn init(&mut self) {
        self.s.clear();
        self.move_delay = 0;
    }

    pub fn add_command(&mut self, cmd: i32) {
        self.s.push(cmd);
    }

    fn add_command_soft_drop(&mut self, cmd: i32, y: i32) {
        self.s.push(cmd);
        self.s.push(65 + y);
    }

    pub fn add_commands(&mut self, cmds: &str) {
        for ch in cmds.bytes() {
            self.s.push(ch as i32);
        }
    }

    pub fn is_first_hold(&self) -> bool {
        self.s.first() == Some(&102)
    }

    pub fn hard_drop(&mut self, mino: &mut FallMino, bd: &Board) -> i32 {
        self.add_command(b'u' as i32);
        self.move_delay += 112;
        let d = bd.collision_distance(mino);
        if d > 0 {
            mino.y -= d;
            mino.last_srs = 0;
        }
        1
    }

    pub fn soft_drop(&mut self, mino: &mut FallMino, bd: &Board) -> i32 {
        let d = bd.collision_distance(mino);
        if d == 0 {
            return 0;
        }
        mino.y -= d;
        self.add_command_soft_drop(b'd' as i32, mino.y);
        self.move_delay += d * 33;
        mino.last_srs = 0;
        1
    }

    pub fn soft_drop_once(&mut self, mino: &mut FallMino, bd: &Board) -> i32 {
        if bd.collision_bottom(mino) == 1 {
            return 0;
        }
        mino.y -= 1;
        self.add_command_soft_drop(b'd' as i32, mino.y);
        self.move_delay += 33;
        mino.last_srs = 0;
        1
    }

    fn bug_gravity_drop(&mut self, mino: &mut FallMino, bd: &Board) {
        if mino.bug_gravity == 1 && bd.collision_bottom(mino) == 0 {
            mino.y -= 1;
            mino.bug_gravity = 0;
            self.add_command_soft_drop(b'g' as i32, mino.y);
        }
    }

    pub fn move_left(&mut self, mino: &mut FallMino, bd: &Board) -> i32 {
        if bd.collision_left(mino) == 1 {
            return 0;
        }
        mino.x -= 1;
        mino.last_srs = 0;
        self.add_command(b'l' as i32);
        self.move_delay += 30;
        self.bug_gravity_drop(mino, bd);
        1
    }

    pub fn move_right(&mut self, mino: &mut FallMino, bd: &Board) -> i32 {
        if bd.collision_right(mino) == 1 {
            return 0;
        }
        mino.x += 1;
        mino.last_srs = 0;
        self.add_command(b'r' as i32);
        self.move_delay += 30;
        self.bug_gravity_drop(mino, bd);
        1
    }

    pub fn rotate_a(&mut self, mino: &mut FallMino, bd: &Board) -> i32 {
        if mino.m == MINO_O {
            return 0;
        }
        let srs = bd.srs_a(mino);
        if srs == 0 {
            return 0;
        }
        self.add_command(b'a' as i32);
        self.move_delay += 16;
        mino.last_srs = srs;
        self.bug_gravity_drop(mino, bd);
        1
    }

    pub fn rotate_b(&mut self, mino: &mut FallMino, bd: &Board) -> i32 {
        if mino.m == MINO_O {
            return 0;
        }
        let srs = bd.srs_b(mino);
        if srs == 0 {
            return 0;
        }
        self.add_command(b'b' as i32);
        self.move_delay += 16;
        mino.last_srs = srs;
        self.bug_gravity_drop(mino, bd);
        1
    }

    /// `Command.SwapHold` (IL 6863): non-empty hold swaps without consuming the
    /// queue, empty hold takes the next piece and advances.
    pub fn swap_hold(
        &mut self,
        mino: &mut FallMino,
        hld: &mut HoldMino,
        bd: &Board,
        nx: &mut dyn NextSource,
    ) -> i32 {
        if hld.swapped_hold == 1 {
            return 0;
        }
        let prev_abnormal = hld.abnormal_hold;
        hld.abnormal_hold = if mino.y == 20 { 0 } else { 1 };
        if hld.m != MINO_NONE {
            mino.m = hld.m;
            hld.m = nx.get();
            self.add_command(b'h' as i32);
            self.move_delay += 16;
        } else {
            hld.m = mino.m;
            nx.advance();
            mino.m = nx.get();
            self.add_command(b'f' as i32);
            self.move_delay += 16;
        }
        mino.x = 3;
        mino.r = 0;
        let spawn_height = bd.get_spawn_height(mino);
        if prev_abnormal == 0 {
            if spawn_height == 20 {
                mino.y = 20;
            } else {
                mino.y = 21;
                mino.bug_gravity = 1;
            }
        } else {
            mino.y = 21;
        }
        mino.last_srs = 0;
        hld.swapped_hold = 1;
        if spawn_height == -1 && self.rotate_b(mino, bd) == 0 {
            self.rotate_a(mino, bd);
        }
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shapes::MINO_I;

    #[test]
    fn hard_drop_golden() {
        let b = Board::default();
        let mut f = FallMino::default();
        f.m = MINO_I;
        f.y = 20;
        let mut cmd = Command::default();
        cmd.hard_drop(&mut f, &b);
        assert_eq!(f.y, 1);
        assert_eq!(cmd.move_delay, 112);
        assert_eq!(cmd.s, vec![b'u' as i32]);
    }

    #[test]
    fn spin_wraps() {
        let mut f = FallMino::default();
        f.spin_a();
        assert_eq!(f.r, 1);
        f.r = 3;
        f.spin_a();
        assert_eq!(f.r, 0);
        f.spin_b();
        assert_eq!(f.r, 3);
    }
}
