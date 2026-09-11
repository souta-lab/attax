use crate::board::{Board, ROWS, collides, compute_lock_afterstate, drop_y};
use crate::features::{FeatureVector, extract_features};
use crate::pieces::{PieceKind, bottom_cells, rotation_count};
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
}

pub fn enumerate_scored(board: &Board, kind: PieceKind, weights: &Weights) -> Vec<ScoredPlacement> {
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
                push_placement(&mut out, board, kind, &cells, r as i32, px, y, weights);
            }
            px += 1;
        }
    }
    out
}

fn push_placement(
    out: &mut Vec<ScoredPlacement>,
    board: &Board,
    _kind: PieceKind,
    cells: &[crate::pieces::Cell; 4],
    r: i32,
    px: i32,
    y: i32,
    weights: &Weights,
) {
    if collides(board, cells, px, y) {
        return;
    }
    let transition = compute_lock_afterstate(board, cells, px, y);
    if transition.top_out && transition.lines_cleared == 0 {
        return;
    }
    let mut sum = 0f64;
    for c in cells {
        sum += (y + c.y + 1) as f64;
    }
    let avg_landing = sum / cells.len() as f64;
    let eroded = transition.lines_cleared as f64 * transition.piece_cells_in_cleared_rows as f64;
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
    });
}
