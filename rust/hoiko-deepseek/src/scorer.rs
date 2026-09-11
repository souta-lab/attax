use crate::board::Board;
use crate::deepseek_score::{
    ds_bump_ex_well, ds_capped, ds_count_holes, ds_count_tslots, ds_emergency, ds_float_well,
    ds_gamma, ds_height_pressure, ds_heights, ds_high, ds_veto, ds_well,
};
use crate::evaluation::{Evaluation, PlyContext};
use crate::features::{FireContext, extract_features, extract_fire_features};
use crate::pieces::PieceKind;
use crate::search::ScoredPlacement;
use crate::weights::{FireWeights, score_fire};

pub const ATK_W: f64 = 142.0;
pub const TSD_EXEC: f64 = 205.0;
pub const TETRIS_EXEC: f64 = 320.0;
pub const TRIPLE_EXEC: f64 = 340.0;
pub const TRIPLE_ARRIVAL: f64 = 220.0;
pub const B2B_CHAIN: f64 = 130.0;
pub const B2B_BREAK: f64 = 120.0;
pub const CAVITY_STEP: f64 = 25.0;
pub const COMBO_KEEP: f64 = 60.0;
pub const COMBO_BREAK: f64 = 60.0;
pub const REN_STEP: f64 = 55.0;
pub const REN_START: i32 = 2;
pub const REN_LATE_STEP: f64 = 110.0;
pub const REN_LATE_N: u32 = 150;
pub const URGENCY_W: f64 = 32.0;
pub const DIG_BONUS: f64 = 145.0;
pub const DIG_HOLD: f64 = 45.0;
pub const EMERG_LINE: f64 = 14.0;
pub const TSD_ARRIVAL: f64 = 340.0;
pub const TETRIS_ARRIVAL: f64 = 460.0;
pub const WELL_PLY_STEP: f64 = 30.0;
pub const TSLOT_KEEP2: f64 = 42.0;
pub const WELL_EDGE_BONUS: f64 = 34.0;
pub const WELL_CENTER_PEN: f64 = 55.0;
pub const TETRIS_READY: f64 = 170.0;
pub const TETRIS_EXEC_DEEP: f64 = 340.0;
pub const TSD_EXEC_DEEP: f64 = 220.0;
pub const WASTED_T_CLEAR: f64 = 150.0;
pub const WASTED_T_IDLE: f64 = 20.0;
pub const WASTED_I_CLEAR: f64 = 110.0;
pub const WASTED_I_IDLE: f64 = 20.0;
pub const BUMP_CAP: f64 = 8.0;
pub const BUMP_STEP: f64 = 22.0;
pub const LATE_PIECE_N: u32 = 60;
pub const LATE_MULT: f64 = 1.15;
pub const HOLE_EXTRA: f64 = 14.0;
pub const OPENING_N: u32 = 30;
pub const READY_DEPTH: usize = 4;
pub const EXECUTE_BONUS: f64 = 420.0;
pub const FILL_PEN: f64 = 80.0;
pub const WELL_FILL_LOSS: f64 = 40.0;
pub const DIG_H20_STEP: f64 = 220.0;
pub const RESERVE_CEIL: f64 = 13.0;
pub const HOLE_DIVE_STEP: f64 = 18.0;
pub const B2B_WEAK_EXTRA: f64 = 60.0;
pub const B2B_TSLOT_EXTRA: f64 = 50.0;
pub const WELL_REBUILD_STEP: f64 = 22.0;
pub const REN_CALM_KEEP: f64 = 30.0;

pub fn combo_bonus(combo: i32) -> f64 {
    if combo <= 1 {
        0.0
    } else if combo <= 3 {
        1.0
    } else if combo <= 5 {
        2.0
    } else if combo <= 7 {
        3.0
    } else if combo <= 10 {
        4.0
    } else {
        5.0
    }
}

pub fn attack_for_clear(
    lines: u32,
    tspin_lines: u32,
    combo: i32,
    b2b_active: bool,
    perfect_clear: bool,
) -> f64 {
    if lines == 0 {
        return 0.0;
    }
    let base = if tspin_lines > 0 {
        match tspin_lines {
            1 => 2.0,
            2 => 4.0,
            3 => 6.0,
            _ => 0.0,
        }
    } else {
        match lines {
            1 => 0.0,
            2 => 1.0,
            3 => 2.0,
            4 => 4.0,
            _ => 0.0,
        }
    };
    let b2b = if b2b_active && (lines == 4 || tspin_lines > 0) {
        1.0
    } else {
        0.0
    };
    let combo_b = combo_bonus(combo);
    let pc = if perfect_clear { 10.0 } else { 0.0 };
    base + b2b + combo_b + pc
}

fn has_i(hold: Option<PieceKind>, can_hold: bool, queue: &[PieceKind]) -> bool {
    if hold == Some(PieceKind::I) && can_hold {
        return true;
    }
    queue.iter().any(|&k| k == PieceKind::I)
}

pub struct DeepSeekScorer {
    opening: bool,
    late: f64,
    i_avail: bool,
    ren_late: bool,
}

impl DeepSeekScorer {
    pub fn new(
        hold: Option<PieceKind>,
        can_hold: bool,
        queue: &[PieceKind],
        pieces: u32,
    ) -> DeepSeekScorer {
        DeepSeekScorer {
            opening: pieces < OPENING_N,
            late: if pieces >= LATE_PIECE_N { LATE_MULT } else { 1.0 },
            i_avail: has_i(hold, can_hold, queue),
            ren_late: pieces >= REN_LATE_N,
        }
    }

    pub fn score(&self, after: &Board, lines: u32, tspin: bool, ctx: &PlyContext) -> f64 {
        let feat = extract_features(after, 0.0, 0.0);
        let ncombo = if lines > 0 { ctx.combo + 1 } else { -1 };
        let atk = attack_for_clear(
            lines,
            if tspin { lines } else { 0 },
            ncombo,
            ctx.b2b,
            feat.max_height == 0.0,
        );
        let h = ds_heights(after);
        let well = ds_well(after, &h, 6);
        let emerg = ds_emergency(ctx.pending, well.global_max);
        let mut s = atk * ATK_W * self.late;
        if tspin && lines > 0 {
            s += TSD_EXEC;
        }
        if lines == 4 {
            s += TETRIS_EXEC;
        }
        if lines == 3 {
            s += TRIPLE_EXEC + TRIPLE_ARRIVAL / (ctx.ply + 1) as f64;
        }
        if (lines == 4 || (tspin && lines > 0)) && ctx.b2b {
            s += B2B_CHAIN;
        }
        if lines > 0 && lines < 4 && !tspin && ctx.b2b && emerg == 0 {
            s -= B2B_BREAK + if lines <= 2 { B2B_WEAK_EXTRA } else { 0.0 };
        }
        if lines == 0 && !tspin && ctx.b2b && ds_count_tslots(after, 1) > 0 {
            s += B2B_TSLOT_EXTRA;
        }
        if ctx.ply == 0 && self.opening {
            s -= feat.holes * HOLE_EXTRA;
        }
        if lines == 0 && !tspin {
            let setups = ds_count_tslots(after, 99);
            if setups > 2 {
                s -= (setups - 2) as f64 * CAVITY_STEP;
            }
            let gamma = ds_gamma(ctx.ply);
            let e_mult = if emerg == 2 {
                0.2
            } else if emerg == 1 {
                0.5
            } else {
                1.0
            };
            let tslots = ds_count_tslots(after, 2).min(2);
            s += tslots as f64 * TSLOT_KEEP2 * gamma * e_mult;
            let depth = well.depth.min(6) as f64;
            s += depth * WELL_PLY_STEP * gamma * e_mult;
            if well.edge {
                if depth > 0.0 {
                    s += WELL_EDGE_BONUS * gamma * e_mult;
                }
            } else if depth > 0.0 {
                s -= WELL_CENTER_PEN * gamma * e_mult;
            }
            let bump = ds_bump_ex_well(&h, well.col);
            if bump > BUMP_CAP {
                s -= (bump - BUMP_CAP) * BUMP_STEP * gamma;
            }
            let float_well = ds_float_well(&h, 6);
            let float_depth = float_well.depth.min(6) as f64;
            if float_well.edge && float_depth > 0.0 && feat.holes > 0.0 {
                s += float_depth * WELL_PLY_STEP * gamma * e_mult;
            }
            let float_ready = float_well.edge
                && float_depth >= READY_DEPTH as f64
                && feat.holes > 0.0
                && well.global_max >= 6.0;
            let ready_depth = depth.max(if float_ready { float_depth } else { 0.0 });
            if emerg == 0 && ready_depth >= READY_DEPTH as f64 && ctx.ply <= 2 && self.i_avail {
                s += TETRIS_READY * gamma;
            }
            if emerg == 0
                && ctx.ply == 0
                && ready_depth >= READY_DEPTH as f64
                && self.i_avail
                && well.max_ex_well <= RESERVE_CEIL
            {
                s += EXECUTE_BONUS;
            }
        }
        if lines > 0 && ctx.ply <= 2 {
            let float_after = ds_float_well(&h, 6);
            if float_after.edge && float_after.depth >= READY_DEPTH && self.i_avail {
                s += float_after.depth as f64 * WELL_REBUILD_STEP;
            }
        }
        if ctx.ply == 0 && lines > 0 && lines < 4 && !tspin {
            let h0 = ds_heights(after);
            let w0 = ds_well(after, &h0, 6);
            if w0.depth >= READY_DEPTH && w0.edge && self.i_avail {
                s -= FILL_PEN + w0.depth as f64 * WELL_FILL_LOSS;
            }
        }
        if lines > 0 && tspin {
            s += TSD_ARRIVAL / (ctx.ply + 1) as f64;
        }
        if lines == 4 {
            s += TETRIS_ARRIVAL / (ctx.ply + 1) as f64;
        }
        if (1..=3).contains(&ctx.ply) {
            if lines == 4 {
                s += TETRIS_EXEC_DEEP;
            }
            if tspin && lines > 0 {
                s += TSD_EXEC_DEEP;
            }
        }
        if lines > 0 && ncombo >= REN_START {
            let ren_step = if self.ren_late { REN_LATE_STEP } else { REN_STEP };
            s += ncombo as f64 * ren_step * self.late;
        }
        if ctx.combo >= 2 && lines > 0 {
            s += COMBO_KEEP;
        } else if ctx.combo >= 2 && lines == 0 && !tspin {
            if ctx.pending == 0 && emerg == 0 && feat.max_height < EMERG_LINE {
                s += REN_CALM_KEEP;
            } else {
                s -= COMBO_BREAK;
            }
        }
        match ctx.piece {
            Some(PieceKind::T) if !(tspin && lines > 0) => {
                s += if lines > 0 { -WASTED_T_CLEAR } else { -WASTED_T_IDLE };
            }
            Some(PieceKind::I) if emerg != 2 && lines != 4 => {
                s += if lines > 0 { -WASTED_I_CLEAR } else { -WASTED_I_IDLE };
            }
            _ => {}
        }
        if emerg > 0 && lines == 0 && !tspin {
            s -= ds_height_pressure(well.max_ex_well);
        }
        if lines == 0 && !tspin && feat.max_height >= 17.0 {
            s -= (feat.max_height - 16.0) * DIG_H20_STEP;
        }
        if lines == 0 && !tspin && well.global_max >= 16.0 {
            let e2 = ds_emergency(ctx.pending, well.max_ex_well);
            if e2 == 2 {
                s -= ds_height_pressure(well.global_max) * 0.5;
            }
        }
        if ctx.pending > 0 {
            if lines > 0 {
                s += ctx.pending as f64 * lines as f64 * URGENCY_W
                    + DIG_BONUS * lines as f64 * if emerg == 2 { 2.0 } else { 1.0 };
                let holes_after = ds_count_holes(after, &h);
                if holes_after <= 5 {
                    s += (6 - holes_after) as f64 * HOLE_DIVE_STEP * lines as f64;
                }
            } else if feat.max_height >= EMERG_LINE {
                s -= ds_height_pressure(feat.max_height);
            } else {
                s -= DIG_HOLD;
            }
        } else if feat.max_height >= EMERG_LINE && lines > 0 {
            let holes_after = ds_count_holes(after, &h);
            if holes_after <= 5 {
                s += (6 - holes_after) as f64 * HOLE_DIVE_STEP * lines as f64;
            }
        }
        s
    }
}

pub struct DeepSeekAdjust {
    seen: u32,
}

impl DeepSeekAdjust {
    pub fn new(seen: u32) -> DeepSeekAdjust {
        DeepSeekAdjust { seen }
    }

    pub fn adjust(&self, after: &Board, _lines: u32, _tspin: bool) -> f64 {
        let h = ds_heights(after);
        let mut adj = -((ds_capped(after, &h) as f64) * 30.0 + (ds_high(after) as f64) * 25.0);
        if self.seen <= OPENING_N {
            adj -= (ds_count_holes(after, &h) as f64) * HOLE_EXTRA;
        }
        adj
    }
}

pub struct DeepSeekVeto {
    pending: i32,
}

impl DeepSeekVeto {
    pub fn new(pending: i32) -> DeepSeekVeto {
        DeepSeekVeto { pending }
    }

    pub fn veto(&self, after: &Board, lines: u32, tspin: bool) -> bool {
        ds_veto(after, lines, self.pending, tspin)
    }
}

pub struct DeepSeekEvaluation<'a> {
    pub scorer: &'a DeepSeekScorer,
    pub adjust: &'a DeepSeekAdjust,
    pub veto: &'a DeepSeekVeto,
}

impl Evaluation for DeepSeekEvaluation<'_> {
    fn rank(
        &self,
        placement: &ScoredPlacement,
        _piece: PieceKind,
        tspin: bool,
        ctx: &PlyContext,
    ) -> f64 {
        placement.score + self.scorer.score(&placement.after, placement.lines_cleared, tspin, ctx)
    }

    fn score(&self, after: &Board, lines: u32, tspin: bool, ctx: &PlyContext) -> f64 {
        self.adjust.adjust(after, lines, tspin) + self.scorer.score(after, lines, tspin, ctx)
    }

    fn veto(&self, after: &Board, lines: u32, tspin: bool) -> bool {
        self.veto.veto(after, lines, tspin)
    }
}

pub fn fire_score(
    lines_cleared: u32,
    tspin: bool,
    b2b_active: bool,
    combo: i32,
    perfect_clear: bool,
    weights: &FireWeights,
) -> f64 {
    score_fire(
        &extract_fire_features(FireContext {
            lines_cleared,
            tspin,
            tspin_lines: if tspin { lines_cleared } else { 0 },
            b2b_active,
            combo,
            perfect_clear,
        }),
        weights,
    )
}
