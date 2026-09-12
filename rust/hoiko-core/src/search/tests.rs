    use super::*;
    use crate::probe::{build_root, ProbeInput};
    use crate::probe_trace::search_trace;
    use crate::shapes::{ACT_NONE, ACT_PC, MINO_I, MINO_L, MINO_NONE, MINO_O, MINO_S, MINO_T, MINO_Z};

    const WE_WEIGHT: [i32; 50] = [
        -15, -30, -100, -4, -25, -10, -15, -50, -120, -70, 10, 10, 5, 0, 30, 1000, 2, 30, 5, 5,
        35, -30, 15, 15, 35, 10, -100, 60, 20, -3, 10, 10, -100, -100, -350, -300, -250, 200, 50,
        300, 500, 50, 1500, 50, 0, 250, 50, 0, 0, 0,
    ];
    const WE_COLUMN: [i32; 10] = [-50, -70, -10, 0, 0, 0, 0, -10, -70, -50];
    const WE_COMBO: [i32; 5] = [180, 360, 540, 900, 1080];

    fn we() -> HoikoWeights {
        HoikoWeights { weight: WE_WEIGHT, column: WE_COLUMN, combo_table: WE_COMBO, nexus: 0.5 }
    }

    fn input(board: Vec<i32>, current: i32, queue: Vec<i32>) -> ProbeInput {
        ProbeInput {
            board,
            current,
            queue,
            hold: MINO_NONE,
            combo: 0,
            btb: 0,
            view_next: 2,
            weight_index: 0,
            is_even: true,
            use_s4w: false,
            trust_rate: 1.0,
        }
    }

    fn fixed_now() -> impl Fn() -> f64 {
        || 0.0
    }

    #[test]
    fn delay_table() {
        assert_eq!(get_delay(0, ACT_NONE), 0);
        assert_eq!(get_delay(100, 1), 36 * 16 + 100);
        assert_eq!(get_delay(100, 7), 41 * 16 + 100);
        assert_eq!(get_delay(100, 4), 46 * 16 + 100);
        assert_eq!(get_delay(100, ACT_PC), 16 + 100);
    }

    #[test]
    fn set_next_option_first_call_is_inert() {
        // over_time = -1000 (constant clock) => neither branch fires; timer is
        // recomputed from the first move (moveDelay=112, act=NONE).
        let mut st = SearchState::default();
        set_next_option(&mut st, -1000.0, 14, 112, ACT_NONE, true);
        assert_eq!(st.timer_limit_ms, 112 - TAKE_OVER_TIME);
        assert_eq!(st.beam_size_limit, (50 * 107) / 112);
        assert_eq!(st.depth_limit, 14);
    }

    #[test]
    fn search_golden_empty_d10_no_hold() {
        let root = build_root(&input(
            vec![],
            MINO_I,
            vec![MINO_O, MINO_T, MINO_S, MINO_Z, MINO_L],
        ));
        let mut st = SearchState::default();
        st.depth_limit = 10;
        let now = fixed_now();
        let out = run_search(&mut st, &root, &[we()], true, false, 2, &now, Some(1000), false)
            .expect("move");
        let expected = (0, 0, MINO_I, false, ACT_NONE, 10, 27439, 202);
        assert_eq!(
            (
                out.first_x,
                out.first_placement.rotation,
                out.first_m,
                out.first_hold,
                out.first_act,
                out.depth,
                out.node,
                out.move_delay,
            ),
            expected
        );
    }

    #[test]
    fn search_golden_empty_d14_with_hold() {
        let root = build_root(&input(
            vec![],
            MINO_I,
            vec![MINO_O, MINO_T, MINO_S, MINO_Z, MINO_L],
        ));
        let mut st = SearchState::default();
        let now = fixed_now();
        let out = run_search(&mut st, &root, &[we()], true, false, 2, &now, Some(1000), true)
            .expect("move");
        let expected = (3, 0, MINO_I, false, ACT_NONE, 14, 71624, 112);
        assert_eq!(
            (
                out.first_x,
                out.first_placement.rotation,
                out.first_m,
                out.first_hold,
                out.first_act,
                out.depth,
                out.node,
                out.move_delay,
            ),
            expected
        );
    }

    /// Turn-183 snapshot (seed 1) from `evidence/hoiko-fullgame/eval-turn183`,
    /// the first full-game divergence. The exe picks x=7 r=2 m=2 (depth 14,
    /// nodeCount 64174) and E4 proved the exe's `std::partial_sort` cutoff applied
    /// to these evaluations reproduces it; a stable score/index selection picks
    /// x=7 r=0, score 716, nodes 63854. Locks `run_search` to the exe's beam
    /// policy and to the verified `probe_trace` reference in one assertion.
    #[test]
    fn beam_cutoff_matches_exe_on_turn183_divergence() {
        let mut board = vec![0x3f7, 0x3f7, 0x3e3, 0x3c0, 0x1c0];
        board.extend(std::iter::repeat_n(0, 27));
        let mut queue = vec![0, 1, 5, 6, 5, 2, 0];
        queue.extend(std::iter::repeat_n(7, 20));
        let root = build_root(&ProbeInput {
            board,
            current: MINO_L,
            queue,
            hold: MINO_T,
            combo: 0,
            btb: 24,
            view_next: 2,
            weight_index: 0,
            is_even: true,
            use_s4w: false,
            trust_rate: 1.0,
        });
        let now = fixed_now();
        let mut st = SearchState::default();
        let out =
            run_search(&mut st, &root, &[we()], true, false, 2, &now, Some(1000), true).expect("move");
        assert_eq!(
            (
                out.first_x,
                out.first_r,
                out.first_m,
                out.score,
                out.depth,
                out.node,
            ),
            (7, 2, 2, 79, 14, 64174)
        );

        let mut st2 = SearchState::default();
        let tr = search_trace(&mut st2, &root, &[we()], true, false, 2, true, 1).expect("trace");
        assert_eq!(
            (tr.first_x, tr.first_r, tr.first_m, tr.score, tr.depth, tr.nodes),
            (
                out.first_x,
                out.first_r,
                out.first_m,
                out.score,
                out.depth,
                out.node,
            )
        );
    }
