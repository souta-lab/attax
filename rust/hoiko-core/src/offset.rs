//! Native `OffsetOffAI` garbage/offset management — faithful port of
//! `src/ai/native/offset.ts` (binary IL 13777-14069).
//!
//! The shipping revision has no `opponentsCombo` branches in `can_offset_off`.
//! `compute_decision`'s `column_heights` are the driver's zero-filled
//! `Board.GetColumnHeight` result (absolute heights), not garbage-relative.

use crate::nextmino::NextMino;
use crate::shapes::{
    ACT_DOUBLE, ACT_NONE, ACT_PC, ACT_QUAD, ACT_SINGLE, ACT_TRIPLE, ACT_TSD, ACT_TSM, ACT_TSS,
    ACT_TST, MINO_I, MINO_T,
};

#[derive(Clone, Copy, Default)]
pub struct OffsetData {
    pub can_wait_garbage: bool,
    pub center4_height: i32,
    pub atk: i32,
    pub pc_chance: bool,
    pub near_offset: bool,
}

#[derive(Clone, Copy, Default)]
pub struct GarbageData {
    pub opponents_atk: i32,
    pub cool_time: i32,
    pub remaining_time: i32,
    pub opponents_lock_count: i32,
    pub first_invalid_lock: bool,
}

pub struct OffsetOffAI {
    pub use_offset_off: bool,
    pub ofs_data: OffsetData,
    pub gb_data: GarbageData,
}

fn plan_act(acts: &[i32], i: i32) -> i32 {
    if i < 0 {
        ACT_NONE
    } else {
        acts.get(i as usize).copied().unwrap_or(ACT_NONE)
    }
}

impl OffsetOffAI {
    pub fn new(use_offset_off: bool) -> Self {
        let mut ai = Self {
            use_offset_off: false,
            ofs_data: OffsetData::default(),
            gb_data: GarbageData::default(),
        };
        ai.set_use_offset_off(use_offset_off);
        ai
    }

    /// `OffsetOffAI.UseOffsetOff(set)`: set the flag and zero both structs.
    pub fn set_use_offset_off(&mut self, enabled: bool) {
        self.use_offset_off = enabled;
        self.ofs_data = OffsetData::default();
        self.gb_data = GarbageData::default();
    }

    /// `OffsetOffAI.CanOffsetOff` (IL 13799).
    pub fn can_offset_off(&self, garbage: i32, is_even_board: bool) -> bool {
        let ofs = self.ofs_data;
        if !ofs.can_wait_garbage {
            return false;
        }
        if ofs.center4_height + garbage >= 15 {
            return false;
        }
        if is_even_board && ofs.pc_chance && ofs.atk >= garbage {
            return false;
        }
        if ofs.near_offset && garbage >= 4 {
            return true;
        }
        if ofs.atk < garbage {
            return true;
        }
        garbage > 2
    }

    /// `OffsetOffAI.DecisionOffsetOff` (IL 13824).
    pub fn compute_decision(
        &mut self,
        plan_acts: &[i32],
        depth: i32,
        hold: i32,
        next: &NextMino,
        btb: i32,
        is_even_board: bool,
        column_heights: &[i32; 10],
    ) {
        self.ofs_data.can_wait_garbage = false;
        if !self.use_offset_off || plan_act(plan_acts, 0) != ACT_NONE {
            return;
        }
        let ofs = &mut self.ofs_data;

        ofs.pc_chance = false;
        if is_even_board {
            let end = (depth - 1).min(next.trust_end + 1);
            let mut i = 2;
            while i <= end {
                if plan_act(plan_acts, i) == ACT_PC {
                    ofs.pc_chance = true;
                    break;
                }
                i += 1;
            }
        }

        ofs.near_offset = false;
        ofs.atk = 0;
        let btb_bonus = if btb > 0 { 1 } else { 0 };
        let act1 = plan_act(plan_acts, 1);
        let act2 = plan_act(plan_acts, 2);

        let compute = match act1 {
            ACT_NONE => match act2 {
                ACT_TST => {
                    if hold == MINO_T || next.at(2) != MINO_T {
                        ofs.atk = 6;
                    } else {
                        return;
                    }
                    true
                }
                ACT_TSD => {
                    if hold == MINO_T || next.at(2) != MINO_T {
                        ofs.atk = 4;
                    } else {
                        return;
                    }
                    true
                }
                ACT_TSS => {
                    if hold == MINO_T || next.at(2) != MINO_T {
                        ofs.atk = 2;
                    } else {
                        return;
                    }
                    true
                }
                ACT_QUAD => {
                    if hold == MINO_I || next.at(2) != MINO_I {
                        ofs.atk = 4;
                    } else {
                        return;
                    }
                    true
                }
                _ => return,
            },
            ACT_SINGLE => {
                if !ofs.pc_chance {
                    return;
                }
                true
            }
            ACT_DOUBLE => {
                ofs.atk = 1;
                true
            }
            ACT_TRIPLE => {
                ofs.atk = 2;
                true
            }
            ACT_TSS => {
                ofs.atk = 2 + btb_bonus;
                true
            }
            ACT_QUAD | ACT_TSD => {
                ofs.atk = 4 + btb_bonus;
                true
            }
            ACT_TST => {
                ofs.atk = 6 + btb_bonus;
                true
            }
            ACT_TSM => {
                if btb_bonus == 1 {
                    ofs.atk = 1;
                    true
                } else {
                    return;
                }
            }
            ACT_PC => return,
            _ => true,
        };

        if act1 == ACT_NONE {
            ofs.atk += btb_bonus;
            ofs.near_offset = true;
        }
        if !compute {
            return;
        }
        ofs.center4_height = column_heights[3].max(column_heights[4]).max(column_heights[5]).max(column_heights[6]);
        ofs.can_wait_garbage = true;
    }

    /// `OffsetOffAI.ResetOpponentsAtk` (IL 13969).
    pub fn reset_opponents_atk(&mut self) {
        self.gb_data.opponents_atk = 0;
    }

    /// `OffsetOffAI.CalcOpponentsAtk` (IL 13974).
    pub fn calc_opponents_atk(&mut self, line: i32, btb: i32, btb_buff: i32, combo: i32) {
        if self.use_offset_off && line > 1 && btb != 0 && combo <= 4 {
            self.gb_data.opponents_atk =
                (if line == 4 { 4 } else { line * 2 }) + btb_buff + (if combo > 2 { 1 } else { 0 });
        }
    }

    /// `OffsetOffAI.GetOpponentsAtk` (IL 13994).
    pub fn get_opponents_atk(&self) -> i32 {
        self.gb_data.opponents_atk
    }

    /// `OffsetOffAI.SetPrevAct` (IL 13999) -> `gbData.remainingTime`.
    pub fn set_prev_act(&mut self, act: i32) {
        self.gb_data.remaining_time = match act {
            ACT_NONE => 0,
            ACT_SINGLE | ACT_TSS | ACT_TSM => 15,
            ACT_DOUBLE | ACT_TRIPLE | ACT_TSD | ACT_TST => 10,
            ACT_QUAD => 5,
            ACT_PC => 21,
            _ => 0,
        };
    }

    /// `OffsetOffAI.LockOffsetAfterClearing` (IL 14029).
    pub fn lock_offset_after_clearing(&mut self, frame: i32, sending_garbage: i32, lock: i32) {
        let gb = &mut self.gb_data;
        if gb.remaining_time > 0 {
            gb.cool_time = frame + gb.remaining_time;
            if sending_garbage <= 0 {
                gb.cool_time += 24;
            }
            gb.opponents_lock_count = lock;
            gb.first_invalid_lock = true;
            gb.opponents_atk = -1;
        }
    }

    /// `OffsetOffAI.OpponentIsNewLockDown` (IL 14045).
    pub fn opponent_is_new_lock_down(&mut self, lock: i32) -> bool {
        let is_new = self.gb_data.opponents_lock_count != lock;
        self.gb_data.opponents_lock_count = lock;
        is_new
    }

    /// `OffsetOffAI.InvalidateGettingEnemysAtk` (IL 14052).
    pub fn invalidate_getting_enemys_atk(&mut self) {
        self.gb_data.opponents_atk = -1;
    }

    /// `OffsetOffAI.IsLocked` (IL 14058).
    pub fn is_locked(&self, frame: i32) -> bool {
        self.gb_data.cool_time > frame
    }

    /// `OffsetOffAI.IsFirstInvalidLockDown` (IL 14064): consuming.
    pub fn is_first_invalid_lock_down(&mut self) -> bool {
        let first = self.gb_data.first_invalid_lock;
        self.gb_data.first_invalid_lock = false;
        first
    }
}

#[cfg(test)]
mod tests;
