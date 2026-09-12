use crate::board::{Board, ROWS, collides, compute_lock_afterstate, drop_y};
use crate::features::{FeatureVector, extract_features};
use crate::pieces::{Cell, PieceKind, bottom_cells, rotation_count};
use crate::weights::{Weights, score_placement};

#[derive(Clone, Debug)]
pub struct ScoredPlacement {
    pub rotation: i32,
    pub x: i32,
    pub y: i32,
    pub score: f64,
    pub lines_cleared: u32,
    pub features: FeatureVector,
    pub after: Board,
    /// True when the landing requires an SRS kick/tuck (not a plain hard drop).
    pub via_kick: bool,
    /// Index into the SRS kick table that produced this landing, when kicked.
    pub srs_kick_index: Option<usize>,
}

/// Hard-drop placements scored exactly like the TS `enumerateScored`: features
/// use the real landing height and eroded-cell count.
pub fn enumerate_scored(board: &Board, kind: PieceKind, weights: &Weights) -> Vec<ScoredPlacement> {
    enumerate_with(board, kind, weights, false)
}

/// Hard-drop placements with flat features (`landing_height = 0`,
/// `eroded_cells = 0`). This mirrors the re-scoring step in the TS v2
/// placement generator, which always re-scores every generator placement from
/// scratch.
pub fn enumerate_scored_flat(
    board: &Board,
    kind: PieceKind,
    weights: &Weights,
) -> Vec<ScoredPlacement> {
    enumerate_with(board, kind, weights, true)
}

fn enumerate_with(
    board: &Board,
    kind: PieceKind,
    weights: &Weights,
    flat: bool,
) -> Vec<ScoredPlacement> {
    let mut out = Vec::new();
    let rots = rotation_count(kind);
    for r in 0..rots {
        let cells = bottom_cells(kind, r as i32);
        let mut min_x = i32::MAX;
        let mut max_x = i32::MIN;
        for c in &cells {
            if c.x < min_x {
                min_x = c.x;
            }
            if c.x > max_x {
                max_x = c.x;
            }
        }
        let mut px = -min_x;
        while px < 10 - max_x {
            let start_y = ROWS as i32 + 4;
            if !collides(board, &cells, px, start_y) {
                let y = drop_y(board, &cells, px, start_y);
                push_placement(
                    &mut out, board, &cells, r as i32, px, y, weights, false, None, flat,
                );
            }
            px += 1;
        }
    }
    out
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn push_placement(
    out: &mut Vec<ScoredPlacement>,
    board: &Board,
    cells: &[Cell; 4],
    r: i32,
    px: i32,
    y: i32,
    weights: &Weights,
    via_kick: bool,
    srs_kick_index: Option<usize>,
    flat: bool,
) {
    if collides(board, cells, px, y) {
        return;
    }
    let transition = compute_lock_afterstate(board, cells, px, y);
    if transition.top_out && transition.lines_cleared == 0 {
        return;
    }
    let (avg_landing, eroded) = if flat {
        (0.0, 0.0)
    } else {
        let mut sum = 0f64;
        for c in cells {
            sum += (y + c.y + 1) as f64;
        }
        (
            sum / cells.len() as f64,
            transition.lines_cleared as f64 * transition.piece_cells_in_cleared_rows as f64,
        )
    };
    let feat = extract_features(&transition.after, avg_landing, eroded);
    let score = score_placement(&feat, transition.lines_cleared, weights);
    out.push(ScoredPlacement {
        rotation: r,
        x: px,
        y,
        score,
        lines_cleared: transition.lines_cleared,
        features: feat,
        after: transition.after,
        via_kick,
        srs_kick_index,
    });
}
