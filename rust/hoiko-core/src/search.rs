//! Native SearchAI.Search + MaxElement + SetNextOption — faithful port of
//! `src/ai/native/search.ts` (binary IL 15619/15774/15892).
//!
//! Final selection is by raw accumulated `score` (no correction). Generation 1
//! is never beam-capped; `beamSizeLimit` is halved when `depth > 7`. When the
//! loop breaks, `results` is the *unsorted* terminal generation (the sort only
//! runs on the continue path), matching the reference's array aliasing.
//!
//! Arena strategy: nodes own their `GamePack`. Each generation builds a fresh
//! `Vec<NodeState>`; the pruned beam is a clone of the top `nextBeam` entries.
//! Nothing is pooled across generations because `GamePack` already owns a
//! `Vec` command log and an `Rc` next source; index pooling would not reduce
//! allocation meaningfully. Results are exact integers regardless.

use crate::baby::ExpandedChild;
use crate::evaluate::{evaluate, evaluate_first, transition_weight, EvalOut};
use crate::expand::expand_node;
use crate::gamepack::GamePack;
use crate::weights::HoikoWeights;

mod delay;
pub use delay::{clear_delay, get_delay, set_next_option, TAKE_OVER_TIME};

#[derive(Clone, Copy)]
pub struct SearchState {
    pub max_beam_size: i32,
    pub beam_size_limit: i32,
    pub timer_limit_ms: i32,
    pub weight_index: i32,
    pub min_depth: i32,
    pub depth_limit: i32,
}

impl Default for SearchState {
    fn default() -> Self {
        Self {
            max_beam_size: 50,
            beam_size_limit: 150,
            timer_limit_ms: 1000,
            weight_index: 0,
            min_depth: 10,
            depth_limit: 14,
        }
    }
}

pub fn default_search_state() -> SearchState {
    SearchState::default()
}

#[derive(Clone)]
struct NodeState {
    game: GamePack,
    score: i32,
    family_score: i32,
    #[allow(dead_code)]
    child_count: i32,
    first_x: i32,
    first_r: i32,
    first_m: i32,
    first_hold: bool,
    first_act: i32,
    first_move_delay: i32,
    first_y: i32,
    first_last_srs: i32,
    acts: Vec<i32>,
}

pub struct FirstPlacement {
    pub rotation: i32,
    pub x: i32,
    pub y: i32,
    pub last_srs: i32,
}

pub struct SearchOutcome {
    pub first_x: i32,
    pub first_r: i32,
    pub first_m: i32,
    pub first_hold: bool,
    pub first_act: i32,
    pub plan_acts: Vec<i32>,
    pub score: i32,
    pub depth: i32,
    pub node: i32,
    pub over_time: f64,
    pub move_delay: i32,
    pub first_placement: FirstPlacement,
}

fn make_node(child: ExpandedChild, parent: Option<&NodeState>, gen_one: bool) -> NodeState {
    let lm = child.game.locked_mino;
    let md = child.game.commands.move_delay;
    let fresh = gen_one || parent.is_none();
    let (first_x, first_r, first_m, first_hold, first_act, first_move_delay, first_y, first_last_srs, acts) =
        if fresh {
            (
                child.placed_x,
                child.placed_r,
                child.placed_m,
                child.hold_used,
                child.act,
                md,
                lm.y,
                lm.last_srs,
                vec![child.act],
            )
        } else {
            let p = parent.expect("checked above");
            let mut a = p.acts.clone();
            a.push(child.act);
            (
                p.first_x,
                p.first_r,
                p.first_m,
                p.first_hold,
                p.first_act,
                p.first_move_delay,
                p.first_y,
                p.first_last_srs,
                a,
            )
        };
    NodeState {
        game: child.game,
        score: 0,
        family_score: 0,
        child_count: 0,
        first_x,
        first_r,
        first_m,
        first_hold,
        first_act,
        first_move_delay,
        first_y,
        first_last_srs,
        acts,
    }
}

fn apply_eval(node: &mut NodeState, ev: &EvalOut, parent_family: i32) {
    node.family_score = ev.family_score + parent_family;
    node.score = ev.score + parent_family;
}

/// `SearchAI.Search` (IL 15619). Returns `None` when no first move exists.
pub fn run_search(
    state: &mut SearchState,
    root: &GamePack,
    weight_list: &[HoikoWeights],
    is_even_board: bool,
    use_s4w: bool,
    view_next: i32,
    now: &dyn Fn() -> f64,
    time_limit_ms: Option<i32>,
    allow_hold: bool,
) -> Option<SearchOutcome> {
    let limit = time_limit_ms.unwrap_or(state.timer_limit_ms);
    let t0 = now();
    let weight_index = transition_weight(&root.board, state.weight_index, is_even_board);
    state.weight_index = weight_index;
    let ew = weight_list.get(weight_index.max(0) as usize).or_else(|| weight_list.first())?;

    let gen1 = expand_node(root, allow_hold);
    if gen1.is_empty() {
        return None;
    }

    let mut parents: Vec<NodeState> = gen1
        .into_iter()
        .map(|child| {
            let mut node = make_node(child, None, true);
            let ev = evaluate_first(&node.game, ew, weight_index, is_even_board);
            node.family_score = ev.family_score;
            node.score = ev.family_score;
            node
        })
        .collect();
    let mut total = parents.len() as i32;
    let mut depth = 1i32;
    let mut results: Vec<NodeState>;

    loop {
        depth += 1;
        let trust_rate = if depth > view_next + 2 { 0.9 } else { 1.0 };
        let mut num_children = 0i32;
        let mut children: Vec<NodeState> = Vec::new();
        for i in 0..parents.len() {
            let expanded = expand_node(&parents[i].game, allow_hold);
            parents[i].child_count = expanded.len() as i32;
            num_children += expanded.len() as i32;
            for c in expanded {
                let mut node = make_node(c, Some(&parents[i]), false);
                let ev = evaluate(&node.game, ew, weight_index, is_even_board, use_s4w, trust_rate);
                apply_eval(&mut node, &ev, parents[i].family_score);
                children.push(node);
            }
            if depth >= state.min_depth + 1 && now() - t0 > limit as f64 {
                break;
            }
        }
        total += num_children;
        results = children;
        if depth >= state.depth_limit {
            break;
        }
        if depth >= state.min_depth && now() - t0 > limit as f64 {
            break;
        }
        if num_children <= 0 {
            break;
        }
        let cap = if depth > 7 { state.beam_size_limit / 2 } else { state.beam_size_limit };
        let next_beam = cap.min(num_children).max(0) as usize;
        results.sort_by(|a, b| b.score.cmp(&a.score));
        parents = results.iter().take(next_beam).cloned().collect();
    }

    if results.is_empty() {
        return None;
    }
    let mut best = &results[0];
    for n in &results {
        if n.score > best.score {
            best = n;
        }
    }

    let over_time = now() - t0 - limit as f64;
    Some(SearchOutcome {
        first_x: best.first_x,
        first_r: best.first_r,
        first_m: best.first_m,
        first_hold: best.first_hold,
        first_act: best.first_act,
        plan_acts: best.acts.clone(),
        score: best.score,
        depth,
        node: total,
        over_time,
        move_delay: best.first_move_delay,
        first_placement: FirstPlacement {
            rotation: ((best.first_r % 4) + 4) % 4,
            x: best.first_x,
            y: best.first_y,
            last_srs: best.first_last_srs,
        },
    })
}

#[cfg(test)]
mod tests;
