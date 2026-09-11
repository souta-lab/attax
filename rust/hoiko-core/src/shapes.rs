//! Native Hoiko piece/shape model — faithful port of `src/ai/native/shapes.ts`.
//!
//! A native cell `(cx, cy)` for a piece anchored at `(p.x, p.y)` occupies board
//! column `p.x + cx` and board row `p.y - cy` (bits use `9 - col`).

/// Native mino type code (I=0..Z=6, None=7), mirroring the TS `MinoType`.
pub type MinoType = i32;

pub const MINO_I: i32 = 0;
pub const MINO_J: i32 = 1;
pub const MINO_L: i32 = 2;
pub const MINO_O: i32 = 3;
pub const MINO_T: i32 = 4;
pub const MINO_S: i32 = 5;
pub const MINO_Z: i32 = 6;
pub const MINO_NONE: i32 = 7;

pub const ACT_NONE: i32 = 0;
pub const ACT_SINGLE: i32 = 1;
pub const ACT_DOUBLE: i32 = 2;
pub const ACT_TRIPLE: i32 = 3;
pub const ACT_QUAD: i32 = 4;
pub const ACT_TSS: i32 = 5;
pub const ACT_TSD: i32 = 6;
pub const ACT_TST: i32 = 7;
pub const ACT_TSM: i32 = 8;
pub const ACT_PC: i32 = 9;

/// A tetromino kind (mino 0..=6 map 1:1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PieceKind {
    I,
    J,
    L,
    O,
    T,
    S,
    Z,
}

impl PieceKind {
    /// SRS-table index (`src/core/srs.ts`): I=0, O=1, T=2, S=3, Z=4, J=5, L=6.
    pub const fn srs_index(self) -> i32 {
        match self {
            PieceKind::I => 0,
            PieceKind::O => 1,
            PieceKind::T => 2,
            PieceKind::S => 3,
            PieceKind::Z => 4,
            PieceKind::J => 5,
            PieceKind::L => 6,
        }
    }
}

const KIND_BY_MINO: [Option<PieceKind>; 8] = [
    Some(PieceKind::I),
    Some(PieceKind::J),
    Some(PieceKind::L),
    Some(PieceKind::O),
    Some(PieceKind::T),
    Some(PieceKind::S),
    Some(PieceKind::Z),
    None,
];

pub fn mino_to_kind(m: i32) -> Option<PieceKind> {
    KIND_BY_MINO.get(m as usize).copied().flatten()
}

pub fn kind_to_mino(kind: PieceKind) -> i32 {
    match kind {
        PieceKind::I => MINO_I,
        PieceKind::J => MINO_J,
        PieceKind::L => MINO_L,
        PieceKind::O => MINO_O,
        PieceKind::T => MINO_T,
        PieceKind::S => MINO_S,
        PieceKind::Z => MINO_Z,
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Cell {
    pub x: i32,
    pub y: i32,
}

const fn c(x: i32, y: i32) -> Cell {
    Cell { x, y }
}

/// `NATIVE_CELLS` from `src/core/pieces.ts`, indexed by mino 0..=6 (I..Z).
/// O repeats its single rotation across all four slots.
const NATIVE_CELLS: [[[Cell; 4]; 4]; 7] = [
    // I
    [
        [c(0, 1), c(1, 1), c(2, 1), c(3, 1)],
        [c(2, 0), c(2, 1), c(2, 2), c(2, 3)],
        [c(0, 2), c(1, 2), c(2, 2), c(3, 2)],
        [c(1, 0), c(1, 1), c(1, 2), c(1, 3)],
    ],
    // J
    [
        [c(0, 0), c(0, 1), c(1, 1), c(2, 1)],
        [c(1, 0), c(2, 0), c(1, 1), c(1, 2)],
        [c(0, 1), c(1, 1), c(2, 1), c(2, 2)],
        [c(1, 0), c(1, 1), c(0, 2), c(1, 2)],
    ],
    // L
    [
        [c(2, 0), c(0, 1), c(1, 1), c(2, 1)],
        [c(1, 0), c(1, 1), c(1, 2), c(2, 2)],
        [c(0, 1), c(1, 1), c(2, 1), c(0, 2)],
        [c(0, 0), c(1, 0), c(1, 1), c(1, 2)],
    ],
    // O
    [
        [c(1, 0), c(2, 0), c(1, 1), c(2, 1)],
        [c(1, 0), c(2, 0), c(1, 1), c(2, 1)],
        [c(1, 0), c(2, 0), c(1, 1), c(2, 1)],
        [c(1, 0), c(2, 0), c(1, 1), c(2, 1)],
    ],
    // T
    [
        [c(1, 0), c(0, 1), c(1, 1), c(2, 1)],
        [c(1, 0), c(1, 1), c(2, 1), c(1, 2)],
        [c(0, 1), c(1, 1), c(2, 1), c(1, 2)],
        [c(1, 0), c(0, 1), c(1, 1), c(1, 2)],
    ],
    // S
    [
        [c(1, 0), c(2, 0), c(0, 1), c(1, 1)],
        [c(1, 0), c(1, 1), c(2, 1), c(2, 2)],
        [c(1, 1), c(2, 1), c(0, 2), c(1, 2)],
        [c(0, 0), c(0, 1), c(1, 1), c(1, 2)],
    ],
    // Z
    [
        [c(0, 0), c(1, 0), c(1, 1), c(2, 1)],
        [c(2, 0), c(1, 1), c(2, 1), c(1, 2)],
        [c(0, 1), c(1, 1), c(1, 2), c(2, 2)],
        [c(1, 0), c(0, 1), c(1, 1), c(0, 2)],
    ],
];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Shape {
    pub cells: [Cell; 4],
    pub len: u8,
    pub min_x: i32,
    pub max_x: i32,
    pub min_y: i32,
    pub max_y: i32,
    /// `row_mask[cy] = OR over cells at local y=cy of (1 << (9 - cx))`.
    pub row_mask: [i32; 4],
}

impl Shape {
    /// The occupied cells, in the reference table order.
    #[inline]
    pub fn cells(&self) -> &[Cell] {
        &self.cells[..self.len as usize]
    }
}

const EMPTY_SHAPE: Shape = Shape {
    cells: [Cell { x: 0, y: 0 }; 4],
    len: 0,
    min_x: 0,
    max_x: 0,
    min_y: 0,
    max_y: 0,
    row_mask: [0; 4],
};

const fn shape_from_cells(cells: [Cell; 4]) -> Shape {
    let mut min_x = cells[0].x;
    let mut max_x = cells[0].x;
    let mut min_y = cells[0].y;
    let mut max_y = cells[0].y;
    let mut row_mask = [0i32; 4];
    let mut i = 0;
    while i < 4 {
        let cell = cells[i];
        if cell.x < min_x {
            min_x = cell.x;
        }
        if cell.x > max_x {
            max_x = cell.x;
        }
        if cell.y < min_y {
            min_y = cell.y;
        }
        if cell.y > max_y {
            max_y = cell.y;
        }
        let k = cell.y;
        if k >= 0 && k < 4 {
            row_mask[k as usize] |= 1 << (9 - cell.x);
        }
        i += 1;
    }
    Shape { cells, len: 4, min_x, max_x, min_y, max_y, row_mask }
}

static SHAPES: [[Shape; 4]; 8] = {
    let mut table = [[EMPTY_SHAPE; 4]; 8];
    let mut m = 0;
    while m < 7 {
        let mut r = 0;
        while r < 4 {
            table[m][r] = shape_from_cells(NATIVE_CELLS[m][r]);
            r += 1;
        }
        m += 1;
    }
    table
};

#[inline]
pub fn shape_for(m: i32, r: i32) -> &'static Shape {
    let mi = if (m as u32) < 8 { m as usize } else { MINO_NONE as usize };
    &SHAPES[mi][(r & 3) as usize]
}

/// `((n % 4) + 4) % 4`.
pub fn as_rotation(n: i32) -> i32 {
    ((n % 4) + 4) % 4
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shape_table_matches_golden() {
        // (mino, r, minX, maxX, minY, maxY, rowMask[0..4]) from the TS probe.
        let golden: &[(i32, i32, i32, i32, i32, i32, [i32; 4])] = &[
            (0, 0, 0, 3, 1, 1, [0, 960, 0, 0]),
            (0, 1, 2, 2, 0, 3, [128, 128, 128, 128]),
            (0, 2, 0, 3, 2, 2, [0, 0, 960, 0]),
            (0, 3, 1, 1, 0, 3, [256, 256, 256, 256]),
            (3, 0, 1, 2, 0, 1, [384, 384, 0, 0]),
            (3, 2, 1, 2, 0, 1, [384, 384, 0, 0]),
            (4, 0, 0, 2, 0, 1, [256, 896, 0, 0]),
            (6, 1, 1, 2, 0, 2, [128, 384, 256, 0]),
        ];
        for g in golden {
            let s = shape_for(g.0, g.1);
            assert_eq!(
                (s.min_x, s.max_x, s.min_y, s.max_y, s.row_mask),
                (g.2, g.3, g.4, g.5, g.6),
                "mino {} r {}",
                g.0,
                g.1
            );
        }
    }

    #[test]
    fn none_shape_is_empty() {
        let s = shape_for(MINO_NONE, 0);
        assert!(s.cells().is_empty());
        assert_eq!(s.row_mask, [0, 0, 0, 0]);
        // Out-of-range mino falls back to the empty shape.
        assert!(shape_for(99, 0).cells().is_empty());
    }

    #[test]
    fn kind_mino_roundtrip() {
        for m in 0..=6 {
            assert_eq!(kind_to_mino(mino_to_kind(m).unwrap()), m);
        }
        assert_eq!(mino_to_kind(MINO_NONE), None);
    }
}
