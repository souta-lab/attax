//! Beam search over the known piece queue — port of `src/ai/bot/search.ts`.
//!
//! Exactness notes (see rust/SEARCH-PORT.md):
//! - every float expression is evaluated in the TS order (`scale * discount * dot`, etc.);
//! - `discount ** depth` uses `f64::powi`: Bun's `**` with an integer exponent matches
//!   `powi` bit for bit (verified at 0.97 for depths 0..=20), while libm `powf` differs
//!   by one ULP at most depths >= 6 — the divergence SEARCH-PORT.md recorded.
//! - children are sorted with a stable sort on value (TS `Array.prototype.sort` is stable),
//!   and generation order follows movegen's BFS order, so ties break identically.

use std::cell::Cell;
use std::collections::HashSet;

use crate::features::{F_DANGER, F_MAX_HEIGHT, F_TSLOT, F_WELL_DEPTH, Features, board_features, hole_geometry, tslot_donations};
use crate::movegen::{
    Board, GarbageRows, GenOptions, MoveGen, Placement, Pos, Tspin, classify_s2_spin, lock_placement, locks_out,
    spawn_position,
};
use crate::pieces::{Kind, cells_for};
use crate::rules::{MultiplierCache, award_lock_s2};
use crate::solvency::{SolvencyParams, solvency_margin, solvency_penalty};
use crate::stock::{StockParams, StockState, stock_potential};
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
    /// S2: logical referee frame at the root decision. 0 when absent.
    pub frame: i64,
    /// S2: garbage flags aligned with board row indices. Absent on the guideline path.
    pub garbage_rows: Option<GarbageRows>,
    /// S2: exact difficult-clear chain. When present it is used verbatim for the root
    /// state (and `b2b` is ignored there); the guideline path never sets it.
    pub b2b_chain: Option<i32>,
    /// S2: referee-given rows due on the root lock. 0 when absent.
    pub due_this_lock: i32,
    /// S2: referee kickset witness for root placements, materialized as the accepted
    /// witness keys (see `witness_key`). `None` = no root filter.
    pub accept_root_keys: Option<HashSet<String>>,
}

impl SearchInput {
    /// A guideline-shaped input with every S2 field at its absent default; S2 callers
    /// override the fields they carry.
    pub fn new(
        board: Board,
        active: (Kind, Pos),
        hold: Option<Kind>,
        can_hold: bool,
        preview: Vec<Kind>,
        b2b: bool,
        combo: i32,
        pending: i32,
        speculative: Vec<Kind>,
    ) -> SearchInput {
        SearchInput {
            board,
            active,
            hold,
            can_hold,
            preview,
            b2b,
            combo,
            pending,
            speculative,
            frame: 0,
            garbage_rows: None,
            b2b_chain: None,
            due_this_lock: 0,
            accept_root_keys: None,
        }
    }
}

/// Dedupe rules profile (`SearchProfile` in search.ts).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SearchProfile {
    /// Legacy key (next, hold, b2b, board): preserves the frozen guideline/Hoiko record.
    Guideline,
    /// Full provenance key: every state the search reads later.
    S2,
}

#[derive(Clone, Debug)]
pub struct SearchOptions {
    pub weights: Weights,
    pub width: usize,
    pub diverse: bool,
    pub exposure: f64,
    pub guideline: bool,
    /// Rules profile. `Guideline` reproduces the frozen root-lift search; `S2` selects
    /// the full S2 semantics (staged awards, All-Mini+ spins, 180° inputs with the S2
    /// kick table, materialized garbage, terminal death, full-provenance dedupe key).
    pub profile: SearchProfile,
    /// S2 only — C1 stock potential (canonical §C1). Absent or scale 0 = Φ ≡ 0.
    pub stock: Option<StockParams>,
    /// S2 only — C2 solvency layer (canonical §C2). Absent or coefficient 0 = no penalty.
    pub solvency: Option<SolvencyParams>,
    /// S2 only — hard root solvency veto (decision-stage filter over ranked root lines).
    pub root_veto: bool,
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
    garbage_rows: Option<GarbageRows>,
    hold: Option<Kind>,
    next: u32,
    can_hold: bool,
    b2b: bool,
    b2b_chain: i32,
    combo: i32,
    pending: i32,
    lift: i32,
    /// S2: referee-given rows due on the root lock (root only; children carry 0).
    due_this_lock: i32,
    /// S2: terminal under the referee death rule (valued as a leaf, never expanded).
    dead: bool,
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
    /// The adopt state terms mirror the TS guideline evaluation (`stateValue`); the TS S2
    /// path does not read them, so the `S2` profile keeps the plain `dot`.
    adopt: bool,
    t_slot_chain: Option<[f64; 4]>,
    t_left: Vec<i32>,
    bag_credit: i32,
    /// `discount ** depth`, precomputed. Bun's `**` with an integer exponent matches
    /// `f64::powi` bit for bit on this host (verified for depths 0..=20 at 0.97, where
    /// `powf` differs from Bun by one ULP at most depths >= 6 — the SEARCH-PORT.md
    /// rounding divergence), so integer powers go through `powi`.
    scale: Vec<f64>,
    /// S2: logical referee frame at the root decision (the multiplier's base frame).
    root_frame: i64,
    /// S2: margin-multiplier accumulation cache (a pure function of the frame).
    mult: Cell<MultiplierCache>,
    /// S2 mechanism parameters (canonical §C1/§C2), resolved by the caller.
    stock: Option<StockParams>,
    solvency: Option<SolvencyParams>,
}

impl Ctx<'_> {
    #[inline(always)]
    fn scale(&self, depth: u32) -> f64 {
        match self.scale.get(depth as usize) {
            Some(&s) => s,
            None => self.w.discount.powi(depth as i32),
        }
    }

    /// S2 margin multiplier at a node's lock frame (`rootFrame + 60 * depth`).
    #[inline(always)]
    fn multiplier(&self, depth: u32) -> f64 {
        let mut cache = self.mult.get();
        let value = cache.get(self.root_frame + 60 * depth as i64);
        self.mult.set(cache);
        value
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
    let value = accumulated + scale * w.discount * state_value(ctx, &features, &outcome.board, b2b, option);

    Some(Node {
        board: outcome.board,
        garbage_rows: None,
        hold: option.hold,
        next: option.next,
        can_hold: true,
        b2b,
        b2b_chain: if b2b { 1 } else { 0 },
        combo,
        pending: 0,
        lift,
        due_this_lock: 0,
        dead: false,
        tslot: features[F_TSLOT],
        reward: accumulated,
        value,
        depth: node.depth + 1,
        step: Some(Step { placement: *placement, used_hold: option.used_hold, lines_cleared: lines, attack, reward }),
        parent: parent_index,
        root: if node.depth == 0 { root_index } else { node.root },
    })
}

/// S2 expansion (`expandS2` in search.ts): exact difficult-clear chain, staged S2
/// awards with the lock-frame margin multiplier, All-Mini+ spin classification,
/// garbage flags compacted with the clear, carried residual pending with landed rows
/// materialized into the child board, terminal death at the visible field top
/// (row 21), and the optional C1 Φ / C2 solvency terms in the terminal bracket.
/// Never returns None: death is a terminal flag on the child, not a rejection.
#[allow(clippy::too_many_arguments)]
fn expand_s2(
    ctx: &Ctx,
    node: &Node,
    parent_index: u32,
    placement: &Placement,
    option: &PieceOption,
    root_index: i32,
) -> Node {
    let w = ctx.w;
    // Staged S2 lock awards and All-Mini+; the exact chain is never reduced to a flag.
    let mut placement = *placement;
    placement.tspin = classify_s2_spin(&node.board, &placement);
    let spin = placement.tspin;

    // Match lock_placement's cell coordinates and bottom-to-top survivor collapse.
    let mut filled = node.board;
    {
        let s = crate::pieces::shape(placement.kind, placement.rotation as usize);
        let shift = (placement.x as i32 + s.min_x) as u32;
        for i in 0..s.height {
            let row = placement.y as i32 + s.min_y + i;
            if row >= 0 && row < node.board.len as i32 {
                filled.rows[row as usize] |= s.rows[i as usize] << shift;
            }
        }
    }
    // Compact the surviving flags in the same direction lock_placement collapses the
    // board (write cursor from the high-index end), so each flag stays on its own
    // board row after a clear.
    let node_flags = node.garbage_rows.unwrap_or_else(|| GarbageRows::new(node.board.len));
    let mut garbage_rows = GarbageRows::new(node.board.len);
    let mut garbage_cleared = 0i32;
    let mut write = node.board.len as i32 - 1;
    for read in (0..node.board.len as i32).rev() {
        if filled.rows[read as usize] == crate::movegen::FULL_ROW {
            garbage_cleared += node_flags.rows[read as usize] as i32;
        } else {
            garbage_rows.rows[write as usize] = node_flags.rows[read as usize];
            write -= 1;
        }
    }
    let outcome = lock_placement(&node.board, &placement);
    let lines = outcome.lines_cleared;
    let combo = if lines > 0 { node.combo + 1 } else { -1 };
    let multiplier = ctx.multiplier(node.depth);
    let award = award_lock_s2(lines, spin, combo, outcome.perfect_clear, node.b2b_chain, multiplier, garbage_cleared);
    // The S2 rules profile enables surge, so the award stands as staged (the TS
    // adjustment for a surge-less profile never fires here).
    let attack = award.attack;
    let difficult = lines > 0 && (lines == 4 || spin != Tspin::None || outcome.perfect_clear);
    let b2b_chain = award.difficult_chain;

    // Garbage: our attack cancels what is pending; the due remainder lands under the
    // stack on a non-clearing lock. The residual pending is carried into the child.
    let pending_in = node.pending;
    let (pending, landed) = if lines > 0 {
        ((pending_in - attack).max(0), 0)
    } else {
        let landed = if node.depth == 0 { node.due_this_lock } else { pending_in }.min(pending_in);
        (pending_in - landed, landed)
    };

    let mut reward = attack as f64 * w.attack;
    // Attack is paid pre-cancel; only excess converts to pressure (root only).
    if node.depth == 0 {
        reward += w.conversion * (attack - pending_in).max(0) as f64;
    }
    let kind = clear_kind(lines, spin, outcome.perfect_clear);
    if let Some(k) = kind {
        reward += w.clear[k as usize];
    }
    if kind == Some(ClearKind::TspinMini) {
        let delta = match lines {
            1 => w.mini_single_delta,
            2 => w.mini_double_delta,
            3 => w.mini_triple_delta,
            _ => 0.0,
        };
        if delta != 0.0 {
            reward += delta;
        }
    }
    if node.b2b_chain != 0 && lines > 0 && !difficult && !outcome.perfect_clear {
        reward += w.b2b_break;
    }
    if placement.kind == Kind::T && spin == Tspin::None && node.tslot > 0 {
        reward += w.wasted_t;
    }

    // Materialize the landed rows into the child board (child lift is therefore 0).
    // The hole column is the post-lock board's well — one shared hole per tank.
    let mut board = outcome.board;
    let mut child_garbage_rows = garbage_rows;
    if landed > 0 {
        let len = outcome.board.len;
        let mask = crate::movegen::FULL_ROW ^ (1 << well_column(&outcome.board));
        let mut shifted = Board::new(len);
        let mut shifted_flags = GarbageRows::new(len);
        for row in 0..len {
            let source = row + landed as usize;
            if source < len {
                shifted.rows[row] = outcome.board.rows[source];
                shifted_flags.rows[row] = garbage_rows.rows[source];
            } else {
                shifted.rows[row] = mask;
                shifted_flags.rows[row] = 1;
            }
        }
        board = shifted;
        child_garbage_rows = shifted_flags;
    }
    let features: Features = board_features(&board, 0);
    // Referee death rule (occupied-buffer): any occupied cell above the visible
    // 20-row field after the lock is a loss. Death is TERMINAL, not null.
    let dead = features[F_MAX_HEIGHT] >= (board.len as i32).min(21);
    let scale = ctx.scale(node.depth);
    let accumulated = node.reward + scale * (reward - ctx.exposure * features[F_DANGER] as f64);

    let child = Node {
        board,
        garbage_rows: Some(child_garbage_rows),
        hold: option.hold,
        next: option.next,
        can_hold: true,
        b2b: b2b_chain > 0,
        b2b_chain,
        combo,
        pending,
        lift: 0,
        due_this_lock: 0,
        dead,
        tslot: features[F_TSLOT],
        reward: accumulated,
        value: 0.0,
        depth: node.depth + 1,
        step: Some(Step { placement, used_hold: option.used_hold, lines_cleared: lines, attack, reward }),
        parent: parent_index,
        root: if node.depth == 0 { root_index } else { node.root },
    };

    // C1: the stock potential is a terminal estimate inside the same discounted
    // bracket as the board evaluation. Skipped when absent or scaled to 0.
    let phi = match ctx.stock {
        Some(params) if params.scale != 0.0 => stock_potential(
            &StockState {
                chain: child.b2b_chain,
                combo: child.combo,
                pending: child.pending,
                max_height: features[F_MAX_HEIGHT],
                t_slot: features[F_TSLOT],
                well_depth: features[F_WELL_DEPTH],
                multiplier,
            },
            &params,
            w.attack,
            w.discount,
        ),
        _ => 0.0,
    };
    // C2: the solvency penalty shares the terminal bracket. Skipped when absent or
    // coefficient 0.
    let risk = match ctx.solvency {
        Some(params) if params.coefficient != 0.0 => {
            solvency_penalty(features[F_MAX_HEIGHT], child.pending, &params, 20)
        }
        _ => 0.0,
    };
    let b2b_state = if w.b2b_state != 0.0 && child.b2b_chain >= 1 { w.b2b_state } else { 0.0 };
    let (hole_runs, hole_shifts) = if w.hole_runs != 0.0 || w.hole_shifts != 0.0 {
        hole_geometry(&board)
    } else {
        (0, 0)
    };
    // The TS bracket, in its exact left-to-right order:
    // dot + stateValue + holeRuns term + holeShifts term + Φ − risk.
    let value = accumulated
        + scale
            * w.discount
            * (w.dot(&features)
                + b2b_state
                + if w.hole_runs != 0.0 { w.hole_runs * hole_runs as f64 } else { 0.0 }
                + if w.hole_shifts != 0.0 { w.hole_shifts * hole_shifts as f64 } else { 0.0 }
                + phi
                - risk);
    Node { value, ..child }
}

/// Column with the lowest stack (the board's well), in board coordinates
/// (`wellColumn` in search.ts; first minimal column wins).
fn well_column(board: &Board) -> i32 {
    let mut well = 0i32;
    let mut lowest = i32::MAX;
    for x in 0..10 {
        let mut height = 0i32;
        for row in 0..board.len {
            if board.rows[row] & (1 << x) != 0 {
                height = board.len as i32 - row as i32;
                break;
            }
        }
        if height < lowest {
            lowest = height;
            well = x;
        }
    }
    well
}

/// The referee witness key for a root placement, in the exact shape the S2 lab's
/// `run-match.mjs` builds it (`${kind}:${usedHold}:${lastSrs > 0}:${cellKey(cells)}`,
/// cells from `placementCells`: `[x + c.x, 39 - y - c.y]`, string-sorted, `;`-joined).
fn witness_key(p: &Placement, used_hold: bool) -> String {
    let mut cells: Vec<String> = cells_for(p.kind, p.rotation as usize)
        .iter()
        .map(|&(cx, cy)| format!("{},{}", p.x as i32 + cx, 39 - p.y as i32 - cy))
        .collect();
    cells.sort();
    format!("{}:{}:{}:{}", p.kind.as_char(), used_hold, p.last_srs > 0, cells.join(";"))
}

/// Terminal state value (`stateValue` in search.ts): the weighted board plus the adopt
/// state terms (C1, C2, C4), each skipped when its weight is 0 so the default is exactly `dot`.
#[inline(always)]
fn state_value(ctx: &Ctx, features: &Features, board: &Board, b2b: bool, child: &PieceOption) -> f64 {
    let w = ctx.w;
    let mut total = w.dot(features);
    if !ctx.adopt {
        return total;
    }
    if w.b2b_state != 0.0 && b2b {
        total += w.b2b_state;
    }
    if let Some(chain) = &ctx.t_slot_chain {
        let known = ctx.t_left.len() - 1;
        let ahead = if child.next as usize <= known { ctx.t_left[child.next as usize] + ctx.bag_credit } else { 0 };
        let depth = 3.min((child.hold == Some(Kind::T)) as i32 + ahead);
        let donations = tslot_donations(board, depth);
        for lines in 0..4 { total += donations[lines] as f64 * chain[lines]; }
    }
    if w.hold_t != 0.0 && child.hold == Some(Kind::T) { total += w.hold_t; }
    if w.hold_i != 0.0 && child.hold == Some(Kind::I) { total += w.hold_i; }
    total
}

/// A depth-1 child: its step (for the candidate list) plus the post-lock state the
/// S2 root solvency veto reads (board features at its lift, residual pending).
#[derive(Clone, Copy)]
struct FirstMove {
    step: Step,
    board: Board,
    lift: i32,
    pending: i32,
}

impl Searcher {
    pub fn new() -> Searcher {
        Searcher::default()
    }

    pub fn search(&mut self, input: &SearchInput, options: &SearchOptions) -> Option<SearchResult> {
        let w = &options.weights;
        let mut sequence: Vec<Kind> = Vec::with_capacity(input.preview.len() + 1);
        sequence.push(input.active.0);
        sequence.extend_from_slice(&input.preview);
        let mut t_left = vec![0i32; sequence.len() + 1];
        for i in (0..sequence.len()).rev() { t_left[i] = t_left[i + 1] + (sequence[i] == Kind::T) as i32; }
        let ctx = Ctx {
            w,
            exposure: options.exposure,
            guideline: options.guideline,
            adopt: options.profile == SearchProfile::Guideline,
            t_slot_chain: if options.profile == SearchProfile::Guideline && w.t_slot_chain.iter().any(|&v| v != 0.0) { Some(w.t_slot_chain) } else { None },
            t_left,
            bag_credit: (input.speculative.contains(&Kind::T) as i32) + (!input.speculative.is_empty() && input.speculative.len() <= 3) as i32,
            scale: (0..32).map(|d| w.discount.powi(d)).collect(),
            root_frame: input.frame,
            mult: Cell::new(MultiplierCache::new()),
            stock: options.stock,
            solvency: options.solvency,
        };
        // Movegen switches follow the rules profile exactly as in TS search():
        // the S2 profile turns on spin evidence and 180° inputs with the S2 table.
        let gen_opts = match options.profile {
            SearchProfile::Guideline => GenOptions::default(),
            SearchProfile::S2 => GenOptions { spin_evidence: true, rotate180: true, kicks180_s2: true },
        };
        let s2 = options.profile == SearchProfile::S2;
        let mut future: Vec<Kind> = sequence.clone();
        future.push(Kind::I);
        let rows = input.board.len;

        let root_features = board_features(&input.board, 0);
        self.arena.clear();
        self.arena.push(Node {
            board: input.board,
            garbage_rows: input.garbage_rows,
            hold: input.hold,
            next: 0,
            can_hold: input.can_hold,
            b2b: input.b2b_chain.map(|c| c > 0).unwrap_or(input.b2b),
            b2b_chain: input.b2b_chain.unwrap_or(if input.b2b { 1 } else { 0 }),
            combo: input.combo,
            pending: input.pending,
            lift: 0,
            due_this_lock: input.due_this_lock,
            dead: false,
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
        // Every depth-1 child, indexed by `root`: its step (for candidates) and the
        // post-lock state the S2 root veto reads (board, lift, pending).
        let mut first_moves: Vec<FirstMove> = Vec::new();
        // (arena index, value) — value may differ from the node's (chance average).
        let mut finished: Vec<(u32, f64)> = Vec::new();
        let mut deepest: Vec<u32> = Vec::new();
        let mut opts = [PieceOption { kind: Kind::I, used_hold: false, next: 0, hold: None }; 2];
        let mut seen: HashSet<DedupeKey> = HashSet::new();
        let mut seen_diverse: HashSet<SelectBeamKey> = HashSet::new();

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
                                self.movegen.generate_with(
                                    &node.board,
                                    option.kind,
                                    spawn_position(option.kind, node.board.len),
                                    gen_opts,
                                    &mut self.spec_placements,
                                );
                                for placement in &self.spec_placements {
                                    // The chance ply reads values only; S2 dead
                                    // children still count (expandS2 never returns
                                    // null, and TS takes the max over all of them).
                                    let child = if s2 {
                                        Some(expand_s2(&ctx, &node, ni, placement, option, 0))
                                    } else {
                                        expand(&ctx, &node, ni, placement, option, 0, 0)
                                    };
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
                    self.movegen.generate_with(&node.board, option.kind, start, gen_opts, &mut self.placements);
                    for placement in &self.placements {
                        // Referee kickset witness (root only): an unwitnessed root is
                        // skipped before expansion and does not count as a node.
                        if node.depth == 0 {
                            if let Some(keys) = &input.accept_root_keys {
                                if !keys.contains(&witness_key(placement, option.used_hold)) {
                                    continue;
                                }
                            }
                        }
                        let child = if s2 {
                            Some(expand_s2(&ctx, &node, ni, placement, option, first_moves.len() as i32))
                        } else {
                            expand(
                                &ctx,
                                &node,
                                ni,
                                placement,
                                option,
                                input.pending,
                                first_moves.len() as i32,
                            )
                        };
                        nodes += 1;
                        let Some(child) = child else { continue };
                        if node.depth == 0 {
                            first_moves.push(FirstMove {
                                step: child.step.unwrap(),
                                board: child.board,
                                lift: child.lift,
                                pending: child.pending,
                            });
                        }
                        if child.dead {
                            // S2: dead lines are leaves — valued for the fallback /
                            // best-try choice, never expanded.
                            let idx = self.arena.len() as u32;
                            self.arena.push(child);
                            finished.push((idx, child.value));
                        } else {
                            self.children.push(child);
                        }
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
                select_beam(children, &self.order, options.width, options.profile, &mut seen_diverse)
            } else {
                dedupe(children, &self.order, options.width, options.guideline, options.profile, &mut seen)
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
        // One pass over the leaves in their original order: the best leaf overall
        // and, per root, the best value (insertion order = first leaf seen per root)
        // and the leaf that attains it (for the S2 veto).
        let mut best_leaf: Option<(u32, f64)> = None;
        let mut root_best: Vec<(i32, f64)> = Vec::new();
        let mut best_leaf_by_root: Vec<(i32, u32)> = Vec::new();
        for &(i, v) in &leaves {
            let node = &self.arena[i as usize];
            if node.depth == 0 {
                continue;
            }
            if best_leaf.is_none_or(|(_, bv)| v > bv) {
                best_leaf = Some((i, v));
            }
            if let Some(pos) = root_best.iter().position(|(r, _)| *r == node.root) {
                if v > root_best[pos].1 {
                    root_best[pos].1 = v;
                    best_leaf_by_root[pos].1 = i;
                }
            } else {
                root_best.push((node.root, v));
                best_leaf_by_root.push((node.root, i));
            }
        }
        let (mut best_index, mut best_value) = best_leaf?;

        // S2 hard root solvency veto — the champion's choose_rescue as a pure
        // decision-stage filter over the ranked root lines (search.ts). If the
        // value-best root is insolvent and any other root is solvent, play the
        // FIRST solvent root in rank order. Search values are untouched.
        if s2 && options.root_veto {
            let margin_of = |root: i32| -> i32 {
                let fm = &first_moves[root as usize];
                let f = board_features(&fm.board, fm.lift);
                solvency_margin(f[F_MAX_HEIGHT], fm.pending, 20)
            };
            let best_root = self.arena[best_index as usize].root;
            if margin_of(best_root) < 0 {
                let mut ranked: Vec<usize> = (0..root_best.len()).collect();
                ranked.sort_by(|&a, &b| {
                    root_best[b].1.partial_cmp(&root_best[a].1).unwrap_or(std::cmp::Ordering::Equal)
                });
                for pos in ranked {
                    let root = root_best[pos].0;
                    if root == best_root {
                        continue;
                    }
                    if margin_of(root) >= 0 {
                        best_index = best_leaf_by_root[pos].1;
                        best_value = root_best[pos].1;
                        break;
                    }
                }
            }
        }

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

        root_best.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let candidates = root_best
            .iter()
            .map(|&(r, v)| {
                let s = first_moves[r as usize].step;
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

/// Dedupe key, one variant per profile (equality never crosses variants: a run uses one).
#[derive(Clone, PartialEq, Eq, Hash)]
enum DedupeKey {
    /// (next, hold, b2b_active, board): the legacy key.
    Guideline(u32, Option<Kind>, bool, Board),
    /// (next, hold, b2b_chain, combo, lift, pending, garbage_rows, board): production S2 lab key.
    /// Has no `can_hold` segment and never folds `combo` under `guideline`.
    S2(u32, Option<Kind>, i32, i32, i32, i32, Option<GarbageRows>, Board),
}

/// Keep the best `width` children, dropping later copies of an identical position
/// (`dedupe` in search.ts).
///
/// Under `Guideline` the legacy key (next, hold, b2b, board) is preserved so the frozen
/// guideline/Hoiko record is unchanged. Under `S2` the key matches the production S2 lab
/// key (`next|hold|b2bChain|combo|lift|pending|flagsKey(garbageRows)|board`): `can_hold` is
/// omitted and `_guideline` is ignored (combo is never folded).
fn dedupe(
    children: &[Node],
    order: &[u32],
    width: usize,
    _guideline: bool,
    profile: SearchProfile,
    seen: &mut HashSet<DedupeKey>,
) -> Vec<u32> {
    seen.clear();
    let mut kept = Vec::with_capacity(width);
    for &i in order {
        if kept.len() >= width {
            break;
        }
        let n = &children[i as usize];
        let key = match profile {
            SearchProfile::Guideline => DedupeKey::Guideline(n.next, n.hold, n.b2b, n.board),
            SearchProfile::S2 => DedupeKey::S2(
                n.next,
                n.hold,
                n.b2b_chain,
                n.combo,
                n.lift,
                n.pending,
                n.garbage_rows,
                n.board,
            ),
        };
        if !seen.insert(key) {
            continue;
        }
        kept.push(i);
    }
    kept
}

/// (next, hold, can_hold, b2b, combo, lift, pending, garbage_rows, board).
/// `b2b` is `b2b_chain` under `S2` and `b2b as i32` (0/1) under `Guideline`.
type SelectBeamKey = (u32, Option<Kind>, bool, i32, i32, i32, i32, Option<GarbageRows>, Board);

/// Keep distinct attack economies and reserve a bounded set of first moves (`selectBeam`).
///
/// Matches TS `selectBeam` (`src/ai/bot/search.ts`): carries `can_hold`, `combo`, `lift`,
/// `pending`, and `garbage_rows` under both profiles; `b2b` is `b2b_chain` under `S2` and
/// `0/1` under `Guideline` (guideline children carry `pending: 0` and `garbage_rows: None`,
/// preserving the guideline pool partition).
fn select_beam(
    children: &[Node],
    order: &[u32],
    width: usize,
    profile: SearchProfile,
    seen: &mut HashSet<SelectBeamKey>,
) -> Vec<u32> {
    if width == 0 {
        return Vec::new();
    }
    seen.clear();
    let mut pool: Vec<u32> = Vec::new();
    for &i in order {
        let n = &children[i as usize];
        let b2b = match profile {
            SearchProfile::S2 => n.b2b_chain,
            SearchProfile::Guideline => n.b2b as i32,
        };
        if !seen.insert((
            n.next,
            n.hold,
            n.can_hold,
            b2b,
            n.combo,
            n.lift,
            n.pending,
            n.garbage_rows,
            n.board,
        )) {
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The scale's float exactness rests on `powi` matching Bun's `0.97 ** d`
    /// bit for bit; `powf` differs by one ULP at most depths >= 6 (the original
    /// SEARCH-PORT.md rounding divergence). Pin the bits Bun produced so a
    /// future "simplification" back to powf fails loudly here first.
    #[test]
    fn discount_powi_bits_match_bun() {
        for (depth, bits) in [
            (0, 0x3ff0000000000000u64),
            (5, 0x3feb7abfc78b016b),
            (6, 0x3feaa7b4e7f4ea56),
            (20, 0x3fe166c364d3d894),
        ] {
            assert_eq!(0.97f64.powi(depth).to_bits(), bits, "depth {depth}");
        }
    }

    /// Bottom rows of a 40-row board, lowest last (engine row order).
    fn board(rows: &[u16]) -> Board {
        let mut b = Board::new(40);
        let off = 40 - rows.len();
        b.rows[off..].copy_from_slice(rows);
        b
    }

    fn midgame() -> Board {
        board(&[
            0b0000000000,
            0b1000000000,
            0b1100000001,
            0b1110000011,
            0b1111000111,
            0b1101101111,
            0x3ff ^ 0b10,
            0x3ff ^ 0b100,
        ])
    }

    fn input(board: Board, kind: Kind, preview: &[Kind], b2b: bool, speculative: &[Kind]) -> SearchInput {
        SearchInput::new(
            board,
            (kind, spawn_position(kind, board.len)),
            None,
            true,
            preview.to_vec(),
            b2b,
            -1,
            0,
            speculative.to_vec(),
        )
    }

    fn opts(weights: Weights) -> SearchOptions {
        SearchOptions {
            weights,
            width: 24,
            diverse: false,
            exposure: 0.0,
            guideline: true,
            profile: SearchProfile::Guideline,
            stock: None,
            solvency: None,
            root_veto: false,
        }
    }

    /// Everything the agreement harness compares, with values as bits.
    fn fingerprint(r: &Option<SearchResult>) -> String {
        match r {
            None => "null".into(),
            Some(r) => format!(
                "{:?}|{:?}|{:x}|{:?}|{}|{}",
                r.best,
                r.line,
                r.value.to_bits(),
                r.candidates.iter().map(|c| (c.placement, c.used_hold, c.value.to_bits())).collect::<Vec<_>>(),
                r.nodes,
                r.depth
            ),
        }
    }

    #[test]
    fn c1_b2b_state_zero_is_bit_identical() {
        let mut s = Searcher::new();
        for b2b in [false, true] {
            for spec in [&[][..], &[Kind::S, Kind::Z, Kind::J][..]] {
                let i = input(midgame(), Kind::T, &[Kind::I, Kind::L, Kind::O], b2b, spec);
                let base = fingerprint(&s.search(&i, &opts(Weights::default())));
                let zero = Weights { b2b_state: 0.0, ..Weights::default() };
                assert_eq!(fingerprint(&s.search(&i, &opts(zero))), base);
            }
        }
    }

    #[test]
    fn c1_b2b_state_adds_discounted_value_when_alive() {
        let mut s = Searcher::new();
        let mut i = input(Board::new(40), Kind::J, &[], true, &[]);
        i.can_hold = false;
        let off = s.search(&i, &opts(Weights::default())).unwrap();
        let on = s.search(&i, &opts(Weights { b2b_state: 100.0, ..Weights::default() })).unwrap();
        assert_eq!(on.best, off.best);
        assert_eq!(on.candidates.len(), off.candidates.len());
        for (a, b) in on.candidates.iter().zip(&off.candidates) {
            assert!((a.value - b.value - 97.0).abs() < 1e-9);
        }
        // No B2B anywhere: the term never fires and the result is bit-identical.
        let i = input(Board::new(40), Kind::J, &[Kind::L], false, &[]);
        let off = fingerprint(&s.search(&i, &opts(Weights::default())));
        let on = fingerprint(&s.search(&i, &opts(Weights { b2b_state: 100.0, ..Weights::default() })));
        assert_eq!(on, off);
    }

    #[test]
    fn c2_tslot_chain_zero_is_identical_and_held_t_unlocks_value() {
        let mut s = Searcher::new();
        let stacked = board(&[(1 << 2) | (1 << 8), 0x3ff ^ (0b111 << 6), 0x3ff ^ (1 << 7), 0x3ff ^ 0b111, 0x3ff ^ 0b10, 0x3ff ^ (1 << 9)]);
        let mut i = input(stacked, Kind::T, &[Kind::I, Kind::L, Kind::O], false, &[Kind::S, Kind::Z, Kind::T]);
        let base = fingerprint(&s.search(&i, &opts(Weights::default())));
        assert_eq!(fingerprint(&s.search(&i, &opts(Weights { t_slot_chain: [0.0; 4], ..Weights::default() }))), base);

        let tsd = board(&[0b100, 0x3ff ^ 0b111, 0x3ff ^ 0b10, 0x3ff ^ (1 << 9)]);
        i = input(tsd, Kind::O, &[], false, &[]);
        i.hold = Some(Kind::T);
        i.can_hold = false;
        let off = s.search(&i, &opts(Weights::default())).unwrap();
        let on = s.search(&i, &opts(Weights { t_slot_chain: [0.0, 0.0, 100.0, 0.0], ..Weights::default() })).unwrap();
        assert!(on.candidates.iter().any(|c| off.candidates.iter().any(|o| c.placement == o.placement && (c.value - o.value - 97.0).abs() < 1e-9)));
        i.hold = Some(Kind::I);
        let off = fingerprint(&s.search(&i, &opts(Weights::default())));
        let on = fingerprint(&s.search(&i, &opts(Weights { t_slot_chain: [0.0, 0.0, 100.0, 0.0], ..Weights::default() })));
        assert_eq!(on, off);
    }

    #[test]
    fn guideline_adopt_terms_do_not_apply_under_the_s2_profile() {
        // The TS S2 bracket reads b2bState (its own C1 term) but never the guideline
        // adopt terms (tSlotChain, holdT, holdI), which live only in the guideline
        // path's stateValue. With those three on and b2bState off, S2 is identical.
        let mut s = Searcher::new();
        let mut i = input(Board::new(40), Kind::J, &[], true, &[]);
        i.can_hold = false;
        let s2 = |w: Weights| SearchOptions { profile: SearchProfile::S2, ..opts(w) };
        let off = fingerprint(&s.search(&i, &s2(Weights::default())));
        let guideline_terms = Weights {
            t_slot_chain: [0.0, 1.0, 2.0, 3.0],
            hold_t: 40.0,
            hold_i: 20.0,
            ..Weights::default()
        };
        assert_eq!(fingerprint(&s.search(&i, &s2(guideline_terms))), off);
        // b2bState is the S2 bracket's own term: with a live chain it must move values.
        let on = s.search(&i, &s2(Weights { b2b_state: 100.0, ..Weights::default() })).unwrap();
        let base = s.search(&i, &s2(Weights::default())).unwrap();
        assert!(on.candidates.iter().zip(&base.candidates).any(|(a, b)| a.value != b.value));
    }

    #[test]
    fn c4_hold_value_adds_discounted_value_by_held_piece() {
        let mut s = Searcher::new();
        let on = Weights { hold_t: 40.0, hold_i: 25.0, ..Weights::default() };
        for (held, gain) in [(Kind::T, 40.0), (Kind::I, 25.0), (Kind::O, 0.0)] {
            let mut i = input(Board::new(40), Kind::J, &[], false, &[]);
            i.hold = Some(held);
            i.can_hold = false;
            let off = s.search(&i, &opts(Weights::default())).unwrap();
            let r = s.search(&i, &opts(on.clone())).unwrap();
            assert_eq!(r.best, off.best);
            for (a, b) in r.candidates.iter().zip(&off.candidates) {
                assert!((a.value - b.value - 0.97 * gain).abs() < 1e-9);
            }
        }
    }

    #[test]
    fn c2_c4_off_is_bit_identical_on_midgame() {
        let mut s = Searcher::new();
        for hold in [None, Some(Kind::T), Some(Kind::I)] {
            for spec in [&[][..], &[Kind::T, Kind::S][..]] {
                let mut i = input(midgame(), Kind::T, &[Kind::I, Kind::L, Kind::O], true, spec);
                i.hold = hold;
                let base = fingerprint(&s.search(&i, &opts(Weights::default())));
                let zero = Weights { t_slot_chain: [0.0; 4], hold_t: 0.0, hold_i: 0.0, ..Weights::default() };
                assert_eq!(fingerprint(&s.search(&i, &opts(zero))), base);
            }
        }
    }

    fn base_node() -> Node {
        let mut rows = [0u16; 20];
        rows[18] = 0x3f0;
        rows[19] = 0x3fe;
        Node {
            board: Board::from_rows(&rows),
            garbage_rows: None,
            hold: Some(Kind::T),
            next: 2,
            can_hold: true,
            b2b: false,
            b2b_chain: 0,
            combo: -1,
            pending: 0,
            lift: 0,
            due_this_lock: 0,
            dead: false,
            tslot: 0,
            reward: 0.0,
            value: 0.0,
            depth: 1,
            step: None,
            parent: 0,
            root: 0,
        }
    }

    fn run_dedupe(nodes: &[Node], width: usize, guideline: bool, profile: SearchProfile) -> Vec<usize> {
        let order: Vec<u32> = (0..nodes.len() as u32).collect();
        let mut seen = HashSet::new();
        dedupe(nodes, &order, width, guideline, profile, &mut seen).into_iter().map(|i| i as usize).collect()
    }

    fn run_select_beam(nodes: &[Node], width: usize, profile: SearchProfile) -> Vec<usize> {
        let order: Vec<u32> = (0..nodes.len() as u32).collect();
        let mut seen = HashSet::new();
        select_beam(nodes, &order, width, profile, &mut seen).into_iter().map(|i| i as usize).collect()
    }

    #[test]
    fn dedupe_merges_true_duplicates_under_both_profiles() {
        let a = base_node();
        let b = base_node();
        for profile in [SearchProfile::Guideline, SearchProfile::S2] {
            assert_eq!(run_dedupe(&[a, b], 10, false, profile), vec![0]);
        }
    }

    #[test]
    fn dedupe_s2_keeps_states_differing_only_in_combo() {
        let chain = Node { combo: 3, ..base_node() };
        let cold = Node { combo: -1, ..base_node() };
        assert_eq!(run_dedupe(&[chain, cold], 10, false, SearchProfile::S2), vec![0, 1]);
    }

    #[test]
    fn dedupe_s2_keeps_states_differing_only_in_lift() {
        let clean = Node { lift: 0, ..base_node() };
        let lifted = Node { lift: 4, ..base_node() };
        for guideline in [false, true] {
            assert_eq!(run_dedupe(&[clean, lifted], 10, guideline, SearchProfile::S2), vec![0, 1]);
        }
    }

    #[test]
    fn dedupe_s2_merges_states_differing_only_in_can_hold() {
        let a = Node { can_hold: true, ..base_node() };
        let b = Node { can_hold: false, ..base_node() };
        assert_eq!(run_dedupe(&[a, b], 10, false, SearchProfile::S2), vec![0]);
    }

    #[test]
    fn dedupe_s2_never_folds_combo_even_with_guideline_flag() {
        let chain = Node { combo: 3, ..base_node() };
        let cold = Node { combo: -1, ..base_node() };
        assert_eq!(run_dedupe(&[chain, cold], 10, true, SearchProfile::S2), vec![0, 1]);
    }

    #[test]
    fn dedupe_s2_separates_by_exact_b2b_chain() {
        let c1 = Node { b2b: true, b2b_chain: 1, ..base_node() };
        let c3 = Node { b2b: true, b2b_chain: 3, ..base_node() };
        assert_eq!(run_dedupe(&[c1, c3], 10, false, SearchProfile::S2), vec![0, 1]);
        assert_eq!(run_dedupe(&[c1, c3], 10, false, SearchProfile::Guideline), vec![0]);
    }

    #[test]
    fn dedupe_s2_keeps_states_differing_only_in_pending() {
        let clear = Node { pending: 0, ..base_node() };
        let pressured = Node { pending: 5, ..base_node() };
        assert_eq!(run_dedupe(&[clear, pressured], 10, false, SearchProfile::S2), vec![0, 1]);
    }

    #[test]
    fn dedupe_s2_keeps_states_differing_only_in_garbage_rows() {
        let clean = GarbageRows::from_rows(&[0u8; 20]);
        let mut flagged_rows = [0u8; 20];
        flagged_rows[19] = 1;
        let flagged = GarbageRows::from_rows(&flagged_rows);

        let a = Node { garbage_rows: Some(clean), ..base_node() };
        let b = Node { garbage_rows: Some(flagged), ..base_node() };
        let c = Node { garbage_rows: None, ..base_node() };
        assert_eq!(run_dedupe(&[a, b], 10, false, SearchProfile::S2), vec![0, 1]);
        assert_eq!(run_dedupe(&[c, a], 10, false, SearchProfile::S2), vec![0, 1]);
    }

    #[test]
    fn dedupe_guideline_keeps_legacy_key_merging_non_legacy_fields() {
        let mut flagged_rows = [0u8; 20];
        flagged_rows[19] = 1;
        let base = base_node();
        let variants = [
            Node { combo: 3, ..base },
            Node { lift: 4, ..base },
            Node { can_hold: false, ..base },
            Node { pending: 5, ..base },
            Node { garbage_rows: Some(GarbageRows::from_rows(&flagged_rows)), ..base },
        ];
        for diff in variants {
            for guideline in [false, true] {
                assert_eq!(run_dedupe(&[base, diff], 10, guideline, SearchProfile::Guideline), vec![0]);
            }
        }
    }

    #[test]
    fn dedupe_guideline_still_separates_b2b_hold_and_next() {
        let base = base_node();
        let variants = [
            Node { b2b: true, b2b_chain: 1, ..base },
            Node { hold: Some(Kind::I), ..base },
            Node { next: 3, ..base },
        ];
        for diff in variants {
            assert_eq!(run_dedupe(&[base, diff], 10, false, SearchProfile::Guideline), vec![0, 1]);
        }
    }

    #[test]
    fn select_beam_respects_profile_for_b2b_chain_pending_and_garbage_rows() {
        let mut flagged_rows = [0u8; 20];
        flagged_rows[19] = 1;
        let base = Node { value: 10.0, ..base_node() };

        // Under S2, b2b_chain, pending, garbage_rows, and can_hold are all kept distinct.
        let c1 = Node { b2b: true, b2b_chain: 1, value: 10.0, ..base };
        let c3 = Node { b2b: true, b2b_chain: 3, value: 9.0, ..base };
        assert_eq!(run_select_beam(&[c1, c3], 10, SearchProfile::S2), vec![0, 1]);
        assert_eq!(run_select_beam(&[c1, c3], 10, SearchProfile::Guideline), vec![0]);

        let p0 = Node { pending: 0, value: 10.0, ..base };
        let p5 = Node { pending: 5, value: 9.0, ..base };
        assert_eq!(run_select_beam(&[p0, p5], 10, SearchProfile::S2), vec![0, 1]);

        let g_none = Node { garbage_rows: None, value: 10.0, ..base };
        let g_flag = Node { garbage_rows: Some(GarbageRows::from_rows(&flagged_rows)), value: 9.0, ..base };
        assert_eq!(run_select_beam(&[g_none, g_flag], 10, SearchProfile::S2), vec![0, 1]);

        let h_true = Node { can_hold: true, value: 10.0, ..base };
        let h_false = Node { can_hold: false, value: 9.0, ..base };
        assert_eq!(run_select_beam(&[h_true, h_false], 10, SearchProfile::S2), vec![0, 1]);
        assert_eq!(run_select_beam(&[h_true, h_false], 10, SearchProfile::Guideline), vec![0, 1]);
    }
}
