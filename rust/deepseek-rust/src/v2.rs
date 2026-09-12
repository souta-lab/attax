//! DeepSeek v2 fighter, ported from `src/ai/deepseek-v2.ts` +
//! `src/ai/deepseek-v2-score.ts`.
//!
//! Reproduces the TS v2 decision exactly: kick/tuck-aware ply-0 placement
//! generation, full v2 scorer (garbage defense, opponent attack timing,
//! downstack/burst), v2 weights, and the v2 hard veto. Movement parity is
//! asserted by `tests/v2_parity.rs`.

use crate::beam::{BeamOptions, DEFAULT_WIDTH, PlacementGenerator, beam_best_move_details};
use crate::board::Board;
use crate::deepseek_score::{
    ds_bump_ex_well, ds_count_holes, ds_count_tslots, ds_emergency, ds_float_well, ds_gamma,
    ds_height_pressure, ds_well,
};
use crate::evaluation::{Evaluation, PlyContext};
use crate::features::extract_features;
use crate::kick::enumerate_kick_placements;
use crate::pieces::PieceKind;
use crate::scorer::attack_for_clear;
use crate::search::{ScoredPlacement, enumerate_scored_flat};
use crate::v2_score::{V2OppModel, V2OpponentTelemetry, v2_board_stats, v2_garbage_defense, v2_opponent_model};
use crate::weights::{DEEPSEEK_V2_FIRE, DEEPSEEK_V2_WEIGHTS};

pub const V2_ATK_W: f64 = 142.0;
pub const V2_TSD_EXEC: f64 = 205.0;
pub const V2_TETRIS_EXEC: f64 = 320.0;
pub const V2_TRIPLE_EXEC: f64 = 340.0;
pub const V2_TRIPLE_ARRIVAL: f64 = 220.0;
pub const V2_B2B_CHAIN: f64 = 130.0;
pub const V2_B2B_BREAK: f64 = 120.0;
pub const V2_CAVITY_STEP: f64 = 25.0;
pub const V2_COMBO_KEEP: f64 = 60.0;
pub const V2_COMBO_BREAK: f64 = 60.0;
pub const V2_REN_STEP: f64 = 55.0;
pub const V2_REN_START: i32 = 2;
pub const V2_REN_LATE_STEP: f64 = 110.0;
pub const V2_REN_LATE_N: u32 = 150;
pub const V2_URGENCY_W: f64 = 32.0;
pub const V2_DIG_BONUS: f64 = 145.0;
pub const V2_DIG_HOLD: f64 = 45.0;
pub const V2_EMERG_LINE: f64 = 14.0;
pub const V2_TSD_ARRIVAL: f64 = 340.0;
pub const V2_TETRIS_ARRIVAL: f64 = 460.0;
pub const V2_WELL_PLY_STEP: f64 = 30.0;
pub const V2_TSLOT_KEEP2: f64 = 42.0;
pub const V2_WELL_EDGE_BONUS: f64 = 34.0;
pub const V2_WELL_CENTER_PEN: f64 = 55.0;
pub const V2_TETRIS_READY: f64 = 170.0;
pub const V2_TETRIS_EXEC_DEEP: f64 = 340.0;
pub const V2_TSD_EXEC_DEEP: f64 = 220.0;
pub const V2_WASTED_T_CLEAR: f64 = 150.0;
pub const V2_WASTED_T_IDLE: f64 = 20.0;
pub const V2_WASTED_I_CLEAR: f64 = 110.0;
pub const V2_WASTED_I_IDLE: f64 = 20.0;
pub const V2_BUMP_CAP: f64 = 8.0;
pub const V2_BUMP_STEP: f64 = 22.0;
pub const V2_LATE_PIECE_N: u32 = 60;
pub const V2_LATE_MULT: f64 = 1.15;
pub const V2_HOLE_EXTRA: f64 = 14.0;
pub const V2_OPENING_N: u32 = 30;
pub const V2_READY_DEPTH: usize = 4;
pub const V2_EXECUTE_BONUS: f64 = 420.0;
pub const V2_FILL_PEN: f64 = 80.0;
pub const V2_WELL_FILL_LOSS: f64 = 40.0;
pub const V2_DIG_H20_STEP: f64 = 220.0;
pub const V2_RESERVE_CEIL: f64 = 13.0;
pub const V2_HOLE_DIVE_STEP: f64 = 18.0;
pub const V2_B2B_WEAK_EXTRA: f64 = 60.0;
pub const V2_B2B_TSLOT_EXTRA: f64 = 50.0;
pub const V2_WELL_REBUILD_STEP: f64 = 22.0;
pub const V2_REN_CALM_KEEP: f64 = 30.0;

pub const V2_OPP_DANGER_ATK_W: f64 = 26.0;
pub const V2_BURST_VULN_TETRIS: f64 = 130.0;
pub const V2_BURST_VULN_TSPIN: f64 = 90.0;
pub const V2_BURST_SETUP: f64 = 22.0;
pub const V2_MESSY_HOLES: u32 = 6;
pub const V2_DOWNSTACK_STEP: f64 = 34.0;
pub const V2_TSPIN_SETUP_BONUS: f64 = 34.0;

pub const V2_DEFAULT_DEPTH: usize = 7;
pub const V2_DEFAULT_WIDTH: usize = DEFAULT_WIDTH;
pub const V2_DEFAULT_TOP_K: usize = 16;

#[derive(Clone, Copy, Debug)]
pub struct V2Options {
    pub depth: usize,
    pub width: usize,
    pub top_k: usize,
    pub use_kicks: bool,
    pub use_opponent: bool,
    pub use_garbage_defense: bool,
    pub use_downstack: bool,
}

impl Default for V2Options {
    fn default() -> Self {
        V2Options {
            depth: V2_DEFAULT_DEPTH,
            width: V2_DEFAULT_WIDTH,
            top_k: V2_DEFAULT_TOP_K,
            use_kicks: true,
            use_opponent: true,
            use_garbage_defense: true,
            use_downstack: true,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct V2Flags {
    pub use_opponent: bool,
    pub use_garbage_defense: bool,
    pub use_downstack: bool,
}

fn has_i(hold: Option<PieceKind>, can_hold: bool, queue: &[PieceKind]) -> bool {
    if hold == Some(PieceKind::I) && can_hold {
        return true;
    }
    queue.iter().any(|&k| k == PieceKind::I)
}

#[derive(Clone, Copy, Debug)]
pub struct V2Veto {
    pending: i32,
}

impl V2Veto {
    pub fn new(pending: i32) -> V2Veto {
        V2Veto { pending }
    }

    pub fn veto(&self, after: &Board, lines: u32, tspin: bool) -> bool {
        let h = v2_board_stats(after);
        if lines == 0 && self.pending > 0 && h.global_max + self.pending as f64 >= 20.0 {
            return true;
        }
        if tspin && lines > 0 {
            if h.holes >= 10 && h.global_max >= 14.0 && self.pending > 0 {
                return true;
            }
            if h.holes >= 12 && h.global_max >= 15.0 {
                return true;
            }
        }
        false
    }
}

pub struct V2Scorer {
    opening: bool,
    late: f64,
    i_avail: bool,
    ren_late: bool,
    opp: V2OppModel,
    flags: V2Flags,
}

impl V2Scorer {
    pub fn new(
        hold: Option<PieceKind>,
        can_hold: bool,
        queue: &[PieceKind],
        pieces: u32,
        opp: V2OppModel,
        flags: V2Flags,
    ) -> V2Scorer {
        V2Scorer {
            opening: pieces < V2_OPENING_N,
            late: if pieces >= V2_LATE_PIECE_N {
                V2_LATE_MULT
            } else {
                1.0
            },
            i_avail: has_i(hold, can_hold, queue),
            ren_late: pieces >= V2_REN_LATE_N,
            opp,
            flags,
        }
    }

    #[allow(clippy::too_many_lines)]
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
        let stats = v2_board_stats(after);
        let well = ds_well(after, &stats.heights, 6);
        let emerg = ds_emergency(ctx.pending, well.global_max);
        let mut s = atk * V2_ATK_W * self.late;
        if tspin && lines > 0 {
            s += V2_TSD_EXEC;
        }
        if lines == 4 {
            s += V2_TETRIS_EXEC;
        }
        if lines == 3 {
            s += V2_TRIPLE_EXEC + V2_TRIPLE_ARRIVAL / (ctx.ply + 1) as f64;
        }
        if (lines == 4 || (tspin && lines > 0)) && ctx.b2b {
            s += V2_B2B_CHAIN;
        }
        if lines > 0 && lines < 4 && !tspin && ctx.b2b {
            if emerg == 0 {
                s -= V2_B2B_BREAK + if lines <= 2 { V2_B2B_WEAK_EXTRA } else { 0.0 };
            }
        }
        if lines == 0 && !tspin && ctx.b2b {
            if ds_count_tslots(after, 1) > 0 {
                s += V2_B2B_TSLOT_EXTRA;
            }
        }
        if ctx.ply == 0 && self.opening {
            s -= feat.holes * V2_HOLE_EXTRA;
        }
        if lines == 0 && !tspin {
            let setups = ds_count_tslots(after, 99);
            if setups > 2 {
                s -= (setups - 2) as f64 * V2_CAVITY_STEP;
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
            s += tslots as f64 * V2_TSLOT_KEEP2 * gamma * e_mult;
            let depth = well.depth.min(6) as f64;
            s += depth * V2_WELL_PLY_STEP * gamma * e_mult;
            if well.edge {
                if depth > 0.0 {
                    s += V2_WELL_EDGE_BONUS * gamma * e_mult;
                }
            } else if depth > 0.0 {
                s -= V2_WELL_CENTER_PEN * gamma * e_mult;
            }
            let bump = ds_bump_ex_well(&stats.heights, well.col);
            if bump > V2_BUMP_CAP {
                s -= (bump - V2_BUMP_CAP) * V2_BUMP_STEP * gamma;
            }
            let float_well = ds_float_well(&stats.heights, 6);
            let float_depth = float_well.depth.min(6) as f64;
            if float_well.edge && float_depth > 0.0 && feat.holes > 0.0 {
                s += float_depth * V2_WELL_PLY_STEP * gamma * e_mult;
            }
            let float_ready = float_well.edge
                && float_depth >= V2_READY_DEPTH as f64
                && feat.holes > 0.0
                && well.global_max >= 6.0;
            let ready_depth = depth.max(if float_ready { float_depth } else { 0.0 });
            if emerg == 0 && ready_depth >= V2_READY_DEPTH as f64 && ctx.ply <= 2 && self.i_avail {
                s += V2_TETRIS_READY * gamma;
            }
            if emerg == 0
                && ctx.ply == 0
                && ready_depth >= V2_READY_DEPTH as f64
                && self.i_avail
                && well.max_ex_well <= V2_RESERVE_CEIL
            {
                s += V2_EXECUTE_BONUS;
            }
        }
        if lines > 0 && ctx.ply <= 2 {
            let float_after = ds_float_well(&stats.heights, 6);
            if float_after.edge && float_after.depth >= V2_READY_DEPTH && self.i_avail {
                s += float_after.depth as f64 * V2_WELL_REBUILD_STEP;
            }
        }
        if ctx.ply == 0 && lines > 0 && lines < 4 && !tspin {
            let w0 = ds_well(after, &stats.heights, 6);
            if w0.depth >= V2_READY_DEPTH && w0.edge && self.i_avail {
                s -= V2_FILL_PEN + w0.depth as f64 * V2_WELL_FILL_LOSS;
            }
        }
        if lines > 0 && tspin {
            s += V2_TSD_ARRIVAL / (ctx.ply + 1) as f64;
        }
        if lines == 4 {
            s += V2_TETRIS_ARRIVAL / (ctx.ply + 1) as f64;
        }
        if (1..=3).contains(&ctx.ply) {
            if lines == 4 {
                s += V2_TETRIS_EXEC_DEEP;
            }
            if tspin && lines > 0 {
                s += V2_TSD_EXEC_DEEP;
            }
        }
        if lines > 0 && ncombo >= V2_REN_START {
            let ren_step = if self.ren_late {
                V2_REN_LATE_STEP
            } else {
                V2_REN_STEP
            };
            s += ncombo as f64 * ren_step * self.late;
        }
        if ctx.combo >= 2 && lines > 0 {
            s += V2_COMBO_KEEP;
        } else if ctx.combo >= 2 && lines == 0 && !tspin {
            if ctx.pending == 0 && emerg == 0 && feat.max_height < V2_EMERG_LINE {
                s += V2_REN_CALM_KEEP;
            } else {
                s -= V2_COMBO_BREAK;
            }
        }
        match ctx.piece {
            Some(PieceKind::T) if !(tspin && lines > 0) => {
                s += if lines > 0 {
                    -V2_WASTED_T_CLEAR
                } else {
                    -V2_WASTED_T_IDLE
                };
            }
            Some(PieceKind::I) if emerg != 2 && lines != 4 => {
                s += if lines > 0 {
                    -V2_WASTED_I_CLEAR
                } else {
                    -V2_WASTED_I_IDLE
                };
            }
            _ => {}
        }
        if emerg > 0 && lines == 0 && !tspin {
            s -= ds_height_pressure(well.max_ex_well);
        }
        if lines == 0 && !tspin && feat.max_height >= 17.0 {
            s -= (feat.max_height - 16.0) * V2_DIG_H20_STEP;
        }
        if lines == 0 && !tspin && well.global_max >= 16.0 {
            let e2 = ds_emergency(ctx.pending, well.max_ex_well);
            if e2 == 2 {
                s -= ds_height_pressure(well.global_max) * 0.5;
            }
        }
        if ctx.pending > 0 {
            if lines > 0 {
                s += ctx.pending as f64 * lines as f64 * V2_URGENCY_W
                    + V2_DIG_BONUS * lines as f64 * if emerg == 2 { 2.0 } else { 1.0 };
                let holes_after = ds_count_holes(after, &stats.heights);
                if holes_after <= 5 {
                    s += (6 - holes_after) as f64 * V2_HOLE_DIVE_STEP * lines as f64;
                }
            } else if feat.max_height >= V2_EMERG_LINE {
                s -= ds_height_pressure(feat.max_height);
            } else {
                s -= V2_DIG_HOLD;
            }
        } else if feat.max_height >= V2_EMERG_LINE && lines > 0 {
            let holes_after = ds_count_holes(after, &stats.heights);
            if holes_after <= 5 {
                s += (6 - holes_after) as f64 * V2_HOLE_DIVE_STEP * lines as f64;
            }
        }

        if self.flags.use_garbage_defense {
            s += v2_garbage_defense(&stats, ctx.pending_after);
        }

        if lines > 0 {
            if self.flags.use_opponent {
                s += self.opp.danger * lines as f64 * V2_OPP_DANGER_ATK_W;
            }
            if self.flags.use_opponent && self.opp.vuln > 0.0 {
                if lines == 4 {
                    s += V2_BURST_VULN_TETRIS;
                } else if tspin && lines > 0 {
                    s += V2_BURST_VULN_TSPIN;
                }
            }
            if self.flags.use_downstack && stats.holes >= V2_MESSY_HOLES {
                s += lines as f64 * V2_DOWNSTACK_STEP;
            }
        } else if !tspin && self.flags.use_downstack {
            if stats.holes <= 3 && ds_count_tslots(after, 1) > 0 {
                s += V2_TSPIN_SETUP_BONUS;
            }
            if self.flags.use_opponent
                && self.opp.vuln > 0.0
                && stats.holes <= 3
                && feat.max_height < 14.0
            {
                s += V2_BURST_SETUP;
            }
        }
        s
    }
}

pub struct V2Evaluation<'a> {
    pub scorer: &'a V2Scorer,
    pub veto: &'a V2Veto,
}

impl Evaluation for V2Evaluation<'_> {
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
        self.scorer.score(after, lines, tspin, ctx)
    }

    fn veto(&self, after: &Board, lines: u32, tspin: bool) -> bool {
        self.veto.veto(after, lines, tspin)
    }
}

pub struct V2Generator {
    pub use_kicks: bool,
}

impl PlacementGenerator for V2Generator {
    fn generate(&self, board: &Board, kind: PieceKind, weights: &crate::weights::Weights) -> Vec<ScoredPlacement> {
        if self.use_kicks {
            enumerate_kick_placements(board, kind, weights)
        } else {
            enumerate_scored_flat(board, kind, weights)
        }
    }
}

pub struct V2Input<'a> {
    pub board: &'a Board,
    pub active: PieceKind,
    pub next: &'a [PieceKind],
    pub hold: Option<PieceKind>,
    pub can_hold: bool,
    pub b2b: bool,
    pub combo: i32,
    pub pending_garbage: i32,
    pub pieces: u32,
    pub opponent: V2OpponentTelemetry,
    pub options: V2Options,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct V2Move {
    pub x: i32,
    pub rotation: i32,
    pub use_hold: bool,
}

#[derive(Clone, Copy, Debug)]
pub struct V2MoveDetails {
    pub mv: V2Move,
    pub y: i32,
    pub score: f64,
    pub lines_cleared: u32,
    pub is_tspin: bool,
    pub fire_score: f64,
    pub search_depth: usize,
    pub top_holes: u32,
    pub top_max_height: f64,
}

pub fn find_best_move_v2(input: &V2Input) -> Option<V2Move> {
    find_best_move_v2_details(input).map(|details| details.mv)
}

pub fn find_best_move_v2_details(input: &V2Input) -> Option<V2MoveDetails> {
    let depth = input.options.depth;
    let queue: Vec<PieceKind> = input.next.iter().take(depth.max(1)).copied().collect();
    let opp = v2_opponent_model(&input.opponent);
    let flags = V2Flags {
        use_opponent: input.options.use_opponent,
        use_garbage_defense: input.options.use_garbage_defense,
        use_downstack: input.options.use_downstack,
    };
    let scorer = V2Scorer::new(
        input.hold,
        input.can_hold,
        &queue,
        input.pieces,
        opp,
        flags,
    );
    let veto = V2Veto::new(input.pending_garbage);
    let evaluation = V2Evaluation {
        scorer: &scorer,
        veto: &veto,
    };
    let generator = V2Generator {
        use_kicks: input.options.use_kicks,
    };
    let options = BeamOptions {
        weights: &DEEPSEEK_V2_WEIGHTS,
        fire: &DEEPSEEK_V2_FIRE,
        width: input.options.width,
        depth,
        top_k: input.options.top_k,
        use_hold: true,
        pending: input.pending_garbage,
        evaluation: &evaluation,
        placement_generator: Some(&generator),
        use_kick: false,
    };
    let best = beam_best_move_details(
        input.board,
        input.active,
        &queue,
        input.hold,
        input.can_hold,
        input.b2b,
        input.combo,
        &options,
    )?;
    let stats = v2_board_stats(&best.after);
    Some(V2MoveDetails {
        mv: V2Move {
            x: best.x,
            rotation: best.rotation,
            use_hold: best.use_hold,
        },
        y: best.y,
        score: best.score,
        lines_cleared: best.lines_cleared,
        is_tspin: best.tspin,
        fire_score: best.fire_score,
        search_depth: best.search_depth,
        top_holes: stats.holes,
        top_max_height: stats.global_max,
    })
}
