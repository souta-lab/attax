    use super::*;

    #[test]
    fn set_prev_act_table() {
        let mut ai = OffsetOffAI::new(true);
        for (act, want) in [
            (ACT_NONE, 0),
            (ACT_SINGLE, 15),
            (ACT_TSS, 15),
            (ACT_TSM, 15),
            (ACT_DOUBLE, 10),
            (ACT_TRIPLE, 10),
            (ACT_TSD, 10),
            (ACT_TST, 10),
            (ACT_QUAD, 5),
            (ACT_PC, 21),
            (99, 0),
        ] {
            ai.set_prev_act(act);
            assert_eq!(ai.gb_data.remaining_time, want, "act {act}");
        }
    }

    #[test]
    fn calc_opponents_atk_golden() {
        let mut ai = OffsetOffAI::new(true);
        ai.calc_opponents_atk(4, 1, 1, 3);
        assert_eq!(ai.get_opponents_atk(), 6);
        ai.calc_opponents_atk(3, 1, 1, 3);
        assert_eq!(ai.get_opponents_atk(), 8);
        ai.calc_opponents_atk(4, 0, 1, 0);
        assert_eq!(ai.get_opponents_atk(), 8);
        ai.calc_opponents_atk(2, 1, 0, 5);
        assert_eq!(ai.get_opponents_atk(), 8);
    }

    #[test]
    fn lock_and_invalid_consuming() {
        let mut ai = OffsetOffAI::new(true);
        ai.set_prev_act(ACT_DOUBLE);
        ai.lock_offset_after_clearing(100, 0, 7);
        assert_eq!(ai.gb_data.cool_time, 100 + 10 + 24);
        assert_eq!(ai.gb_data.opponents_lock_count, 7);
        assert_eq!(ai.get_opponents_atk(), -1);
        assert!(ai.is_first_invalid_lock_down());
        assert!(!ai.is_first_invalid_lock_down());
        assert!(ai.is_locked(120));
        assert!(!ai.is_locked(140));
    }

    #[test]
    fn opponent_is_new_lock_down_tracks() {
        let mut ai = OffsetOffAI::new(true);
        assert!(ai.opponent_is_new_lock_down(5));
        assert!(!ai.opponent_is_new_lock_down(5));
        assert!(ai.opponent_is_new_lock_down(6));
    }

    #[test]
    fn compute_decision_near_offset_quad() {
        let mut ai = OffsetOffAI::new(true);
        let mut next = NextMino::default();
        next.m[2] = 7;
        let ch = [0, 0, 0, 2, 5, 3, 4, 0, 0, 0];
        ai.compute_decision(&[ACT_NONE, ACT_NONE, ACT_QUAD], 10, 7, &next, 1, true, &ch);
        assert!(ai.ofs_data.can_wait_garbage);
        assert!(ai.ofs_data.near_offset);
        assert_eq!(ai.ofs_data.atk, 5);
        assert_eq!(ai.ofs_data.center4_height, 5);
        assert!(ai.can_offset_off(4, true));
    }

    #[test]
    fn driver_decide_waits_on_near_quad() {
        use crate::board::Board;
        use crate::nextmino::NextMino;
        use crate::offset_driver::{HoikoOffsetDriver, OffsetDecisionInput};
        use crate::shapes::{ACT_NONE, ACT_QUAD};

        let mut d = HoikoOffsetDriver::new(true);
        let board = Board::default();
        let mut next = NextMino::default();
        next.trust_end = 3;
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
        assert!(d.offset.ofs_data.can_wait_garbage);
        assert_eq!(d.offset.ofs_data.atk, 4);
    }
