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
use crate::expand::{expand_node_into, ExpandScratch};
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

pub const MAX_ACTS: usize = 16;

#[derive(Clone, Copy)]
struct Acts {
    buf: [i32; MAX_ACTS],
    len: u8,
}

impl Default for Acts {
    fn default() -> Self {
        Self { buf: [0; MAX_ACTS], len: 0 }
    }
}

impl Acts {
    fn single(v: i32) -> Self {
        let mut a = Self::default();
        a.push(v);
        a
    }

    #[inline]
    fn push(&mut self, v: i32) {
        if (self.len as usize) < MAX_ACTS {
            self.buf[self.len as usize] = v;
            self.len += 1;
        }
    }

    fn as_slice(&self) -> &[i32] {
        &self.buf[..self.len as usize]
    }
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
    acts: Acts,
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
                Acts::single(child.act),
            )
        } else {
            let p = parent.expect("checked above");
            let mut a = p.acts;
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

    let mut scratch = ExpandScratch::new();
    let mut expanded: Vec<ExpandedChild> = Vec::new();
    expand_node_into(root, allow_hold, &mut scratch, &mut expanded);
    if expanded.is_empty() {
        return None;
    }

    let mut parents: Vec<NodeState> = expanded
        .drain(..)
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
    let mut children: Vec<NodeState> = Vec::new();
    let mut results: Vec<NodeState> = Vec::new();
    let mut order: Vec<u32> = Vec::new();

    loop {
        depth += 1;
        let trust_rate = if depth > view_next + 2 { 0.9 } else { 1.0 };
        let mut num_children = 0i32;
        children.clear();
        for i in 0..parents.len() {
            expand_node_into(&parents[i].game, allow_hold, &mut scratch, &mut expanded);
            parents[i].child_count = expanded.len() as i32;
            num_children += expanded.len() as i32;
            for c in expanded.drain(..) {
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
        if depth >= state.depth_limit {
            std::mem::swap(&mut results, &mut children);
            break;
        }
        if depth >= state.min_depth && now() - t0 > limit as f64 {
            std::mem::swap(&mut results, &mut children);
            break;
        }
        if num_children <= 0 {
            std::mem::swap(&mut results, &mut children);
            break;
        }
        let cap = if depth > 7 { state.beam_size_limit / 2 } else { state.beam_size_limit };
        let next_beam = cap.min(num_children).max(0) as usize;
        order.clear();
        order.extend(0..children.len() as u32);
        let better = |&a: &u32, &b: &u32| {
            children[b as usize].score.cmp(&children[a as usize].score).then(a.cmp(&b))
        };
        if next_beam < order.len() {
            order.select_nth_unstable_by(next_beam, better);
            order[..next_beam].sort_by(better);
        } else {
            order.sort_by(better);
        }
        parents.clear();
        for &idx in &order[..next_beam] {
            parents.push(children[idx as usize].clone());
        }
        children.clear();
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
        plan_acts: best.acts.as_slice().to_vec(),
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
