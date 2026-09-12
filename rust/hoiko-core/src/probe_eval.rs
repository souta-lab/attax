//! E4 evaluation differential probe: exact per-term evaluation dump for one
//! node, plus a path walk that expands and evaluates every child along a
//! caller-supplied placement path.
//!
//! This is harness code only — it reuses the engine's own term functions and
//! never changes search/eval behavior. The host feeds the identical board /
//! next / hold / combo / btb / path to `Hoiko.exe`'s `EvaluateAI.Evaluate`
//! (via the driver stub) and diffs the returned `score`/`familyScore` and
//! sub-terms against this dump.

use crate::board::BOARD_HEIGHT;
use crate::evaluate::terms;
use crate::evaluate::{evaluate_first, get_cont_bonus, get_final_action, pc, tsd, tst, EvalFlags};
use crate::baby::ExpandedChild;
use crate::expand::expand_node;
use crate::gamepack::GamePack;
use crate::mino::FallMino;
use crate::probe::{build_root, ProbeInput};
use crate::shapes::MinoType;
use crate::weights::HoikoWeights;

/// Every accumulator `EvaluateAI.Evaluate` folds into `board`, plus the final
/// `score`/`familyScore` it writes.
pub struct EvalTerms {
    pub min_height: i32,
    pub col_height: [i32; 10],
    pub height: i32,
    pub well_score: i32,
    pub well_column: i32,
    pub well_depth: i32,
    pub up_down: i32,
    pub underground: i32,
    pub ground: i32,
    pub resource: i32,
    pub tsd: i32,
    pub tst: i32,
    pub pc: i32,
    pub cont_bonus: i32,
    pub final_action: i32,
    pub board_sum: i32,
    pub family_score: i32,
    pub score: i32,
}

/// Same arithmetic as `evaluate`, but keeping every sub-term for the diff.
pub fn eval_terms(
    g: &GamePack,
    ew: &HoikoWeights,
    weight_index: i32,
    flags: EvalFlags,
    trust_rate: f64,
) -> EvalTerms {
    let mut ch = [0i32; 10];
    let min_height = terms::build_column_height(&g.board, &mut ch);
    let height = terms::get_height(&g.board, &ch, ew);
    let well = terms::get_well_column(&g.board, &ch, min_height, ew);
    let up_down = terms::get_up_down(&ch, well.well_column, well.well_depth, ew);
    let underground = terms::get_underground(&g.board, &ch, min_height, ew);
    let y0 = well.well_depth + min_height;
    let ground = terms::get_ground(g, &ch, y0, ew);
    let resource = terms::get_resource(
        g,
        &ch,
        min_height,
        ew,
        flags.use_s4w,
        flags.vs.opponent_is_powerful_board,
    );
    let tsd = tsd::search_tsd(g, &ch, y0, ew);
    let tst = tst::search_tst(g, &ch, y0, min_height, ew);
    let pc = pc::search_pc_board(g, min_height, ew, flags.is_even_board, flags.use_pcstack);
    let cont_bonus = get_cont_bonus(g, ew);
    let final_action = get_final_action(g, ew, weight_index);
    let board_sum =
        height + well.score + up_down + underground + ground + resource + tsd + tst + pc + cont_bonus;
    let family_score = ((ew.nexus * board_sum as f64) as i32 + final_action) as f64 * trust_rate;
    let score = (final_action + board_sum) as f64 * trust_rate;
    EvalTerms {
        min_height,
        col_height: ch,
        height,
        well_score: well.score,
        well_column: well.well_column,
        well_depth: well.well_depth,
        up_down,
        underground,
        ground,
        resource,
        tsd,
        tst,
        pc,
        cont_bonus,
        final_action,
        board_sum,
        family_score: family_score as i32,
        score: score as i32,
    }
}

pub struct EvalChildDump {
    pub hold_used: bool,
    pub placed_x: i32,
    pub placed_r: i32,
    pub placed_m: i32,
    pub act: i32,
    pub move_delay: i32,
    pub falling: FallMino,
    pub locked: FallMino,
    pub combo: i32,
    pub btb: i32,
    pub stack_height: i32,
    pub next_base: i32,
    pub trust_end: i32,
    pub board: [i32; BOARD_HEIGHT],
    pub terms: EvalTerms,
}

pub struct EvalGenDump {
    pub depth: i32,
    pub mode_first: bool,
    pub trust_tenths: i32,
    pub cur_falling_m: MinoType,
    pub cur_hold_m: MinoType,
    pub cur_combo: i32,
    pub cur_btb: i32,
    pub cur_stack_height: i32,
    pub children: Vec<EvalChildDump>,
}

fn dump_child(c: &ExpandedChild, terms: EvalTerms) -> EvalChildDump {
    EvalChildDump {
        hold_used: c.hold_used,
        placed_x: c.placed_x,
        placed_r: c.placed_r,
        placed_m: c.placed_m,
        act: c.act,
        move_delay: c.game.commands.move_delay,
        falling: c.game.falling_mino,
        locked: c.game.locked_mino,
        combo: c.game.combo,
        btb: c.game.btb,
        stack_height: c.game.board.stack_height,
        next_base: c.game.next_it.base,
        trust_end: c.game.next_it.trust_end,
        board: c.game.board.line,
        terms,
    }
}

/// Walk `path` (one `(x, rot, m, act)` per ply; negative `m`/`act` skip that
/// check, as in the oracle's `path=` matcher) and evaluate every child at every
/// generation, exactly as `run_search` does: `evaluate_first` at depth 1,
/// `evaluate` with `trust_rate` (0.9 past `view_next + 2`) deeper.
pub fn eval_walk_probe(
    input: &ProbeInput,
    ew: &HoikoWeights,
    weight_index: i32,
    flags: EvalFlags,
    allow_hold: bool,
    start_depth: i32,
    path: &[(i32, i32, i32, i32)],
) -> Vec<EvalGenDump> {
    let mut g = build_root(input);
    let mut gens = Vec::with_capacity(path.len() + 1);
    for k in 0..=path.len() {
        let children = expand_node(&g, allow_hold);
        let depth = start_depth + k as i32;
        let mode_first = depth == 1;
        let trust_rate = if depth > input.view_next + 2 { 0.9 } else { 1.0 };
        let cur = EvalGenDump {
            depth,
            mode_first,
            trust_tenths: if trust_rate == 0.9 { 9 } else { 10 },
            cur_falling_m: g.falling_mino.m,
            cur_hold_m: g.hold.m,
            cur_combo: g.combo,
            cur_btb: g.btb,
            cur_stack_height: g.board.stack_height,
            children: Vec::with_capacity(children.len()),
        };
        let mut gen_dump = cur;
        for c in &children {
            let mut t = eval_terms(&c.game, ew, weight_index, flags, trust_rate);
            if mode_first {
                let ef = evaluate_first(&c.game, ew, weight_index, flags);
                t.family_score = ef.family_score;
                t.score = ef.family_score;
            }
            gen_dump.children.push(dump_child(c, t));
        }
        gens.push(gen_dump);
        if k >= path.len() {
            break;
        }
        let (px, pr, pm, pact) = path[k];
        let sel = children.iter().position(|c| {
            c.game.locked_mino.x == px
                && (c.game.locked_mino.r & 3) == pr
                && (pm < 0 || c.game.locked_mino.m == pm)
                && (pact < 0 || c.act == pact)
        });
        match sel {
            Some(i) => g = children[i].game.clone(),
            None => break,
        }
    }
    gens
}

/// Depth-2 breadth: the root's depth-1 children (evaluated with
/// `evaluate_first`) plus, for each of them, its depth-2 children (evaluated
/// with `evaluate`). Every node is a genuine in-search state.
pub fn eval_bfs_probe(
    input: &ProbeInput,
    ew: &HoikoWeights,
    weight_index: i32,
    flags: EvalFlags,
    allow_hold: bool,
) -> Vec<EvalGenDump> {
    let root = build_root(input);
    let first = expand_node(&root, allow_hold);
    let mut gens = Vec::with_capacity(first.len() + 1);
    let mut g0 = EvalGenDump {
        depth: 1,
        mode_first: true,
        trust_tenths: 10,
        cur_falling_m: root.falling_mino.m,
        cur_hold_m: root.hold.m,
        cur_combo: root.combo,
        cur_btb: root.btb,
        cur_stack_height: root.board.stack_height,
        children: Vec::with_capacity(first.len()),
    };
    for c in &first {
        let t = eval_terms(&c.game, ew, weight_index, flags, 1.0);
        let ef = evaluate_first(&c.game, ew, weight_index, flags);
        let mut t = t;
        t.family_score = ef.family_score;
        t.score = ef.family_score;
        g0.children.push(dump_child(c, t));
    }
    gens.push(g0);

    let trust_rate = if 2 > input.view_next + 2 { 0.9 } else { 1.0 };
    for c in &first {
        let kids = expand_node(&c.game, allow_hold);
        let mut gd = EvalGenDump {
            depth: 2,
            mode_first: false,
            trust_tenths: if trust_rate == 0.9 { 9 } else { 10 },
            cur_falling_m: c.game.falling_mino.m,
            cur_hold_m: c.game.hold.m,
            cur_combo: c.game.combo,
            cur_btb: c.game.btb,
            cur_stack_height: c.game.board.stack_height,
            children: Vec::with_capacity(kids.len()),
        };
        for k in &kids {
            let t = eval_terms(&k.game, ew, weight_index, flags, trust_rate);
            gd.children.push(dump_child(k, t));
        }
        gens.push(gd);
    }
    gens
}
