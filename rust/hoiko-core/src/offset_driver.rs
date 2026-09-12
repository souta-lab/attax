//! Per-fighter `OffsetOffAI` driver — faithful port of
//! `src/ai/hoiko-offset-driver.ts` (binary `ObserveOpponent` flow + the
//! input-wait lambda). It owns the mutable `OffsetOffAI` state and the
//! lock-change bookkeeping.
//!
//! Frame clock: `nowMs * 0.06` maps wall-clock ms to game frames (16.67 ms each).

use crate::board::Board;
use crate::nextmino::NextMino;
use crate::offset::OffsetOffAI;
use crate::shapes::{
    ACT_DOUBLE, ACT_NONE, ACT_PC, ACT_QUAD, ACT_SINGLE, ACT_TRIPLE, ACT_TSD, ACT_TSM, ACT_TSS,
    ACT_TST,
};

pub const GAME_FRAMES_PER_MS: f64 = 0.06;

#[derive(Clone, Copy, Default, PartialEq, Eq)]
pub enum LockAction {
    #[default]
    None,
    Single,
    Double,
    Triple,
    Quad,
    Tss,
    Tsd,
    Tst,
    Tsm,
    Pc,
}

pub fn act_from_lock_action(action: LockAction) -> i32 {
    match action {
        LockAction::None => ACT_NONE,
        LockAction::Single => ACT_SINGLE,
        LockAction::Double => ACT_DOUBLE,
        LockAction::Triple => ACT_TRIPLE,
        LockAction::Quad => ACT_QUAD,
        LockAction::Tss => ACT_TSS,
        LockAction::Tsd => ACT_TSD,
        LockAction::Tst => ACT_TST,
        LockAction::Tsm => ACT_TSM,
        LockAction::Pc => ACT_PC,
    }
}

#[derive(Clone, Copy, Default)]
pub struct DriverSnapshot {
    pub lock_id: i32,
    pub last_action: LockAction,
    pub last_attack: i32,
    pub opponent_lock_id: Option<i32>,
    pub opponent_last_clear_lines: i32,
    pub opponent_last_native_btb: i32,
    pub opponent_last_native_combo: i32,
}

pub struct OffsetDecisionInput<'a> {
    pub plan_acts: &'a [i32],
    pub depth: i32,
    pub hold: i32,
    pub next: Option<&'a NextMino>,
    pub btb: i32,
    pub is_even_board: bool,
    pub board: &'a Board,
    pub pending_garbage: i32,
}

pub struct HoikoOffsetDriver {
    pub offset: OffsetOffAI,
    pub enabled: bool,
    pub last_own_lock_id: Option<i32>,
    pub last_opponent_lock_id: Option<i32>,
}

impl HoikoOffsetDriver {
    pub fn new(use_offset_off: bool) -> Self {
        Self {
            offset: OffsetOffAI::new(use_offset_off),
            enabled: use_offset_off,
            last_own_lock_id: None,
            last_opponent_lock_id: None,
        }
    }

    pub fn from_state(
        offset: OffsetOffAI,
        enabled: bool,
        last_own_lock_id: Option<i32>,
        last_opponent_lock_id: Option<i32>,
    ) -> Self {
        Self { offset, enabled, last_own_lock_id, last_opponent_lock_id }
    }

    fn frame(now_ms: f64) -> i32 {
        (now_ms * GAME_FRAMES_PER_MS).trunc() as i32
    }

    /// Apply own/opponent lock-change events observed on this snapshot.
    pub fn sync(&mut self, s: &DriverSnapshot, now_ms: f64) {
        let frame = Self::frame(now_ms);
        if let Some(last_own) = self.last_own_lock_id {
            if s.lock_id < last_own {
                self.offset.set_use_offset_off(self.enabled);
                self.last_own_lock_id = None;
                self.last_opponent_lock_id = None;
            }
        }
        if let Some(last_own) = self.last_own_lock_id {
            if s.lock_id != last_own {
                self.offset.set_prev_act(act_from_lock_action(s.last_action));
                // Binary call-site arg 3 is `GetNextCount(opponent)` (the opponent's
                // draw cursor), not our own lock id: IL 3150-3152.
                self.offset.lock_offset_after_clearing(
                    frame,
                    s.last_attack,
                    s.opponent_lock_id.unwrap_or(0),
                );
            }
        }
        self.last_own_lock_id = Some(s.lock_id);

        if let Some(opponent_lock_id) = s.opponent_lock_id {
            if Some(opponent_lock_id) != self.last_opponent_lock_id {
                if self.offset.opponent_is_new_lock_down(opponent_lock_id) {
                    self.offset.reset_opponents_atk();
                }
                let lines = s.opponent_last_clear_lines;
                if lines > 0 && self.offset.get_opponents_atk() == 0 {
                    if !self.offset.is_first_invalid_lock_down() {
                        if !self.offset.is_locked(frame) {
                            let opponent_btb = s.opponent_last_native_btb;
                            self.offset.calc_opponents_atk(
                                lines,
                                if opponent_btb > 0 { 1 } else { 0 },
                                if opponent_btb > 1 { 1 } else { 0 },
                                s.opponent_last_native_combo,
                            );
                        }
                    } else {
                        self.offset.invalidate_getting_enemys_atk();
                    }
                }
                self.last_opponent_lock_id = Some(opponent_lock_id);
            }
        }
    }

    /// Run `DecisionOffsetOff` over the line and answer the wait gate.
    pub fn decide(&mut self, input: &OffsetDecisionInput, now_ms: f64) -> bool {
        if !self.enabled {
            return false;
        }
        // `DecisionOffsetOff` seeds the native `Int32Array` with -1 and
        // `Board.GetColumnHeight` adds into it (IL 13943-13954), so the port must
        // use the -1-filling wrapper, not `get_column_height_zeroed`.
        let mut column_heights = [0i32; 10];
        input.board.get_column_height(&mut column_heights);
        if let Some(next) = input.next {
            self.offset.compute_decision(
                input.plan_acts,
                input.depth,
                input.hold,
                next,
                input.btb,
                input.is_even_board,
                &column_heights,
            );
        }
        !self.offset.is_locked(Self::frame(now_ms))
            && self.offset.can_offset_off(input.pending_garbage, input.is_even_board)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn own_lock_change_sets_cool_time() {
        let mut d = HoikoOffsetDriver::new(true);
        d.sync(
            &DriverSnapshot { lock_id: 1, ..Default::default() },
            0.0,
        );
        assert_eq!(d.last_own_lock_id, Some(1));
        d.sync(
            &DriverSnapshot {
                lock_id: 2,
                last_action: LockAction::Double,
                last_attack: 0,
                opponent_lock_id: Some(5),
                ..Default::default()
            },
            0.0,
        );
        assert_eq!(d.offset.gb_data.remaining_time, 10);
        assert_eq!(d.offset.gb_data.cool_time, 10 + 24);
        assert_eq!(d.offset.gb_data.opponents_lock_count, 5);
        assert!(d.offset.gb_data.first_invalid_lock);
        assert_eq!(d.offset.get_opponents_atk(), -1);
    }

    #[test]
    fn lock_id_regression_resets_driver() {
        let mut d = HoikoOffsetDriver::new(true);
        d.sync(&DriverSnapshot { lock_id: 5, ..Default::default() }, 0.0);
        d.sync(
            &DriverSnapshot {
                lock_id: 6,
                last_action: LockAction::Quad,
                last_attack: 1,
                ..Default::default()
            },
            0.0,
        );
        assert!(d.offset.get_opponents_atk() == -1);
        d.sync(&DriverSnapshot { lock_id: 0, ..Default::default() }, 0.0);
        assert_eq!(d.offset.gb_data.cool_time, 0);
        assert_eq!(d.offset.get_opponents_atk(), 0);
        assert_eq!(d.last_own_lock_id, Some(0));
        assert_eq!(d.last_opponent_lock_id, None);
    }

    #[test]
    fn opponent_clear_sets_atk() {
        let mut d = HoikoOffsetDriver::new(true);
        d.sync(
            &DriverSnapshot {
                lock_id: 1,
                opponent_lock_id: Some(10),
                opponent_last_clear_lines: 4,
                opponent_last_native_btb: 1,
                opponent_last_native_combo: 0,
                ..Default::default()
            },
            0.0,
        );
        assert_eq!(d.offset.get_opponents_atk(), 4);
        assert_eq!(d.last_opponent_lock_id, Some(10));
    }

    /// Binary `DecisionOffsetOff` seeds the height array with -1 before
    /// `Board.GetColumnHeight` (IL 13943); the zero-seeded variant reports
    /// center4 one higher. Board/expected values from the exe differential
    /// (evidence/hoiko-fullgame/garbage/smoke-divergence-seed1-turn14).
    #[test]
    fn decide_uses_minus_one_seeded_column_heights() {
        let mut d = HoikoOffsetDriver::new(true);
        let mut board = Board::default();
        board.line[0] = 1015;
        board.line[1] = 995;
        board.line[2] = 487;
        board.line[3] = 231;
        board.line[4] = 227;
        board.line[5] = 231;
        board.update_max_height();
        let next = NextMino::default();
        let input = OffsetDecisionInput {
            plan_acts: &[ACT_NONE, ACT_NONE, ACT_QUAD],
            depth: 10,
            hold: 7,
            next: Some(&next),
            btb: 0,
            is_even_board: true,
            board: &board,
            pending_garbage: 4,
        };
        assert!(d.decide(&input, 0.0));
        assert_eq!(d.offset.ofs_data.center4_height, 5);
    }

    #[test]
    fn decide_disabled_is_false() {
        let mut d = HoikoOffsetDriver::new(false);
        let board = Board::default();
        let next = NextMino::default();
        let input = OffsetDecisionInput {
            plan_acts: &[0],
            depth: 10,
            hold: 7,
            next: Some(&next),
            btb: 0,
            is_even_board: true,
            board: &board,
            pending_garbage: 0,
        };
        assert!(!d.decide(&input, 0.0));
    }
}
