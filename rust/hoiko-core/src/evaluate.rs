//! Native EvaluateAI core — faithful port of `src/ai/native/evaluate.ts`
//! (SPEC_EvaluateAI §7): GetContBonus, GetFinalAction, TransitionWeight,
//! Evaluate, EvaluateFirst.

pub mod dtcannon;
pub mod pc;
pub mod terms;
pub mod trust;
pub mod tsd;
pub mod tst;

use crate::board::Board;
use crate::gamepack::GamePack;
use crate::shapes::{
    ACT_DOUBLE, ACT_NONE, ACT_PC, ACT_QUAD, ACT_SINGLE, ACT_TRIPLE, ACT_TSD, ACT_TSM, ACT_TSS,
    ACT_TST, MINO_I, MINO_T,
};
use crate::weight_index::{
    combo_at, weight_at, WI_BTB, WI_COMBO_BTB, WI_COMBO_DEBT, WI_DOUBLE, WI_HOLD_I, WI_HOLD_T,
    WI_MOVE_DELAY, WI_PC, WI_QUAD, WI_SINGLE, WI_TRIPLE, WI_TSD, WI_TSS, WI_TST, WI_WASTE_I,
    WI_WASTE_T,
};
use crate::weights::HoikoWeights;

pub const DEFAULT_IS_EVEN_BOARD: bool = true;
pub const DEFAULT_VIEW_NEXT: i32 = 2;

/// Versus-only opponent-aware statics the binary maintains in
/// `PPT2AI.ObserveOpponent` / `EvaluateAI` (IL 4687-4693). All false/0 in
/// solo (`EvaluateAI.ReadConfig`, IL 11045-11047).
#[derive(Clone, Copy, Default)]
pub struct VsFlags {
    pub multi_evaluation: bool,
    pub opponent_is_pc_board: bool,
    pub opponent_is_powerful_board: bool,
    pub opponents_combo: i32,
}

#[derive(Clone, Copy)]
pub struct EvalFlags {
    pub is_even_board: bool,
    pub use_s4w: bool,
    pub use_pcstack: bool,
    pub vs: VsFlags,
}

impl Default for EvalFlags {
    fn default() -> Self {
        Self {
            is_even_board: DEFAULT_IS_EVEN_BOARD,
            use_s4w: false,
            use_pcstack: false,
            vs: VsFlags::default(),
        }
    }
}

fn w(ew: &HoikoWeights, i: usize) -> i32 {
    weight_at(ew, i)
}

pub fn get_cont_bonus(g: &GamePack, ew: &HoikoWeights) -> i32 {
    let mut score = 0;
    if g.hold.m == MINO_I {
        score += w(ew, WI_HOLD_I);
    } else if g.hold.m == MINO_T {
        score += w(ew, WI_HOLD_T);
    }
    if g.btb > 0 {
        score += w(ew, WI_BTB);
    }
    score
}

/// `GetFinalAction` (binary 13099) — Pc returns immediately (SPEC §8 #8).
pub fn get_final_action(g: &GamePack, ew: &HoikoWeights, weight_index: i32) -> i32 {
    let mut score = (g.commands.move_delay >> 4) * w(ew, WI_MOVE_DELAY);
    let locked = g.locked_mino.m;
    match g.act {
        ACT_NONE => {
            if locked == MINO_T {
                score += w(ew, WI_WASTE_T);
            } else if locked == MINO_I {
                score += w(ew, WI_WASTE_I);
            }
            score += g.combo * w(ew, WI_COMBO_DEBT);
            return score;
        }
        ACT_SINGLE => score += w(ew, WI_SINGLE),
        ACT_DOUBLE => score += w(ew, WI_DOUBLE),
        ACT_TRIPLE => score += w(ew, WI_TRIPLE),
        ACT_QUAD => score += w(ew, WI_QUAD),
        ACT_TSS => score += w(ew, WI_TSS),
        ACT_TSD => score += w(ew, WI_TSD),
        ACT_TST => score += w(ew, WI_TST),
        ACT_TSM => {
            score += w(ew, WI_SINGLE) + w(ew, WI_WASTE_T);
            score += -w(ew, WI_BTB);
        }
        ACT_PC => {
            score += w(ew, WI_PC);
            score += (g.commands.move_delay >> 5) * -w(ew, WI_MOVE_DELAY);
            if g.btb == 0 {
                if locked == MINO_T {
                    score += w(ew, WI_WASTE_T);
                } else if locked == MINO_I {
                    score += w(ew, WI_WASTE_I);
                }
            } else {
                score += w(ew, WI_COMBO_BTB);
            }
            return score;
        }
        _ => {}
    }
    if g.btb == 0 {
        if locked == MINO_T {
            score += w(ew, WI_WASTE_T);
        } else if locked == MINO_I {
            score += w(ew, WI_WASTE_I);
        }
    } else if g.btb > 1 {
        score += w(ew, WI_COMBO_BTB);
        if g.combo > 1 {
            score += w(ew, WI_COMBO_BTB);
        }
    }
    score += w(ew, WI_COMBO_DEBT);
    let cmb = g.combo;
    if (3..=4).contains(&cmb) {
        score += combo_at(ew, 0);
    } else if (5..=6).contains(&cmb) {
        score += combo_at(ew, 1);
    } else if (7..=8).contains(&cmb) {
        score += combo_at(ew, 2);
    } else if (9..=11).contains(&cmb) {
        score += combo_at(ew, 3);
    } else if cmb >= 12 {
        score += combo_at(ew, 4);
    }
    if weight_index >= 2 {
        let mut atk = 0;
        match g.act {
            ACT_DOUBLE => atk = 1,
            ACT_TRIPLE | ACT_TSS => atk = 2,
            ACT_TSD | ACT_QUAD => atk = 4,
            ACT_TST => atk = 6,
            _ => {}
        }
        if g.btb > 1 {
            atk += 1;
        }
        if atk > 0 {
            score += combo_at(ew, (atk.min(5) - 1) as usize);
        }
    }
    score
}

#[derive(Clone, Copy)]
pub struct EvalOut {
    pub score: i32,
    pub family_score: i32,
}

/// `EvaluateAI.Evaluate` (binary 11066).
pub fn evaluate(
    g: &GamePack,
    ew: &HoikoWeights,
    weight_index: i32,
    flags: EvalFlags,
    trust_rate: f64,
) -> EvalOut {
    let mut ch = [0i32; 10];
    let min_height = terms::build_column_height(&g.board, &mut ch);
    let mut board = terms::get_height(&g.board, &ch, ew);
    let well = terms::get_well_column(&g.board, &ch, min_height, ew);
    board += well.score;
    board += terms::get_up_down(&ch, well.well_column, well.well_depth, ew);
    board += terms::get_underground(&g.board, &ch, min_height, ew);
    let y0 = well.well_depth + min_height;
    board += terms::get_resource(
        g,
        &ch,
        min_height,
        ew,
        flags.use_s4w,
        flags.vs.opponent_is_powerful_board,
    );
    board += terms::get_ground(g, &ch, y0, ew);
    board += tsd::search_tsd(g, &ch, y0, ew);
    board += tst::search_tst(g, &ch, y0, min_height, ew);
    board += pc::search_pc_board(g, min_height, ew, flags.is_even_board, flags.use_pcstack);
    board += get_cont_bonus(g, ew);
    let action = get_final_action(g, ew, weight_index);
    let family_score = ((ew.nexus * board as f64) as i32 + action) as f64 * trust_rate;
    let score = (action + board) as f64 * trust_rate;
    EvalOut { family_score: family_score as i32, score: score as i32 }
}

/// `EvaluateAI.EvaluateFirst` (binary 11098).
pub fn evaluate_first(g: &GamePack, ew: &HoikoWeights, weight_index: i32, flags: EvalFlags) -> EvalOut {
    let mut ch = [0i32; 10];
    let min_height = terms::build_column_height(&g.board, &mut ch);
    let mut board = terms::get_height(&g.board, &ch, ew);
    board += pc::search_pc_board(g, min_height, ew, flags.is_even_board, flags.use_pcstack);
    board += get_cont_bonus(g, ew);
    let family_score = get_final_action(g, ew, weight_index) + (board as f64 * ew.nexus) as i32;
    EvalOut { family_score, score: family_score }
}

/// `EvaluateAI.TransitionWeight.<lambda>` (binary 13571) — the VS weight-family
/// transition. `opponents_combo > 8` sends the search to `weightList[3]`; the
/// `isEvenBoard` branch only considers `weightList[1]` when the opponent is on a
/// PC board (or comboing), matching the versus-only `MultiEvaluation` gate.
pub fn transition_weight(board: &Board, weight_index: i32, flags: EvalFlags) -> i32 {
    let transition_height = if weight_index >= 2 { 13 } else { 15 };
    let mut ch = [0i32; 10];
    let garbage_height = terms::build_column_height(board, &mut ch);
    let c4 = ch[3].max(ch[4]).max(ch[5]).max(ch[6]);
    let sh1 = board.stack_height + 1;
    if c4 + 1 <= transition_height {
        if flags.vs.multi_evaluation && flags.vs.opponents_combo > 8 {
            let threshold = if garbage_height == -1 { 11 } else { -1 };
            if sh1 >= threshold {
                return 3;
            }
        }
        if sh1 >= 11 {
            return 0;
        }
        let pc_branch = if flags.is_even_board {
            flags.vs.multi_evaluation
                && (flags.vs.opponent_is_pc_board || flags.vs.opponents_combo >= 3)
        } else {
            true
        };
        if pc_branch {
            if weight_index == 1 {
                return 1;
            }
            if garbage_height == -1 && sh1 <= 5 {
                return 1;
            }
        }
        return 0;
    }
    if flags.vs.multi_evaluation && flags.vs.opponents_combo > 8 {
        return 3;
    }
    2
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::board::FULL_ROW;
    use crate::nextmino::NextMino;
    use crate::shapes::{MINO_I, MINO_J, MINO_L, MINO_NONE, MINO_O, MINO_S, MINO_T, MINO_Z};
    use std::cell::RefCell;
    use std::rc::Rc;

    const WE_WEIGHT: [i32; 50] = [
        -15, -30, -100, -4, -25, -10, -15, -50, -120, -70, 10, 10, 5, 0, 30, 1000, 2, 30, 5, 5,
        35, -30, 15, 15, 35, 10, -100, 60, 20, -3, 10, 10, -100, -100, -350, -300, -250, 200, 50,
        300, 500, 50, 1500, 50, 0, 250, 50, 0, 0, 0,
    ];
    const WE_COLUMN: [i32; 10] = [-50, -70, -10, 0, 0, 0, 0, -10, -70, -50];
    const WE_COMBO: [i32; 5] = [180, 360, 540, 900, 1080];

    fn we() -> HoikoWeights {
        HoikoWeights {
            weight: WE_WEIGHT,
            column: WE_COLUMN,
            combo_table: WE_COMBO,
            nexus: 0.5,
        }
    }

    fn action(act: i32, locked: i32, combo: i32, btb: i32, delay: i32, wi: i32) -> i32 {
        let mut g = GamePack::default();
        g.act = act;
        g.locked_mino.m = locked;
        g.combo = combo;
        g.btb = btb;
        g.commands.move_delay = delay;
        get_final_action(&g, &we(), wi)
    }

    #[test]
    fn get_final_action_golden() {
        assert_eq!(action(ACT_TSD, MINO_T, 1, 1, 0, 0), 550);
        assert_eq!(action(ACT_PC, MINO_I, 0, 0, 112, 0), 1388);
        assert_eq!(action(ACT_NONE, MINO_I, 2, 0, 0, 0), -100 + 2 * 250);
        assert_eq!(action(ACT_QUAD, 0, 0, 1, 0, 0), 450);
        assert_eq!(action(ACT_TSM, MINO_T, 0, 1, 0, 0), -250);
        assert_eq!(action(ACT_TSD, MINO_T, 1, 1, 0, 2), 1450);
    }

    #[test]
    fn transition_weight_golden() {
        assert_eq!(transition_weight(&Board::default(), 0, EvalFlags::default()), 0);
        let mut b = Board::default();
        for row in b.line.iter_mut().take(10) {
            *row = FULL_ROW;
        }
        b.stack_height = 9;
        assert_eq!(transition_weight(&b, 0, EvalFlags::default()), 0);
    }

    // Values probed from Hoiko.exe v0-beta1 (`multieval`/`oppcombo`/`opppc`/
    // `evenodd` keys): the versus multi-eval branches select weightList[3] on
    // combo>8 with garbage present at any height (IL 13598 `num4 = ??11 : -1`),
    // weightList[1] only when the opponent is on a PC board (or comboing), and
    // the non-even branch unconditionally considers weightList[1].
    #[test]
    fn transition_weight_versus_flags_golden() {
        fn board(rows: &[i32]) -> Board {
            let mut b = Board::default();
            for (y, row) in rows.iter().enumerate() {
                b.line[y] = *row;
            }
            b.update_max_height();
            b
        }
        fn flags(even: bool, multi: bool, pc: bool, combo: i32) -> EvalFlags {
            EvalFlags {
                is_even_board: even,
                vs: VsFlags {
                    multi_evaluation: multi,
                    opponent_is_pc_board: pc,
                    opponents_combo: combo,
                    ..VsFlags::default()
                },
                ..EvalFlags::default()
            }
        }
        let empty = board(&[]);
        assert_eq!(transition_weight(&empty, 0, flags(true, false, false, 9)), 0);
        assert_eq!(transition_weight(&empty, 0, flags(true, true, false, 9)), 1);
        assert_eq!(transition_weight(&empty, 0, flags(true, true, true, 2)), 1);
        assert_eq!(transition_weight(&empty, 0, flags(true, true, false, 2)), 0);
        assert_eq!(transition_weight(&empty, 0, flags(false, true, false, 2)), 1);
        assert_eq!(transition_weight(&board(&[FULL_ROW]), 0, flags(true, true, false, 9)), 3);
        let six = board(&[0x001; 6]);
        assert_eq!(transition_weight(&six, 0, flags(true, true, false, 9)), 0);
        assert_eq!(transition_weight(&board(&[0x3ff, 0x3ff]), 3, flags(true, true, false, 9)), 3);
    }

    fn build_root(
        rows: &[i32],
        current: i32,
        queue: &[i32],
        hold: i32,
        combo: i32,
        btb: i32,
    ) -> GamePack {
        let next = Rc::new(RefCell::new(NextMino::default()));
        next.borrow_mut().view_next = 2;
        let mut real_next = Vec::with_capacity(queue.len() + 1);
        real_next.push(current);
        real_next.extend_from_slice(queue);

        let mut g = GamePack::default();
        for (y, row) in rows.iter().enumerate().take(32) {
            g.board.line[y] = *row;
        }
        g.board.update_max_height();
        g.hold.init();
        g.hold.m = hold;
        g.commands.init();
        g.combo = combo;
        g.btb = btb;
        g.act = ACT_NONE;
        g.falling_mino.init();
        g.locked_mino.init();
        next.borrow_mut().init(&real_next);
        g.set_new_current(&next);
        g
    }

    #[test]
    fn evaluate_built_roots_golden() {
        let empty = build_root(
            &[],
            MINO_I,
            &[MINO_O, MINO_T, MINO_S, MINO_Z, MINO_J, MINO_L, MINO_I, MINO_O],
            MINO_NONE,
            0,
            0,
        );
        let e = evaluate(&empty, &we(), 0, EvalFlags::default(), 1.0);
        assert_eq!((e.family_score, e.score), (0, 0));
        let ef = evaluate_first(&empty, &we(), 0, EvalFlags::default());
        assert_eq!((ef.family_score, ef.score), (0, 0));

        let mid = build_root(
            &[1023, 1023, 0b1100000011, 0b1100000011],
            MINO_T,
            &[MINO_I, MINO_O, MINO_T, MINO_S, MINO_Z, MINO_J, MINO_L],
            MINO_I,
            2,
            1,
        );
        let e = evaluate(&mid, &we(), 0, EvalFlags::default(), 1.0);
        assert_eq!((e.family_score, e.score), (492, 484));
        let ef = evaluate_first(&mid, &we(), 0, EvalFlags::default());
        assert_eq!((ef.family_score, ef.score), (500, 500));
    }

    fn mk(rows: &[i32], stack_height: i32, falling_m: i32, hold_m: i32) -> GamePack {
        let mut g = GamePack::default();
        for (y, row) in rows.iter().enumerate().take(32) {
            g.board.line[y] = *row;
        }
        g.board.stack_height = stack_height;
        g.hold.m = hold_m;
        g.falling_mino.m = falling_m;
        g
    }

    #[test]
    fn search_tsd_and_pc_golden() {
        let flat = mk(&[1023, 1023], 1, MINO_I, MINO_NONE);
        let mut ch = [0i32; 10];
        let g = terms::build_column_height(&flat.board, &mut ch);
        assert_eq!(g, 1);
        assert_eq!(ch, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
        assert_eq!(terms::get_height(&flat.board, &ch, &we()), -30);
        assert_eq!(tsd::search_tsd(&flat, &ch, g, &we()), 0);
        assert_eq!(pc::search_pc_board(&flat, g, &we(), true, false), 0);

        let notch = mk(&[1023, 1023, (1 << 9) | (1 << 7)], 2, MINO_I, MINO_NONE);
        let mut ch = [0i32; 10];
        let g = terms::build_column_height(&notch.board, &mut ch);
        assert_eq!(g, 1);
        assert_eq!(ch, [2, 1, 2, 1, 1, 1, 1, 1, 1, 1]);
        assert_eq!(terms::get_height(&notch.board, &ch, &we()), -45);
        assert_eq!(terms::get_underground(&notch.board, &ch, g, &we()), 0);
        assert_eq!(terms::get_resource(&notch, &ch, g, &we(), false, false), 4);
        let well = terms::get_well_column(&notch.board, &ch, g, &we());
        assert_eq!(terms::get_up_down(&ch, well.well_column, well.well_depth, &we()), -12);
        assert_eq!(tsd::search_tsd(&notch, &ch, well.well_depth + g, &we()), 2);

        let pc_board = mk(
            &[1023 ^ 1, 1023 ^ 1, 1023 ^ 1, 1023 ^ 1],
            3,
            MINO_I,
            MINO_NONE,
        );
        let mut ch = [0i32; 10];
        let g = terms::build_column_height(&pc_board.board, &mut ch);
        assert_eq!(g, -1);
        assert_eq!(ch, [3, 3, 3, 3, 3, 3, 3, 3, 3, -1]);
        assert_eq!(terms::get_height(&pc_board.board, &ch, &we()), -60);
        let well = terms::get_well_column(&pc_board.board, &ch, g, &we());
        assert_eq!((well.score, well.well_column, well.well_depth), (30, 9, 4));
        assert_eq!(terms::get_resource(&pc_board, &ch, g, &we(), false, false), 60);
        assert_eq!(pc::search_pc_board(&pc_board, g, &we(), true, false), 1000);
    }
}

