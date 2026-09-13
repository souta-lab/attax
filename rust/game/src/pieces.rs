//! Tetromino shapes using Hoiko's fixed 4x4 rotation anchors.
//!
//! Faithful port of `src/core/pieces.ts`: the same `NATIVE_CELLS` table, the
//! same `rotationCount` / `cellsFor` / `bottomCellsOf` / `pieceCellValue`
//! semantics (including the O piece collapsing every rotation to anchor 0).

use crate::types::{Cell, PieceKind};

/// `src/core/pieces.ts` `NATIVE_CELLS`, in declaration order (I, J, L, O, T, S, Z).
const NATIVE_CELLS: [[[i32; 2]; 4]; 7] = [
    // I
    [
        [0, 1],
        [1, 1],
        [2, 1],
        [3, 1],
    ],
    // J
    [
        [0, 0],
        [0, 1],
        [1, 1],
        [2, 1],
    ],
    // L
    [
        [2, 0],
        [0, 1],
        [1, 1],
        [2, 1],
    ],
    // O (single rotation)
    [
        [1, 0],
        [2, 0],
        [1, 1],
        [2, 1],
    ],
    // T
    [
        [1, 0],
        [0, 1],
        [1, 1],
        [2, 1],
    ],
    // S
    [
        [1, 0],
        [2, 0],
        [0, 1],
        [1, 1],
    ],
    // Z
    [
        [0, 0],
        [1, 0],
        [1, 1],
        [2, 1],
    ],
];

// The remaining three rotations per piece, in TS declaration order.
const I_ROTATIONS: [[[i32; 2]; 4]; 3] = [
    [
        [2, 0],
        [2, 1],
        [2, 2],
        [2, 3],
    ],
    [
        [0, 2],
        [1, 2],
        [2, 2],
        [3, 2],
    ],
    [
        [1, 0],
        [1, 1],
        [1, 2],
        [1, 3],
    ],
];

const J_ROTATIONS: [[[i32; 2]; 4]; 3] = [
    [
        [1, 0],
        [2, 0],
        [1, 1],
        [1, 2],
    ],
    [
        [0, 1],
        [1, 1],
        [2, 1],
        [2, 2],
    ],
    [
        [1, 0],
        [1, 1],
        [0, 2],
        [1, 2],
    ],
];

const L_ROTATIONS: [[[i32; 2]; 4]; 3] = [
    [
        [1, 0],
        [1, 1],
        [1, 2],
        [2, 2],
    ],
    [
        [0, 1],
        [1, 1],
        [2, 1],
        [0, 2],
    ],
    [
        [0, 0],
        [1, 0],
        [1, 1],
        [1, 2],
    ],
];

const T_ROTATIONS: [[[i32; 2]; 4]; 3] = [
    [
        [1, 0],
        [1, 1],
        [2, 1],
        [1, 2],
    ],
    [
        [0, 1],
        [1, 1],
        [2, 1],
        [1, 2],
    ],
    [
        [1, 0],
        [0, 1],
        [1, 1],
        [1, 2],
    ],
];

const S_ROTATIONS: [[[i32; 2]; 4]; 3] = [
    [
        [1, 0],
        [1, 1],
        [2, 1],
        [2, 2],
    ],
    [
        [1, 1],
        [2, 1],
        [0, 2],
        [1, 2],
    ],
    [
        [0, 0],
        [0, 1],
        [1, 1],
        [1, 2],
    ],
];

const Z_ROTATIONS: [[[i32; 2]; 4]; 3] = [
    [
        [2, 0],
        [1, 1],
        [2, 1],
        [1, 2],
    ],
    [
        [0, 1],
        [1, 1],
        [1, 2],
        [2, 2],
    ],
    [
        [1, 0],
        [0, 1],
        [1, 1],
        [0, 2],
    ],
];

/// Normalizes a rotation exactly like `src/core/srs.ts` `asRotation`.
pub fn as_rotation(n: i32) -> i32 {
    ((n % 4) + 4) % 4
}

fn raw_cells(kind: PieceKind, rotation: i32) -> [[i32; 2]; 4] {
    let n = as_rotation(rotation) as usize;
    match kind {
        PieceKind::O => NATIVE_CELLS[3],
        PieceKind::I => {
            if n == 0 { NATIVE_CELLS[0] } else { I_ROTATIONS[n - 1] }
        }
        PieceKind::J => {
            if n == 0 { NATIVE_CELLS[1] } else { J_ROTATIONS[n - 1] }
        }
        PieceKind::L => {
            if n == 0 { NATIVE_CELLS[2] } else { L_ROTATIONS[n - 1] }
        }
        PieceKind::T => {
            if n == 0 { NATIVE_CELLS[4] } else { T_ROTATIONS[n - 1] }
        }
        PieceKind::S => {
            if n == 0 { NATIVE_CELLS[5] } else { S_ROTATIONS[n - 1] }
        }
        PieceKind::Z => {
            if n == 0 { NATIVE_CELLS[6] } else { Z_ROTATIONS[n - 1] }
        }
    }
}

/// `src/core/pieces.ts` `rotationCount`.
pub fn rotation_count(kind: PieceKind) -> usize {
    if kind == PieceKind::O { 1 } else { 4 }
}

/// `src/core/pieces.ts` `cellsFor`.
pub fn cells_for(kind: PieceKind, rotation: i32) -> [Cell; 4] {
    let raw = raw_cells(kind, rotation);
    [
        Cell { x: raw[0][0], y: raw[0][1] },
        Cell { x: raw[1][0], y: raw[1][1] },
        Cell { x: raw[2][0], y: raw[2][1] },
        Cell { x: raw[3][0], y: raw[3][1] },
    ]
}

/// `src/core/pieces.ts` `bottomCellsOf`: cells re-anchored so the lowest cell
/// sits on y=0 (used by the engine's T-spin detection).
pub fn bottom_cells_of(kind: PieceKind, rotation: i32) -> [Cell; 4] {
    let cells = cells_for(kind, rotation);
    let mut max_y = 0;
    for c in &cells {
        if c.y > max_y {
            max_y = c.y;
        }
    }
    let mut out = cells;
    for c in &mut out {
        c.y = max_y - c.y;
    }
    out
}

/// `src/core/pieces.ts` `pieceCellValue` (also `src/ui/types.ts` `pieceToCell`).
pub fn piece_cell_value(kind: PieceKind) -> u8 {
    match kind {
        PieceKind::I => 1,
        PieceKind::O => 2,
        PieceKind::T => 3,
        PieceKind::S => 4,
        PieceKind::Z => 5,
        PieceKind::J => 6,
        PieceKind::L => 7,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::cell;

    #[test]
    fn rotation_count_matches_ts() {
        assert_eq!(rotation_count(PieceKind::O), 1);
        for kind in [PieceKind::I, PieceKind::T, PieceKind::S, PieceKind::Z, PieceKind::J, PieceKind::L] {
            assert_eq!(rotation_count(kind), 4);
        }
    }

    #[test]
    fn o_piece_collapses_every_rotation_to_anchor_zero() {
        let base = cells_for(PieceKind::O, 0);
        for rotation in [-3, 1, 2, 3, 7] {
            assert_eq!(cells_for(PieceKind::O, rotation), base);
        }
        assert_eq!(
            base,
            [cell(1, 0), cell(2, 0), cell(1, 1), cell(2, 1)]
        );
    }

    #[test]
    fn i_piece_anchor_rotations_match_ts() {
        assert_eq!(
            cells_for(PieceKind::I, 0),
            [cell(0, 1), cell(1, 1), cell(2, 1), cell(3, 1)]
        );
        assert_eq!(
            cells_for(PieceKind::I, 1),
            [cell(2, 0), cell(2, 1), cell(2, 2), cell(2, 3)]
        );
        assert_eq!(
            cells_for(PieceKind::I, 2),
            [cell(0, 2), cell(1, 2), cell(2, 2), cell(3, 2)]
        );
        assert_eq!(
            cells_for(PieceKind::I, 3),
            [cell(1, 0), cell(1, 1), cell(1, 2), cell(1, 3)]
        );
    }

    #[test]
    fn negative_rotations_wrap_like_as_rotation() {
        assert_eq!(as_rotation(-1), 3);
        assert_eq!(as_rotation(4), 0);
        assert_eq!(cells_for(PieceKind::T, -1), cells_for(PieceKind::T, 3));
    }

    #[test]
    fn bottom_cells_reanchor_lowest_row_to_zero() {
        assert_eq!(
            bottom_cells_of(PieceKind::T, 0),
            [cell(1, 1), cell(0, 0), cell(1, 0), cell(2, 0)]
        );
        assert_eq!(
            bottom_cells_of(PieceKind::I, 0),
            [cell(0, 0), cell(1, 0), cell(2, 0), cell(3, 0)]
        );
        assert_eq!(
            bottom_cells_of(PieceKind::O, 0),
            [cell(1, 1), cell(2, 1), cell(1, 0), cell(2, 0)]
        );
    }

    #[test]
    fn piece_cell_values_match_ts() {
        assert_eq!(piece_cell_value(PieceKind::I), 1);
        assert_eq!(piece_cell_value(PieceKind::O), 2);
        assert_eq!(piece_cell_value(PieceKind::T), 3);
        assert_eq!(piece_cell_value(PieceKind::S), 4);
        assert_eq!(piece_cell_value(PieceKind::Z), 5);
        assert_eq!(piece_cell_value(PieceKind::J), 6);
        assert_eq!(piece_cell_value(PieceKind::L), 7);
    }

    #[test]
    fn mino_codes_round_trip() {
        for kind in PieceKind::ALL {
            assert_eq!(PieceKind::from_mino(kind.to_mino()), Some(kind));
        }
        assert_eq!(PieceKind::from_mino(crate::types::MINO_NONE), None);
    }
}
