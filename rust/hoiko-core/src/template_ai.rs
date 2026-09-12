//! `TemplateAI` — opener decision state machine (Hoiko.all.cs 16524–20518).
//!
//! Statics mirrored as struct fields: `useTDOpeners`, `useTemplate`, `opType`,
//! `opDropCount`, `prevOpDropCount`, `failTDOpeners`, `useDPC`, `loopTemplate`.
//! `SearchTDOpeners` and its 20 board-pattern lambdas are not ported yet (see
//! `evidence/hoiko-config/tdopeners/ASSESSMENT.md`).

use crate::gamepack::GamePack;
use crate::shapes::{MINO_J, MINO_L, MINO_NONE, MINO_O, MINO_S, MINO_T, MINO_Z};

pub const OP_NONE: i32 = 0;
pub const OP_ACTIVE: i32 = 1;
pub const OP_TYPE8: i32 = 8;

#[derive(Clone, Copy, Default)]
pub struct TemplateAi {
    pub use_td_openers: bool,
    pub use_template: bool,
    pub op_type: i32,
    pub op_drop_count: i32,
    pub prev_op_drop_count: i32,
    pub fail_td_openers: bool,
    pub use_dpc: bool,
    pub loop_template: bool,
}

impl TemplateAi {
    /// `TemplateAI.ReadConfig` (16524).
    pub fn read_config(&mut self, use_td_openers: bool, loop_template: bool) {
        self.use_td_openers = use_td_openers;
        self.use_template = false;
        self.op_type = OP_NONE;
        self.fail_td_openers = false;
        self.op_drop_count = 0;
        if self.use_td_openers {
            self.use_template = true;
            self.op_type = OP_ACTIVE;
        }
        self.use_dpc = false;
        self.loop_template = loop_template;
    }

    #[inline]
    pub fn in_template(&self) -> bool {
        self.op_type != OP_NONE
    }

    #[inline]
    pub fn break_template(&mut self) {
        self.op_type = OP_NONE;
    }

    #[inline]
    pub fn fail_template_get(&mut self) -> bool {
        let r = self.fail_td_openers;
        self.fail_td_openers = false;
        r
    }

    #[inline]
    pub fn fail_template_set(&mut self) {
        self.op_drop_count -= 1;
        self.fail_td_openers = true;
    }

    #[inline]
    pub fn break_check(&mut self) -> bool {
        if self.op_type != OP_NONE {
            return false;
        }
        if (self.op_drop_count - 7) as u32 <= 13 {
            return false;
        }
        self.op_drop_count = -1;
        self.prev_op_drop_count = -1;
        self.use_template = self.loop_template && self.use_template;
        true
    }

    #[inline]
    pub fn op_drop_count_plus(&mut self) {
        self.op_drop_count += 1;
    }

    #[inline]
    pub fn op_drop_count_save(&mut self) {
        self.prev_op_drop_count = self.op_drop_count;
    }

    #[inline]
    pub fn op_drop_count_load(&mut self) {
        self.op_drop_count = self.prev_op_drop_count;
    }

    /// `NextMino.IsOriginNext` (6662): `include_hold ? bagRemains==5 : bagRemains==6`.
    #[inline]
    pub fn is_origin_next(bag_remains: i32, include_hold: bool) -> bool {
        bag_remains == if include_hold { 5 } else { 6 }
    }

    /// `TemplateAI.OriginNextCmp` (20292): hold + next[0..6) cover all seven pieces.
    pub fn origin_next_cmp(g: &GamePack) -> bool {
        let mut bits = 1i32 << g.hold.m;
        for i in 0..6 {
            bits |= 1 << g.next_it.get_at(i);
        }
        bits == 127
    }

    /// `TemplateAI.TDOpenersCmp` (20293): exact bottom-row patterns per held/next
    /// piece; returns the OpType (2/3/4/5/6/7) or 0.
    pub fn td_openers_cmp(g: &GamePack) -> i32 {
        let hold = g.hold.m;
        let piece = if hold == MINO_NONE { g.next_it.get_at(0) } else { hold };
        let l = &g.board.line;
        match piece {
            MINO_L => {
                if l[3] == 6 && l[2] == 135 && l[1] == 1015 && l[0] == 1007 {
                    return 4;
                }
            }
            MINO_T => {
                if l[3] == 518 && l[2] == 775 && l[1] == 823 && l[0] == 879 {
                    return 4;
                }
                if l[3] == 385 && l[2] == 899 && l[1] == 947 && l[0] == 987 {
                    return 5;
                }
            }
            MINO_S => {
                if l[3] == 518 && l[2] == 903 && l[1] == 967 && l[0] == 911 {
                    return 4;
                }
                if l[3] == 1 && l[2] == 135 && l[1] == 959 && l[0] == 991 {
                    return 5;
                }
            }
            MINO_Z => {
                if l[3] == 512 && l[2] == 900 && l[1] == 1015 && l[0] == 1007 {
                    return 4;
                }
                if l[3] == 385 && l[2] == 903 && l[1] == 911 && l[0] == 967 {
                    return 5;
                }
            }
            MINO_J => {
                if l[3] == 384 && l[2] == 900 && l[1] == 959 && l[0] == 991 {
                    return 5;
                }
            }
            _ => {}
        }
        match piece {
            MINO_Z => {
                if l[3] == 512 && l[2] == 932 && l[1] == 1015 && l[0] == 1007 {
                    return 6;
                }
            }
            MINO_S => {
                if l[3] == 1 && l[2] == 151 && l[1] == 959 && l[0] == 991 {
                    return 7;
                }
            }
            _ => {}
        }
        match piece {
            MINO_L => {
                if l[3] == 768 && l[2] == 900 && l[1] == 959 && l[0] == 991 {
                    return 2;
                }
            }
            MINO_J => {
                if l[3] == 3 && l[2] == 135 && l[1] == 1015 && l[0] == 1007 {
                    return 3;
                }
            }
            _ => {}
        }
        OP_NONE
    }

    /// `TemplateAI.DecisionTemplate` (20301).
    pub fn decision_template(&mut self, g: &GamePack) -> bool {
        if self.op_drop_count <= 7 {
            if !self.use_td_openers {
                return false;
            }
            self.op_type = Self::td_openers_cmp(g);
            return self.op_type != OP_NONE;
        }
        if self.op_drop_count <= 15 {
            self.op_type = OP_TYPE8;
            return false;
        }
        if self.op_drop_count <= 21 {
            if !self.use_dpc {
                return false;
            }
            self.op_type = match g.hold.m {
                x if x == MINO_O => 9,
                x if x == MINO_Z => 10,
                x if x == MINO_S => 11,
                _ => OP_NONE,
            };
            return self.op_type != OP_NONE;
        }
        if self.op_drop_count <= 29 {
            self.op_type = 12;
            return false;
        }
        false
    }

    /// `TemplateAI.DecisionLoopTemplate` (20364). `bag_remains` is
    /// `RootNode.next.bagRemains` (= `NextMino+116`).
    pub fn decision_loop_template(&mut self, g: &mut GamePack, bag_remains: i32) -> bool {
        if self.op_drop_count >= 0 {
            return true;
        }
        if !self.loop_template {
            return false;
        }
        let mut flag = false;
        if g.board.line[0] == 0 {
            if g.hold.m != MINO_NONE {
                if self.use_dpc && Self::is_origin_next(bag_remains, false) {
                    self.op_type = match g.hold.m {
                        x if x == MINO_O => 9,
                        x if x == MINO_Z => 10,
                        x if x == MINO_S => 11,
                        _ => OP_NONE,
                    };
                    flag = self.op_type != OP_NONE;
                } else if self.use_td_openers
                    && Self::is_origin_next(bag_remains, true)
                    && Self::origin_next_cmp(g)
                {
                    flag = true;
                }
            } else if self.use_td_openers && Self::is_origin_next(bag_remains, false) {
                flag = true;
            }
        }
        if flag {
            self.start_template(g);
        }
        flag
    }

    fn start_template(&mut self, g: &mut GamePack) {
        self.op_type = OP_ACTIVE;
        self.fail_td_openers = false;
        self.op_drop_count = 0;
        g.btb = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shapes::MINO_T;

    fn game_with(rows: &[(usize, i32)], hold: i32) -> GamePack {
        let mut g = GamePack::default();
        for (r, v) in rows {
            g.board.line[*r] = *v;
        }
        g.hold.m = hold;
        g.next_it = crate::nextmino::NextIterator::default();
        g
    }

    #[test]
    fn read_config_matches_use_td_gate() {
        let mut t = TemplateAi::default();
        t.read_config(false, false);
        assert!(!t.use_template);
        assert_eq!(t.op_type, OP_NONE);
        t.read_config(true, true);
        assert!(t.use_template);
        assert_eq!(t.op_type, OP_ACTIVE);
        assert!(t.loop_template);
    }

    #[test]
    fn td_openers_cmp_finds_t_pattern() {
        let g = game_with(&[(0, 879), (1, 823), (2, 775), (3, 518)], MINO_T);
        assert_eq!(TemplateAi::td_openers_cmp(&g), 4);
    }

    #[test]
    fn td_openers_cmp_ignores_unknown_layout() {
        let g = game_with(&[(0, 1)], MINO_T);
        assert_eq!(TemplateAi::td_openers_cmp(&g), OP_NONE);
    }

    #[test]
    fn break_check_only_rearms_when_looping() {
        let mut t = TemplateAi::default();
        t.read_config(true, false);
        t.op_type = OP_NONE;
        t.op_drop_count = 25;
        assert!(t.break_check());
        assert_eq!(t.op_drop_count, -1);
        assert!(!t.use_template);
        t.read_config(true, true);
        t.op_type = OP_NONE;
        t.op_drop_count = 25;
        assert!(t.break_check());
        assert!(t.use_template);
    }

    #[test]
    fn decision_loop_start_clears_btb() {
        let mut t = TemplateAi::default();
        t.read_config(true, true);
        t.op_type = OP_NONE;
        t.op_drop_count = -1;
        let mut g = game_with(&[], MINO_NONE);
        g.btb = 3;
        assert!(t.decision_loop_template(&mut g, 6));
        assert_eq!(t.op_type, OP_ACTIVE);
        assert_eq!(t.op_drop_count, 0);
        assert_eq!(g.btb, 0);
    }
}
