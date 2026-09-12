//! E4 probe: a traced copy of `SearchAI.Search`'s beam loop that records which
//! child each surviving node came from, so the replica's chosen 14-ply
//! placement path can be compared node-by-node against the exe's plan.
//!
//! Harness code only: it mirrors `search::run_search` step for step and is
//! verified against it (same first move / score / depth / node count) before
//! its path is trusted. It never changes engine behavior.

use crate::baby::ExpandedChild;
use crate::evaluate::{evaluate, evaluate_first, transition_weight, EvalFlags};
use crate::expand::{expand_node_into, ExpandScratch};
use crate::gamepack::GamePack;
use crate::search::SearchState;
use crate::weights::HoikoWeights;

#[derive(Clone, Copy)]
pub struct TracePlacement {
    pub x: i32,
    pub r: i32,
    pub m: i32,
    pub hold_used: bool,
    pub act: i32,
}

#[derive(Clone, Copy)]
pub struct TerminalEntry {
    pub score: i32,
    pub x: i32,
    pub r: i32,
    pub m: i32,
    pub act: i32,
    pub hold_used: bool,
}

pub struct BeamNode {
    pub score: i32,
    pub first_x: i32,
    pub first_r: i32,
    pub first_m: i32,
    pub x: i32,
    pub y: i32,
    pub r: i32,
    pub m: i32,
    pub act: i32,
    pub last_srs: i32,
    pub combo: i32,
    pub btb: i32,
    pub hold_m: i32,
    pub next_base: i32,
    pub rows: [i32; 32],
}

pub struct PreNode {
    pub parent_slot: i32,
    pub score: i32,
    pub x: i32,
    pub y: i32,
    pub r: i32,
    pub m: i32,
    pub act: i32,
    pub last_srs: i32,
    pub rows: [i32; 32],
}

pub struct GenBeam {
    pub depth: i32,
    pub num: i32,
    pub next_beam: i32,
    pub nodes: Vec<BeamNode>,
    pub pre: Vec<PreNode>,
}

pub struct SearchTrace {
    pub first_x: i32,
    pub first_r: i32,
    pub first_m: i32,
    pub score: i32,
    pub depth: i32,
    pub nodes: i32,
    /// Gen-1 .. terminal placement chain of the winning node.
    pub path: Vec<TracePlacement>,
    /// Per-generation beam-cutoff diagnostics (tie exposure at the boundary).
    pub prune_stats: Vec<PruneStat>,
    /// Terminal generation in array order (the MaxElement input list).
    pub terminals: Vec<TerminalEntry>,
    /// Per-generation selected beam in order (select_mode == 1 only).
    pub beams: Vec<GenBeam>,
}

pub struct PruneStat {
    pub depth: i32,
    pub num_children: i32,
    pub cap: i32,
    pub next_beam: usize,
    pub cutoff_score: i32,
    pub at_cutoff: i32,
    pub kept_at_cutoff: i32,
    pub distinct_scores: usize,
}

struct TraceNode {
    game: GamePack,
    score: i32,
    family_score: i32,
    parent: Option<usize>,
    placement: TracePlacement,
}

fn placement_of(c: &ExpandedChild) -> TracePlacement {
    TracePlacement {
        x: c.placed_x,
        r: c.placed_r,
        m: c.placed_m,
        hold_used: c.hold_used,
        act: c.act,
    }
}

/// `search::run_search` (IL 15619) with parent tracking. `now` is not consulted
/// for determinism; the shipped regime (timer 1000 ms, depth 14) never hits
/// the time checks, so the result equals the engine's.
///
/// `select_mode`: 0 = the replica's score-desc/index-asc selection; 1 = the
/// exe's exact `std::partial_sort` heap permutation (transcribed from IL
/// 16239/16367/16455/16509), used to test whether beam tie-breaking explains
/// the exe/replica divergence.
pub fn search_trace(
    state: &mut SearchState,
    root: &GamePack,
    weight_list: &[HoikoWeights],
    flags: EvalFlags,
    view_next: i32,
    allow_hold: bool,
    select_mode: i32,
) -> Option<SearchTrace> {
    let weight_index = transition_weight(&root.board, state.weight_index, flags);
    state.weight_index = weight_index;
    let ew = weight_list.get(weight_index.max(0) as usize).or_else(|| weight_list.first())?;

    let mut scratch = ExpandScratch::new();
    let mut expanded: Vec<ExpandedChild> = Vec::new();
    expand_node_into(root, allow_hold, &mut scratch, &mut expanded);
    if expanded.is_empty() {
        return None;
    }

    let mut arena: Vec<TraceNode> = Vec::with_capacity(4096);
    let mut parents: Vec<usize> = Vec::with_capacity(expanded.len());
    for c in expanded.drain(..) {
        let placement = placement_of(&c);
        let ev = evaluate_first(&c.game, ew, weight_index, flags);
        arena.push(TraceNode {
            game: c.game,
            score: ev.family_score,
            family_score: ev.family_score,
            parent: None,
            placement,
        });
        parents.push(arena.len() - 1);
    }
    let mut total = parents.len() as i32;
    let mut depth = 1i32;
    let mut children: Vec<usize> = Vec::new();
    let mut results: Vec<usize> = Vec::new();
    let mut order: Vec<u32> = Vec::new();
    let mut prune_stats: Vec<PruneStat> = Vec::new();
    let mut beams: Vec<GenBeam> = Vec::new();

    loop {
        depth += 1;
        let trust_rate = if depth > view_next + 2 { 0.9 } else { 1.0 };
        let mut num_children = 0i32;
        children.clear();
        for &pi in &parents {
            expand_node_into(&arena[pi].game, allow_hold, &mut scratch, &mut expanded);
            num_children += expanded.len() as i32;
            for c in expanded.drain(..) {
                let placement = placement_of(&c);
                let ev = evaluate(&c.game, ew, weight_index, flags, trust_rate);
                let ci = arena.len();
                arena.push(TraceNode {
                    game: c.game,
                    score: ev.score + arena[pi].family_score,
                    family_score: ev.family_score + arena[pi].family_score,
                    parent: Some(pi),
                    placement,
                });
                children.push(ci);
            }
        }
        total += num_children;
        if depth >= state.depth_limit || num_children <= 0 {
            results.clear();
            results.extend_from_slice(&children);
            break;
        }
        let cap = if depth > 7 { state.beam_size_limit / 2 } else { state.beam_size_limit };
        let next_beam = cap.min(num_children).max(0) as usize;
        order.clear();
        order.extend(0..children.len() as u32);
        let better = |&a: &u32, &b: &u32| {
            let sa = arena[children[a as usize]].score;
            let sb = arena[children[b as usize]].score;
            sb.cmp(&sa).then(a.cmp(&b))
        };
        let cutoff_score;
        let mut at_cutoff = 0i32;
        let mut kept_at_cutoff = 0i32;
        let mut distinct_scores = 0usize;
        if select_mode == 1 {
            let clen = children.len();
            std_partial_sort(&arena, &mut children, 0, next_beam, clen);
            cutoff_score = if next_beam > 0 { arena[children[next_beam - 1]].score } else { 0 };
            let mut beam_nodes = Vec::with_capacity(next_beam);
            for &c in &children[..next_beam] {
                let f = arena[parents_of_first_gen(&arena, c)].placement;
                let p = arena[c].placement;
                beam_nodes.push(BeamNode {
                    score: arena[c].score,
                    first_x: f.x,
                    first_r: f.r,
                    first_m: f.m,
                    x: p.x,
                    y: arena[c].game.locked_mino.y,
                    r: p.r,
                    m: p.m,
                    act: p.act,
                    last_srs: arena[c].game.locked_mino.last_srs,
                    combo: arena[c].game.combo,
                    btb: arena[c].game.btb,
                    hold_m: arena[c].game.hold.m,
                    next_base: arena[c].game.next_it.base,
                    rows: arena[c].game.board.line,
                });
            }
            prune_stats.push(PruneStat {
                depth,
                num_children,
                cap,
                next_beam,
                cutoff_score,
                at_cutoff,
                kept_at_cutoff,
                distinct_scores,
            });
            let pre_nodes = if depth == 5 {
                children
                    .iter()
                    .map(|&c| {
                        let f = arena[c].placement;
                        let parent_slot = arena[c]
                            .parent
                            .and_then(|p| parents.iter().position(|&q| q == p))
                            .map_or(-1, |s| s as i32);
                        PreNode {
                            parent_slot,
                            score: arena[c].score,
                            x: f.x,
                            y: arena[c].game.locked_mino.y,
                            r: ((f.r % 4) + 4) % 4,
                            m: f.m,
                            act: f.act,
                            last_srs: arena[c].game.locked_mino.last_srs,
                            rows: arena[c].game.board.line,
                        }
                    })
                    .collect()
            } else {
                Vec::new()
            };
            beams.push(GenBeam { depth, num: num_children, next_beam: next_beam as i32, nodes: beam_nodes, pre: pre_nodes });
            parents.clear();
            parents.extend_from_slice(&children[..next_beam]);
            children.clear();
            continue;
        }
        if next_beam < order.len() {
            order.select_nth_unstable_by(next_beam, better);
            order[..next_beam].sort_by(better);
        } else {
            order.sort_by(better);
        }
        cutoff_score =
            if next_beam > 0 { arena[children[order[next_beam - 1] as usize]].score } else { 0 };
        for &c in &children {
            if arena[c].score == cutoff_score {
                at_cutoff += 1;
            }
        }
        kept_at_cutoff = order[..next_beam]
            .iter()
            .filter(|&&o| arena[children[o as usize]].score == cutoff_score)
            .count() as i32;
        let mut scores: Vec<i32> = children.iter().map(|&c| arena[c].score).collect();
        scores.sort_unstable();
        scores.dedup();
        distinct_scores = scores.len();
        prune_stats.push(PruneStat {
            depth,
            num_children,
            cap,
            next_beam,
            cutoff_score,
            at_cutoff,
            kept_at_cutoff,
            distinct_scores,
        });
        parents.clear();
        for &idx in &order[..next_beam] {
            parents.push(children[idx as usize]);
        }
        children.clear();
    }

    if results.is_empty() {
        return None;
    }
    if select_mode == 1 {
        let mut beam_nodes = Vec::with_capacity(results.len());
        for &c in &results {
            let f = arena[parents_of_first_gen(&arena, c)].placement;
            let p = arena[c].placement;
            beam_nodes.push(BeamNode {
                score: arena[c].score,
                first_x: f.x,
                first_r: f.r,
                first_m: f.m,
                x: p.x,
                y: arena[c].game.locked_mino.y,
                r: p.r,
                m: p.m,
                act: p.act,
                last_srs: arena[c].game.locked_mino.last_srs,
                combo: arena[c].game.combo,
                btb: arena[c].game.btb,
                hold_m: arena[c].game.hold.m,
                next_base: arena[c].game.next_it.base,
                rows: arena[c].game.board.line,
            });
        }
        beams.push(GenBeam {
            depth,
            num: results.len() as i32,
            next_beam: results.len() as i32,
            nodes: beam_nodes,
            pre: Vec::new(),
        });
    }
    let mut best = results[0];
    for &n in &results {
        if arena[n].score > arena[best].score {
            best = n;
        }
    }
    let first = arena[parents_of_first_gen(&arena, best)].placement;
    let mut path = Vec::with_capacity(depth as usize);
    let mut cur = Some(best);
    while let Some(i) = cur {
        path.push(arena[i].placement);
        cur = arena[i].parent;
    }
    path.reverse();
    let terminals = results
        .iter()
        .map(|&n| {
            let p = arena[parents_of_first_gen(&arena, n)].placement;
            TerminalEntry {
                score: arena[n].score,
                x: p.x,
                r: p.r,
                m: p.m,
                act: p.act,
                hold_used: p.hold_used,
            }
        })
        .collect();
    Some(SearchTrace {
        first_x: first.x,
        first_r: first.r,
        first_m: first.m,
        score: arena[best].score,
        depth,
        nodes: total,
        path,
        prune_stats,
        terminals,
        beams,
    })
}

/// Follow parent links to the last node with no parent (gen 1).
fn parents_of_first_gen(arena: &[TraceNode], mut i: usize) -> usize {
    while let Some(p) = arena[i].parent {
        i = p;
    }
    i
}

fn heap_score(arena: &[TraceNode], v: &[usize], i: usize) -> i32 {
    arena[v[i]].score
}

fn pop_hole_by_index(
    arena: &[TraceNode],
    v: &mut [usize],
    first: usize,
    start_hole: usize,
    bottom: usize,
    val: usize,
) {
    let top = start_hole;
    let mut hole = start_hole;
    let mut child = start_hole;
    let last = bottom - 1;
    let half = last >> 1;
    if hole < half {
        loop {
            child = (child + 1) * 2;
            if arena[v[first + child]].score > arena[v[first + child - 1]].score {
                child -= 1;
            }
            v[first + hole] = v[first + child];
            hole = child;
            if child >= half {
                break;
            }
        }
    }
    if child == half && bottom % 2 == 0 {
        v[first + hole] = v[first + bottom - 1];
        hole = last;
    }
    let mut pos = hole;
    if top < hole {
        let mut parent = (hole - 1) >> 1;
        loop {
            let p = v[first + parent];
            if !(arena[p].score > arena[val].score) {
                break;
            }
            v[first + pos] = p;
            pos = parent;
            if top >= pos {
                break;
            }
            parent = (parent - 1) >> 1;
        }
    }
    v[first + pos] = val;
}

fn make_heap(arena: &[TraceNode], v: &mut [usize], first: usize, last: usize) {
    let mut parent = (last - first) >> 1;
    while parent > 0 {
        parent -= 1;
        let val = v[first + parent];
        pop_hole_by_index(arena, v, first, parent, last - first, val);
    }
}

/// Transaction of `std::partial_sort` (IL 16239): make_heap on `[first, mid)`,
/// then replace the heap root for every later element with a higher score, then
/// sort_heap. Mirrors the in-place permutation, so the kept subset and its
/// order match the exe's buffer exactly.
fn std_partial_sort(arena: &[TraceNode], v: &mut [usize], first: usize, mid: usize, last: usize) {
    if first == mid {
        return;
    }
    make_heap(arena, v, first, mid);
    if mid < last {
        for ptr in mid..last {
            if heap_score(arena, v, ptr) > heap_score(arena, v, first) {
                let val = v[ptr];
                v[ptr] = v[first];
                pop_hole_by_index(arena, v, first, 0, mid - first, val);
            }
        }
    }
    let mut end = mid;
    while end - first >= 2 {
        let last_i = end - 1;
        let val = v[last_i];
        v[last_i] = v[first];
        pop_hole_by_index(arena, v, first, 0, last_i - first, val);
        end -= 1;
    }
}
