use std::collections::HashSet;

use crate::board::{
    Board, COLS, ROWS, collides, compute_lock_afterstate, count_filled_rows, is_empty,
};
use crate::deepseek_score::ds_heights;
use crate::evaluation::{Evaluation, PlyContext};
use crate::features::extract_features;
use crate::pieces::{PieceKind, bottom_cells};
use crate::scorer::{engine_kind, fire_score};
use crate::kick::enumerate_kick_placements;
use crate::tspin::{TspinKind, classify_placement};
use crate::search::{ScoredPlacement, enumerate_scored};
use crate::weights::{FireWeights, Weights, score_placement};

/// Pluggable ply-0 placement generator (the TS v2 `placementGenerator`).
pub trait PlacementGenerator {
    fn generate(&self, board: &Board, kind: PieceKind, weights: &Weights) -> Vec<ScoredPlacement>;
}

pub const SETUP_GAMMA: f64 = 0.55;
pub const SETUP_WELL_STEP: f64 = 0.0;
pub const SUSTAIN_WELL_STEP: f64 = 160.0;
pub const SUSTAIN_MIN_DEPTH: usize = 5;
pub const SUSTAIN_MAX_HEIGHT: f64 = 12.0;
pub const DEFAULT_WIDTH: usize = 24;
pub const DEFAULT_DEPTH: usize = 6;
pub const DEFAULT_TOP_K: usize = 16;

#[derive(Clone)]
struct BeamNode {
    board: Board,
    hold: Option<PieceKind>,
    can_hold: bool,
    b2b: bool,
    combo: i32,
    queue_index: usize,
    total_score: f64,
    first_rotation: i32,
    first_x: i32,
    first_y: i32,
    first_hold: bool,
    lines_cleared: u32,
    tspin: bool,
    fire_score: f64,
    pending: i32,
}

/// Best-move result plus the root-placement detail the host needs to build a
/// faithful `placeAt` execution plan and `getDebug` telemetry.
///
/// `rotation`/`x`/`use_hold` are the chosen first move (the beam's best leaf);
/// `y`/`score`/`lines_cleared`/`tspin`/`fire_score`/`after` mirror the root
/// placement the TS `beamBestMove` returns (the highest-scoring first move that
/// shares the chosen rotation/x/use-hold), so the wasm adapter can reproduce
/// TS v2's execution exactly. Search tie-breaks are untouched.
#[derive(Clone, Copy, Debug)]
pub struct BeamBest {
    pub rotation: i32,
    pub x: i32,
    pub y: i32,
    pub use_hold: bool,
    pub score: f64,
    pub lines_cleared: u32,
    pub tspin: bool,
    pub fire_score: f64,
    pub search_depth: usize,
    pub after: Board,
}

pub struct BeamOptions<'a> {
    pub weights: &'a Weights,
    pub fire: &'a FireWeights,
    pub width: usize,
    pub depth: usize,
    pub top_k: usize,
    pub use_hold: bool,
    pub pending: i32,
    pub evaluation: &'a dyn Evaluation,
    pub placement_generator: Option<&'a dyn PlacementGenerator>,
    pub use_kick: bool,
}

pub fn beam_best_move(
    board: &Board,
    current: PieceKind,
    queue: &[PieceKind],
    hold: Option<PieceKind>,
    can_hold: bool,
    b2b: bool,
    combo: i32,
    options: &BeamOptions,
) -> Option<(i32, i32, bool)> {
    beam_best_move_details(board, current, queue, hold, can_hold, b2b, combo, options)
        .map(|best| (best.rotation, best.x, best.use_hold))
}

pub fn beam_best_move_details(
    board: &Board,
    current: PieceKind,
    queue: &[PieceKind],
    hold: Option<PieceKind>,
    can_hold: bool,
    b2b: bool,
    combo: i32,
    options: &BeamOptions,
) -> Option<BeamBest> {
    let depth = options.depth.min(queue.len() + 1);
    let mut pieces: Vec<PieceKind> = Vec::with_capacity(depth + 1);
    pieces.push(current);
    pieces.extend(queue.iter().take(depth).copied());

    let mut beam: Vec<BeamNode> = vec![BeamNode {
        board: *board,
        hold,
        can_hold,
        b2b,
        combo,
        queue_index: 0,
        total_score: 0.0,
        first_rotation: 0,
        first_x: 0,
        first_y: 0,
        first_hold: false,
        lines_cleared: 0,
        tspin: false,
        fire_score: 0.0,
        pending: options.pending,
    }];
    let mut first_moves: Vec<BeamNode> = Vec::new();

    for ply in 0..depth {
        let mut next_beam: Vec<BeamNode> = Vec::new();
        for node in &beam {
            let piece = match pieces.get(node.queue_index) {
                Some(&p) => p,
                None => {
                    next_beam.push(node.clone());
                    continue;
                }
            };
            let next_piece = pieces.get(node.queue_index + 1).copied();
            let expanded = expand_with_hold(
                node,
                piece,
                next_piece,
                ply == 0,
                ply as i32,
                options,
            );
            next_beam.extend(expanded);
        }
        if ply == 0 {
            first_moves = next_beam.clone();
        }
        if next_beam.is_empty() {
            break;
        }
        next_beam.sort_by(|a, b| b.total_score.partial_cmp(&a.total_score).unwrap_or(std::cmp::Ordering::Equal));
        beam = dedupe(next_beam).into_iter().take(options.width).collect();
    }

    first_moves.sort_by(|a, b| b.total_score.partial_cmp(&a.total_score).unwrap_or(std::cmp::Ordering::Equal));
    let mut seen = HashSet::new();
    first_moves.retain(|n| seen.insert((n.first_rotation, n.first_x, n.first_hold)));
    first_moves.truncate(options.width.max(options.top_k));

    let best = beam.first()?;
    let root = first_moves
        .iter()
        .find(|n| {
            n.first_rotation == best.first_rotation
                && n.first_x == best.first_x
                && n.first_hold == best.first_hold
        })
        .unwrap_or(best);
    Some(BeamBest {
        rotation: root.first_rotation,
        x: root.first_x,
        y: root.first_y,
        use_hold: root.first_hold,
        score: root.total_score,
        lines_cleared: root.lines_cleared,
        tspin: root.tspin,
        fire_score: root.fire_score,
        search_depth: depth,
        after: root.board,
    })
}

fn board_key(board: &Board, hold: Option<PieceKind>, can_hold: bool) -> (i32, i8, bool) {
    let mut h: i32 = 0;
    for &row in board.iter() {
        h = h.wrapping_mul(31).wrapping_add(row as i32);
    }
    (h, hold.map_or(-1, |k| k.code()), can_hold)
}

fn dedupe(nodes: Vec<BeamNode>) -> Vec<BeamNode> {
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(nodes.len());
    for n in nodes {
        if seen.insert(board_key(&n.board, n.hold, n.can_hold)) {
            out.push(n);
        }
    }
    out
}

fn expand_with_hold(
    node: &BeamNode,
    piece: PieceKind,
    next_piece: Option<PieceKind>,
    is_first: bool,
    ply: i32,
    options: &BeamOptions,
) -> Vec<BeamNode> {
    let mut out = Vec::new();
    let scored = rank_with_evaluation(
        node,
        piece,
        node.hold,
        next_piece,
        options,
        options.use_kick,
        ply,
    );
    for s in &scored {
        if let Some(child) = apply_placement(
            node,
            piece,
            s,
            false,
            is_first,
            ply,
            next_piece,
            options,
        ) {
            out.push(child);
        }
    }
    if options.use_hold && node.can_hold {
        match node.hold {
            Some(held) => {
                let scored_hold = rank_with_evaluation(
                    node,
                    held,
                    Some(held),
                    next_piece,
                    options,
                    options.use_kick,
                    ply,
                );
                for s in &scored_hold {
                    if let Some(child) = apply_placement(
                        node,
                        held,
                        s,
                        true,
                        is_first,
                        ply,
                        next_piece,
                        options,
                    ) {
                        out.push(child);
                    }
                }
            }
            None => {
                if let Some(np) = next_piece {
                    let scored_next = rank_with_evaluation(
                        node,
                        np,
                        node.hold,
                        next_piece,
                        options,
                        options.use_kick,
                        ply,
                    );
                    for s in &scored_next {
                        if let Some(child) = apply_placement(
                            node,
                            np,
                            s,
                            true,
                            is_first,
                            ply,
                            next_piece,
                            options,
                        ) {
                            let mut child = child;
                            child.queue_index += 1;
                            out.push(child);
                        }
                    }
                }
            }
        }
    }
    out
}

fn rank_with_evaluation(
    node: &BeamNode,
    piece: PieceKind,
    ctx_hold: Option<PieceKind>,
    next_piece: Option<PieceKind>,
    options: &BeamOptions,
    use_kick: bool,
    rank_ply: i32,
) -> Vec<ScoredPlacement> {
    let kick_here = use_kick && rank_ply == 0;
    let list = if rank_ply == 0 {
        if let Some(generator) = options.placement_generator {
            generator.generate(&node.board, piece, options.weights)
        } else if kick_here {
            enumerate_kick_placements(&node.board, piece, options.weights)
        } else {
            enumerate_scored(&node.board, piece, options.weights)
        }
    } else {
        enumerate_scored(&node.board, piece, options.weights)
    };
    let mut rescored: Vec<(ScoredPlacement, f64)> = Vec::with_capacity(list.len());
    for s in list {
        let tspin = piece == PieceKind::T
            && is_tspin_shape(&s.after, &bottom_cells(piece, s.rotation), s.x, s.y);
        let tspin_kind = classify_placement(&node.board, piece, s.rotation, s.x, s.y);
        let pending_after = (node.pending - s.lines_cleared as i32).max(0);
        let ctx = PlyContext {
            ply: 0,
            combo: node.combo,
            b2b: node.b2b,
            pending: node.pending,
            pending_after,
            weights: options.weights,
            fire: options.fire,
            piece: Some(piece),
            hold: ctx_hold,
            next_piece,
            tspin_kind,
        };
        if options.evaluation.veto(&s.after, s.lines_cleared, tspin) {
            continue;
        }
        let total = options.evaluation.rank(&s, piece, tspin, &ctx);
        if total > f64::NEG_INFINITY {
            rescored.push((s, total));
        }
    }
    rescored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    rescored.truncate(options.top_k);
    rescored.into_iter().map(|(s, _)| s).collect()
}

#[allow(clippy::too_many_arguments)]
fn apply_placement(
    node: &BeamNode,
    piece: PieceKind,
    s: &ScoredPlacement,
    used_hold: bool,
    is_first: bool,
    ply: i32,
    next_piece: Option<PieceKind>,
    options: &BeamOptions,
) -> Option<BeamNode> {
    let cells = bottom_cells(piece, s.rotation);
    let y = s.y;
    if collides(&node.board, &cells, s.x, y) {
        return None;
    }
    let transition = compute_lock_afterstate(&node.board, &cells, s.x, y);
    if transition.top_out && transition.lines_cleared == 0 {
        return None;
    }
    let test = transition.after;
    let before_rows = count_filled_rows(&node.board);
    let tspin = piece == PieceKind::T && is_tspin_shape(&test, &cells, s.x, y);
    // Engine verdict (what the lock awards) vs. the post-clear shape heuristic.
    let tspin_kind = classify_placement(&node.board, piece, s.rotation, s.x, y);
    let lines = transition.lines_cleared;
    let pending_after = (node.pending - lines as i32).max(0);
    let next_hold = if used_hold { Some(piece) } else { node.hold };
    let ctx = PlyContext {
        ply,
        combo: node.combo,
        b2b: node.b2b,
        pending: node.pending,
        pending_after,
        weights: options.weights,
        fire: options.fire,
        piece: Some(piece),
        hold: next_hold,
        next_piece,
        tspin_kind,
    };
    if options.evaluation.veto(&test, lines, tspin) {
        return None;
    }
    let mut landing_sum = 0f64;
    for c in &cells {
        landing_sum += (y + c.y + 1) as f64;
    }
    let avg_landing = landing_sum / cells.len() as f64;
    let eroded = lines as f64 * transition.piece_cells_in_cleared_rows as f64;
    let feat = extract_features(&test, avg_landing, eroded);
    let perfect_clear = before_rows > 0 && is_empty(&test);
    let next_combo = if lines > 0 { node.combo + 1 } else { -1 };
    let fscore = fire_score(
        lines,
        tspin,
        tspin_kind == TspinKind::Mini,
        node.b2b,
        next_combo,
        perfect_clear,
        options.fire,
    );
    let placement_score = score_placement(&feat, lines, options.weights);
    let total_score = node.total_score
        + placement_score
        + fscore
        + setup_credit(&test, lines, tspin, ply, options.fire)
        + sustain_credit(&test, lines, tspin, ply)
        + options.evaluation.score(&test, lines, tspin, &ctx);
    // Same predicate the engine applies on lock (issue #27).
    let next_b2b = if lines > 0 {
        game::garbage::is_difficult_clear(lines as i32, engine_kind(tspin_kind))
    } else {
        node.b2b
    };
    Some(BeamNode {
        board: test,
        hold: next_hold,
        can_hold: if used_hold { false } else { node.can_hold },
        b2b: next_b2b,
        combo: next_combo,
        queue_index: node.queue_index + 1,
        total_score,
        first_rotation: if is_first { s.rotation } else { node.first_rotation },
        first_x: if is_first { s.x } else { node.first_x },
        first_y: if is_first { s.y } else { node.first_y },
        first_hold: if is_first { used_hold } else { node.first_hold },
        lines_cleared: lines,
        tspin,
        fire_score: fscore,
        pending: pending_after,
    })
}

fn well_col_of(after: &Board) -> usize {
    let h = ds_heights(after);
    let mut col = 0usize;
    let mut best = h[0];
    for x in 1..COLS {
        let v = h[x];
        if v < best || (v == best && (x == 0 || x == COLS - 1)) {
            best = v;
            col = x;
        }
    }
    col
}

fn well_depth_of(after: &Board) -> usize {
    let h = ds_heights(after);
    let mut best = 0usize;
    for x in 0..COLS {
        let left = if x == 0 { f64::INFINITY } else { h[x - 1] };
        let right = if x == COLS - 1 {
            f64::INFINITY
        } else {
            h[x + 1]
        };
        let depth = left.min(right) - h[x];
        if depth > best as f64 {
            best = depth as usize;
        }
    }
    best
}

pub fn sustain_credit(after: &Board, lines: u32, tspin: bool, ply: i32) -> f64 {
    if lines > 0 || tspin {
        return 0.0;
    }
    let shape = extract_features(after, 0.0, 0.0);
    if shape.holes > 0.0 {
        return 0.0;
    }
    if shape.max_height < SUSTAIN_MIN_DEPTH as f64 || shape.max_height > SUSTAIN_MAX_HEIGHT {
        return 0.0;
    }
    let depth = well_depth_of(after);
    if depth < SUSTAIN_MIN_DEPTH {
        return 0.0;
    }
    let col = well_col_of(after);
    if col != 0 && col != COLS - 1 {
        return 0.0;
    }
    if ply > 2 {
        return 0.0;
    }
    SETUP_GAMMA.powi(ply) * (depth.min(6) as f64) * SUSTAIN_WELL_STEP
}

pub fn setup_credit(
    after: &Board,
    lines: u32,
    tspin: bool,
    ply: i32,
    fire: &FireWeights,
) -> f64 {
    let ws = fire.well_step.unwrap_or(SETUP_WELL_STEP);
    let tss = fire.tslot_step.unwrap_or(0.0);
    if ws == 0.0 && tss == 0.0 {
        return 0.0;
    }
    if lines > 0 || tspin {
        return 0.0;
    }
    let shape = extract_features(after, 0.0, 0.0);
    if shape.holes > 0.0 || shape.max_height < 6.0 || shape.max_height > 7.0 {
        return 0.0;
    }
    let depth = well_depth_of(after);
    if depth < 4 {
        return 0.0;
    }
    if ply <= 1 && depth < 6 {
        return 0.0;
    }
    let well = SETUP_GAMMA.powi(ply) * (depth.min(6) as f64) * ws;
    well + SETUP_GAMMA.powi(ply) * (count_tslots(after).min(2) as f64) * tss
}

fn count_tslots(after: &Board) -> usize {
    let mut n = 0usize;
    for y in 1..=14usize {
        for x in 0..COLS {
            if (after[y] & (1u16 << x)) != 0 {
                continue;
            }
            if (after[y - 1] & (1u16 << x)) == 0 {
                continue;
            }
            let mut filled = 0;
            if x == 0 || (after[y] & (1u16 << (x - 1))) != 0 {
                filled += 1;
            }
            if x == COLS - 1 || (after[y] & (1u16 << (x + 1))) != 0 {
                filled += 1;
            }
            if y + 1 >= ROWS || (after[y + 1] & (1u16 << x)) != 0 {
                filled += 1;
            }
            if filled >= 2 {
                n += 1;
                if n >= 2 {
                    return 2;
                }
            }
        }
    }
    n
}

fn is_tspin_shape(after: &Board, cells: &[crate::pieces::Cell; 4], px: i32, py: i32) -> bool {
    let mut cx = 0f64;
    let mut cy = 0f64;
    for c in cells {
        cx += (px + c.x) as f64;
        cy += (py + c.y) as f64;
    }
    cx /= cells.len() as f64;
    cy /= cells.len() as f64;
    let corners: [(i32, i32); 4] = [
        ((cx - 0.6).floor() as i32, (cy - 0.6).floor() as i32),
        ((cx + 0.6).ceil() as i32, (cy - 0.6).floor() as i32),
        ((cx - 0.6).floor() as i32, (cy + 0.6).ceil() as i32),
        ((cx + 0.6).ceil() as i32, (cy + 0.6).ceil() as i32),
    ];
    let mut filled = 0;
    for (x, y) in corners {
        if x < 0 || x >= COLS as i32 || y < 0 {
            filled += 1;
            continue;
        }
        if y >= ROWS as i32 {
            continue;
        }
        if (after[y as usize] & (1u16 << x)) != 0 {
            filled += 1;
        }
    }
    filled >= 3
}
