//! Beam search over the known piece queue — port of `src/ai/bot/search.ts`.
//!
//! Exactness notes (see rust/SEARCH-PORT.md):
//! - every float expression is evaluated in the TS order (`scale * discount * dot`, etc.);
//! - `discount ** depth` uses `f64::powf`; libm and Bun can differ by one ULP
//!   (observed at depth 6 with discount 0.97). See SEARCH-PORT.md.
//! - children are sorted with a stable sort on value (TS `Array.prototype.sort` is stable),
//!   and generation order follows movegen's BFS order, so ties break identically.

use std::collections::HashSet;

use crate::features::{F_DANGER, F_MAX_HEIGHT, F_TSLOT, Features, board_features};
use crate::movegen::{Board, MoveGen, Placement, Pos, Tspin, lock_placement, locks_out, spawn_position};
use crate::pieces::Kind;
use crate::weights::{ClearKind, Weights};

#[derive(Clone, Debug)]
pub struct SearchInput {
    pub board: Board,
    pub active: (Kind, Pos),
    pub hold: Option<Kind>,
    pub can_hold: bool,
    /// Upcoming pieces after the active one.
    pub preview: Vec<Kind>,
    pub b2b: bool,
    /// Engine combo counter: -1 = no chain.
    pub combo: i32,
    /// Incoming garbage rows not yet on the board.
    pub pending: i32,
    /// Possible pieces after the visible queue (chance ply); empty = no speculation.
    pub speculative: Vec<Kind>,
}

#[derive(Clone, Debug)]
pub struct SearchOptions {
    pub weights: Weights,
    pub width: usize,
    pub diverse: bool,
    pub exposure: f64,
    pub guideline: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Step {
    pub placement: Placement,
    pub used_hold: bool,
    pub lines_cleared: u32,
    pub attack: i32,
    pub reward: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Candidate {
    pub placement: Placement,
    pub used_hold: bool,
    pub value: f64,
}

#[derive(Clone, Debug)]
pub struct SearchResult {
    pub best: Step,
    pub line: Vec<Step>,
    pub value: f64,
    pub candidates: Vec<Candidate>,
    pub nodes: u64,
    pub depth: u32,
    /// Weighted shape of the board after the first move, `FEATURE_NAMES` order.
    pub breakdown: [f64; crate::features::N_FEATURES],
}

#[derive(Clone, Copy)]
struct Node {
    board: Board,
    hold: Option<Kind>,
    next: u32,
    can_hold: bool,
    b2b: bool,
    combo: i32,
    lift: i32,
    tslot: i32,
    reward: f64,
    value: f64,
    depth: u32,
    step: Option<Step>,
    /// Index into the arena of the parent (u32::MAX = none).
    parent: u32,
    root: i32,
}

#[derive(Clone, Copy)]
struct PieceOption {
    kind: Kind,
    used_hold: bool,
    next: u32,
    hold: Option<Kind>,
}

/// Reusable search state: movegen scratch and buffers, so a long-running bot allocates once.
#[derive(Default)]
pub struct Searcher {
    movegen: MoveGen,
    placements: Vec<Placement>,
    spec_placements: Vec<Placement>,
    arena: Vec<Node>,
    children: Vec<Node>,
    order: Vec<u32>,
}

fn piece_options(node: &Node, sequence: &[Kind], out: &mut [PieceOption; 2]) -> usize {
    let Some(&current) = sequence.get(node.next as usize) else { return 0 };
    out[0] = PieceOption { kind: current, used_hold: false, next: node.next + 1, hold: node.hold };
    if !node.can_hold {
        return 1;
    }
    match node.hold {
        None => {
            if let Some(&after) = sequence.get(node.next as usize + 1) {
                if after != current {
                    out[1] = PieceOption { kind: after, used_hold: true, next: node.next + 2, hold: Some(current) };
                    return 2;
                }
            }
            1
        }
        Some(h) if h != current => {
            out[1] = PieceOption { kind: h, used_hold: true, next: node.next + 1, hold: Some(current) };
            2
        }
        Some(_) => 1,
    }
}

fn clear_kind(lines: u32, tspin: Tspin, perfect_clear: bool) -> Option<ClearKind> {
    if lines == 0 {
        return None;
    }
    if perfect_clear {
        return Some(ClearKind::PerfectClear);
    }
    Some(match tspin {
        Tspin::Mini => ClearKind::TspinMini,
        Tspin::Full => match lines {
            1 => ClearKind::TspinSingle,
            2 => ClearKind::TspinDouble,
            _ => ClearKind::TspinTriple,
        },
        Tspin::None => match lines {
            1 => ClearKind::Single,
            2 => ClearKind::Double,
            3 => ClearKind::Triple,
            _ => ClearKind::Quad,
        },
    })
}

/// `comboBonus` from core/garbage.ts.
fn combo_bonus(combo: i32) -> i32 {
    if combo <= 0 {
        0
    } else if combo <= 2 {
        1
    } else if combo <= 4 {
        2
    } else if combo <= 6 {
        3
    } else if combo <= 9 {
        4
    } else {
        5
    }
}

fn is_difficult(lines: u32, tspin: Tspin) -> bool {
    lines > 0 && (lines == 4 || tspin != Tspin::None)
}

/// `attackForClear` with `tspinLines = lines` for a full spin and `tspinKind` always given.
fn attack_for_clear(lines: u32, tspin: Tspin, combo: i32, b2b_active: bool, perfect_clear: bool) -> i32 {
    if lines == 0 {
        return 0;
    }
    let base = match tspin {
        Tspin::Mini => match lines {
            2 => 1,
            _ => 0,
        },
        Tspin::Full => match lines {
            1 => 2,
            2 => 4,
            3 => 6,
            _ => 0,
        },
        Tspin::None => match lines {
            2 => 1,
            3 => 2,
            4 => 4,
            _ => 0,
        },
    };
    let b2b = if b2b_active && is_difficult(lines, tspin) { 1 } else { 0 };
    let pc = if perfect_clear { 10 } else { 0 };
    base + b2b + combo_bonus(combo) + pc
}

struct Ctx<'a> {
    w: &'a Weights,
    exposure: f64,
    guideline: bool,
    /// `discount ** depth`, precomputed with `powf` (platform rounding can differ from JS).
    scale: Vec<f64>,
}

impl Ctx<'_> {
    #[inline(always)]
    fn scale(&self, depth: u32) -> f64 {
        match self.scale.get(depth as usize) {
            Some(&s) => s,
            None => self.w.discount.powf(depth as f64),
        }
    }
}

#[inline(always)]
fn expand(
    ctx: &Ctx,
    node: &Node,
    parent_index: u32,
    placement: &Placement,
    option: &PieceOption,
    root_pending: i32,
    root_index: i32,
) -> Option<Node> {
    if ctx.guideline && node.board.len > 20 && locks_out(placement, node.board.len) {
        return None;
    }
    let w = ctx.w;
    let outcome = lock_placement(&node.board, placement);
    let lines = outcome.lines_cleared;
    let combo = if lines > 0 { node.combo + 1 } else { -1 };
    let attack = attack_for_clear(
        lines,
        placement.tspin,
        if ctx.guideline { -1 } else { combo },
        node.b2b,
        !ctx.guideline && outcome.perfect_clear,
    );
    let difficult = is_difficult(lines, placement.tspin);
    let b2b = if lines == 0 {
        node.b2b
    } else if outcome.perfect_clear {
        lines >= 4
    } else {
        difficult
    };

    let pending = if node.depth == 0 { root_pending } else { 0 };
    let lift = node.lift + 0.max(pending - attack);

    let mut reward = attack as f64 * w.attack;
    if let Some(k) = clear_kind(lines, placement.tspin, !ctx.guideline && outcome.perfect_clear) {
        reward += w.clear[k as usize];
    }
    if node.b2b && lines > 0 && !difficult && !outcome.perfect_clear {
        reward += w.b2b_break;
    }
    if placement.kind == Kind::T && placement.tspin == Tspin::None && node.tslot > 0 {
        reward += w.wasted_t;
    }

    let features: Features = board_features(&outcome.board, lift);
    if features[F_MAX_HEIGHT] >= node.board.len as i32 {
        return None;
    }
    let scale = ctx.scale(node.depth);
    let accumulated = node.reward + scale * (reward - ctx.exposure * features[F_DANGER] as f64);
    let value = accumulated + scale * w.discount * w.dot(&features);

    Some(Node {
        board: outcome.board,
        hold: option.hold,
        next: option.next,
        can_hold: true,
        b2b,
        combo,
        lift,
        tslot: features[F_TSLOT],
        reward: accumulated,
        value,
        depth: node.depth + 1,
        step: Some(Step { placement: *placement, used_hold: option.used_hold, lines_cleared: lines, attack, reward }),
        parent: parent_index,
        root: if node.depth == 0 { root_index } else { node.root },
    })
}

impl Searcher {
    pub fn new() -> Searcher {
        Searcher::default()
    }

    pub fn search(&mut self, input: &SearchInput, options: &SearchOptions) -> Option<SearchResult> {
        let w = &options.weights;
        let ctx = Ctx {
            w,
            exposure: options.exposure,
            guideline: options.guideline,
            scale: (0..32).map(|d| w.discount.powf(d as f64)).collect(),
        };
        let mut sequence: Vec<Kind> = Vec::with_capacity(input.preview.len() + 2);
        sequence.push(input.active.0);
        sequence.extend_from_slice(&input.preview);
        let mut future: Vec<Kind> = sequence.clone();
        future.push(Kind::I);
        let rows = input.board.len;

        let root_features = board_features(&input.board, 0);
        self.arena.clear();
        self.arena.push(Node {
            board: input.board,
            hold: input.hold,
            next: 0,
            can_hold: input.can_hold,
            b2b: input.b2b,
            combo: input.combo,
            lift: 0,
            tslot: root_features[F_TSLOT],
            reward: 0.0,
            value: 0.0,
            depth: 0,
            step: None,
            parent: u32::MAX,
            root: -1,
        });
        let mut beam: Vec<u32> = vec![0];
        let mut nodes: u64 = 0;
        // Steps of every depth-1 child, indexed by `root`.
        let mut first_moves: Vec<Step> = Vec::new();
        // (arena index, value) — value may differ from the node's (chance average).
        let mut finished: Vec<(u32, f64)> = Vec::new();
        let mut deepest: Vec<u32> = Vec::new();
        let mut opts = [PieceOption { kind: Kind::I, used_hold: false, next: 0, hold: None }; 2];
        let mut seen: HashSet<DedupeKey> = HashSet::new();
        let mut seen_diverse: HashSet<(u32, Option<Kind>, bool, bool, i32, i32, Board)> = HashSet::new();

        while !beam.is_empty() {
            self.children.clear();
            for &ni in &beam {
                let node = self.arena[ni as usize];
                let n_opts = piece_options(&node, &sequence, &mut opts);
                if n_opts == 0 {
                    if input.speculative.is_empty() {
                        finished.push((ni, node.value));
                    } else {
                        let mut sum = 0.0f64;
                        let mut spec_opts = opts;
                        for &kind in &input.speculative {
                            let mut best = f64::NEG_INFINITY;
                            *future.last_mut().unwrap() = kind;
                            let n_spec = piece_options(&node, &future, &mut spec_opts);
                            for option in &spec_opts[..n_spec] {
                                self.spec_placements.clear();
                                self.movegen.generate(
                                    &node.board,
                                    option.kind,
                                    spawn_position(option.kind, node.board.len),
                                    &mut self.spec_placements,
                                );
                                for placement in &self.spec_placements {
                                    let child = expand(&ctx, &node, ni, placement, option, 0, 0);
                                    nodes += 1;
                                    if let Some(c) = child {
                                        best = best.max(c.value);
                                    }
                                }
                            }
                            sum += if best.is_finite() { best } else { -1_000_000.0 };
                        }
                        finished.push((ni, sum / input.speculative.len() as f64));
                    }
                }
                for option in &opts[..n_opts] {
                    let start = if node.depth == 0 && !option.used_hold {
                        input.active.1
                    } else if option.used_hold && node.hold.is_some() {
                        Pos { rotation: 0, x: 3, y: if node.board.len > 20 { node.board.len as i32 - 21 } else { 0 } }
                    } else {
                        spawn_position(option.kind, node.board.len)
                    };
                    self.placements.clear();
                    self.movegen.generate(&node.board, option.kind, start, &mut self.placements);
                    for placement in &self.placements {
                        let child = expand(
                            &ctx,
                            &node,
                            ni,
                            placement,
                            option,
                            input.pending,
                            first_moves.len() as i32,
                        );
                        nodes += 1;
                        let Some(child) = child else { continue };
                        if node.depth == 0 {
                            first_moves.push(child.step.unwrap());
                        }
                        self.children.push(child);
                    }
                }
            }
            // Stable sort by value, descending (TS: children.sort((a, b) => b.value - a.value)).
            self.order.clear();
            self.order.extend(0..self.children.len() as u32);
            let children = &self.children;
            self.order.sort_by(|&a, &b| {
                children[b as usize].value.partial_cmp(&children[a as usize].value).unwrap_or(std::cmp::Ordering::Equal)
            });
            let selected: Vec<u32> = if options.diverse {
                select_beam(children, &self.order, options.width, &mut seen_diverse)
            } else {
                dedupe(children, &self.order, options.width, options.guideline, &mut seen)
            };
            beam.clear();
            for ci in selected {
                beam.push(self.arena.len() as u32);
                self.arena.push(self.children[ci as usize]);
            }
            if !beam.is_empty() {
                deepest.clone_from(&beam);
            }
        }
        let _ = rows;

        let leaves: Vec<(u32, f64)> = if !finished.is_empty() {
            finished
        } else {
            deepest.iter().map(|&i| (i, self.arena[i as usize].value)).collect()
        };
        let mut best_leaf: Option<(u32, f64)> = None;
        for &(i, v) in &leaves {
            if self.arena[i as usize].depth == 0 {
                continue;
            }
            if best_leaf.is_none_or(|(_, bv)| v > bv) {
                best_leaf = Some((i, v));
            }
        }
        let (best_index, best_value) = best_leaf?;

        let mut line: Vec<Step> = Vec::new();
        let mut n = best_index;
        while n != u32::MAX {
            let node = &self.arena[n as usize];
            match node.step {
                Some(s) => line.push(s),
                None => break,
            }
            n = node.parent;
        }
        line.reverse();
        let best_node = self.arena[best_index as usize];

        // rootBest: Map in first-insertion order, then stable sort by value desc.
        let mut root_best: Vec<(i32, f64)> = Vec::new();
        for &(i, v) in &leaves {
            let node = &self.arena[i as usize];
            if node.depth == 0 {
                continue;
            }
            match root_best.iter_mut().find(|(r, _)| *r == node.root) {
                Some(entry) => {
                    if v > entry.1 {
                        entry.1 = v;
                    }
                }
                None => root_best.push((node.root, v)),
            }
        }
        root_best.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let candidates = root_best
            .iter()
            .map(|&(r, v)| {
                let s = first_moves[r as usize];
                Candidate { placement: s.placement, used_hold: s.used_hold, value: v }
            })
            .collect();

        // Breakdown of the board after the first move (the depth-1 ancestor of the best leaf).
        let mut first = best_index;
        while self.arena[first as usize].depth > 1 {
            first = self.arena[first as usize].parent;
        }
        let first_node = &self.arena[first as usize];
        let f = board_features(&first_node.board, first_node.lift);
        let mut breakdown = [0.0; crate::features::N_FEATURES];
        for i in 0..breakdown.len() {
            breakdown[i] = f[i] as f64 * w.board[i];
        }

        Some(SearchResult {
            best: line[0],
            line,
            value: best_value,
            candidates,
            nodes,
            depth: best_node.depth,
            breakdown,
        })
    }
}

/// (next, hold, can_hold, b2b, combo, lift, board): every state the search reads later.
type DedupeKey = (u32, Option<Kind>, bool, bool, i32, i32, Board);

/// Keep the best `width` children, dropping later copies of an identical position
/// (`dedupe` in search.ts). Combo is folded to -1 under the guideline rig, where it never
/// reaches attack.
fn dedupe(
    children: &[Node],
    order: &[u32],
    width: usize,
    guideline: bool,
    seen: &mut HashSet<DedupeKey>,
) -> Vec<u32> {
    seen.clear();
    let mut kept = Vec::with_capacity(width);
    for &i in order {
        if kept.len() >= width {
            break;
        }
        let n = &children[i as usize];
        let combo = if guideline { -1 } else { n.combo };
        if !seen.insert((n.next, n.hold, n.can_hold, n.b2b, combo, n.lift, n.board)) {
            continue;
        }
        kept.push(i);
    }
    kept
}

/// Keep distinct attack economies and reserve a bounded set of first moves (`selectBeam`).
fn select_beam(
    children: &[Node],
    order: &[u32],
    width: usize,
    seen: &mut HashSet<(u32, Option<Kind>, bool, bool, i32, i32, Board)>,
) -> Vec<u32> {
    if width == 0 {
        return Vec::new();
    }
    seen.clear();
    let mut pool: Vec<u32> = Vec::new();
    for &i in order {
        let n = &children[i as usize];
        if !seen.insert((n.next, n.hold, n.can_hold, n.b2b, n.combo, n.lift, n.board)) {
            continue;
        }
        pool.push(i);
        if pool.len() >= width * 4 {
            break;
        }
    }
    // `chosen` is an insertion-ordered set.
    let mut chosen: Vec<u32> = Vec::new();
    let mut in_chosen = vec![false; children.len()];
    let mut roots: Vec<i32> = Vec::new();
    let quota = 8.min(width / 6);
    for &i in &pool {
        if roots.len() >= quota {
            break;
        }
        let r = children[i as usize].root;
        if roots.contains(&r) {
            continue;
        }
        roots.push(r);
        chosen.push(i);
        in_chosen[i as usize] = true;
    }
    for &i in &pool {
        if chosen.len() >= width {
            break;
        }
        if !in_chosen[i as usize] {
            in_chosen[i as usize] = true;
            chosen.push(i);
        }
    }
    chosen.sort_by(|&a, &b| {
        children[b as usize].value.partial_cmp(&children[a as usize].value).unwrap_or(std::cmp::Ordering::Equal)
    });
    chosen
}
