    use super::*;
    use crate::search::default_search_state;

    fn base_input() -> HSearchInput {
        let st = default_search_state();
        HSearchInput {
            nexus: [0.0; MAX_WEIGHTS],
            weight: [[0; 50]; MAX_WEIGHTS],
            column: [[0; 10]; MAX_WEIGHTS],
            combo_table: [[0; 5]; MAX_WEIGHTS],
            weight_count: 1,
            board: [0; 32],
            current: crate::shapes::MINO_I,
            next: [7; 28],
            hold: 7,
            combo: 0,
            btb: 0,
            is_even_board: 1,
            use_s4w: 0,
            view_next: 2,
            allow_hold: 0,
            weight_index: 0,
            min_depth: st.min_depth,
            depth_limit: 10,
            beam_size_limit: st.beam_size_limit,
            max_beam_size: st.max_beam_size,
            timer_limit_ms: st.timer_limit_ms,
            time_limit_ms: st.timer_limit_ms,
            now_ms: 0,
            adapt: 0,
            offset_enabled: 0,
            pending_garbage: 0,
            use_offset_off: 0,
            ofs_can_wait_garbage: 0,
            ofs_center4_height: 0,
            ofs_atk: 0,
            ofs_pc_chance: 0,
            ofs_near_offset: 0,
            gb_opponents_atk: 0,
            gb_cool_time: 0,
            gb_remaining_time: 0,
            gb_opponents_lock_count: 0,
            gb_first_invalid_lock: 0,
            has_last_own_lock: 0,
            last_own_lock_id: 0,
            has_last_opp_lock: 0,
            last_opp_lock_id: 0,
            sync_enabled: 0,
            sync_lock_id: 0,
            sync_last_action: 0,
            sync_last_attack: 0,
            sync_has_opp_lock: 0,
            sync_opp_lock_id: 0,
            sync_opp_clear_lines: 0,
            sync_opp_btb: 0,
            sync_opp_combo: 0,
            sync_now_ms: 0,
        }
    }

    fn zero_out() -> HSearchOutput {
        HSearchOutput {
            over_time: 0.0,
            ok: 0,
            x: 0,
            rotation: 0,
            y: 0,
            last_srs: 0,
            use_hold: 0,
            first_r_raw: 0,
            first_m: 0,
            first_act: 0,
            move_delay: 0,
            plan_acts: [0; MAX_PLAN_ACTS],
            plan_len: 0,
            score: 0,
            depth: 0,
            node: 0,
            garbage_wait: 0,
            max_beam_size: 0,
            beam_size_limit: 0,
            timer_limit_ms: 0,
            weight_index: 0,
            use_offset_off: 0,
            ofs_can_wait_garbage: 0,
            ofs_center4_height: 0,
            ofs_atk: 0,
            ofs_pc_chance: 0,
            ofs_near_offset: 0,
            gb_opponents_atk: 0,
            gb_cool_time: 0,
            gb_remaining_time: 0,
            gb_opponents_lock_count: 0,
            gb_first_invalid_lock: 0,
            has_last_own_lock: 0,
            last_own_lock_id: 0,
            has_last_opp_lock: 0,
            last_opp_lock_id: 0,
        }
    }

    #[test]
    fn ffi_runs_and_reports_move() {
        let input = base_input();
        let mut out = zero_out();
        assert_eq!(run_search_ffi(&input, &mut out), 1);
        assert_eq!(out.ok, 1);
        assert_eq!(out.depth, 10);
        assert_eq!(out.plan_len, 10);
        assert_eq!(out.weight_index, 0);
        assert!(out.x >= -2 && out.x <= 9);
    }

    #[test]
    fn ffi_offset_disabled_wait_false() {
        let mut input = base_input();
        input.offset_enabled = 0;
        let mut out = zero_out();
        assert_eq!(run_search_ffi(&input, &mut out), 1);
        assert_eq!(out.garbage_wait, 0);
    }
