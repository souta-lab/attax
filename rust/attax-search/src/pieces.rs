//! Piece geometry and SRS kicks — a transcription of `src/core/pieces.ts` (Hoiko's fixed
//! 4x4 rotation anchors, y down) and `src/core/srs.ts` (engine kick order, dy up).

/// Piece kinds in the TS `KINDS` order used by movegen: I O T S Z J L.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[repr(u8)]
pub enum Kind {
    I = 0,
    O = 1,
    T = 2,
    S = 3,
    Z = 4,
    J = 5,
    L = 6,
}

pub const KINDS: [Kind; 7] = [Kind::I, Kind::O, Kind::T, Kind::S, Kind::Z, Kind::J, Kind::L];

impl Kind {
    pub fn from_char(c: char) -> Option<Kind> {
        Some(match c {
            'I' => Kind::I,
            'O' => Kind::O,
            'T' => Kind::T,
            'S' => Kind::S,
            'Z' => Kind::Z,
            'J' => Kind::J,
            'L' => Kind::L,
            _ => return None,
        })
    }
    pub fn as_char(self) -> char {
        ['I', 'O', 'T', 'S', 'Z', 'J', 'L'][self as usize]
    }
    pub fn rotations(self) -> usize {
        if self == Kind::O { 1 } else { 4 }
    }
}

type Cells = [(i32, i32); 4];

/// `NATIVE_CELLS` from pieces.ts, (x, y) with y down. O has a single rotation.
const NATIVE: [[Cells; 4]; 7] = [
    // I
    [
        [(0, 1), (1, 1), (2, 1), (3, 1)],
        [(2, 0), (2, 1), (2, 2), (2, 3)],
        [(0, 2), (1, 2), (2, 2), (3, 2)],
        [(1, 0), (1, 1), (1, 2), (1, 3)],
    ],
    // O (cellsFor maps every rotation to shape 0)
    [
        [(1, 0), (2, 0), (1, 1), (2, 1)],
        [(1, 0), (2, 0), (1, 1), (2, 1)],
        [(1, 0), (2, 0), (1, 1), (2, 1)],
        [(1, 0), (2, 0), (1, 1), (2, 1)],
    ],
    // T
    [
        [(1, 0), (0, 1), (1, 1), (2, 1)],
        [(1, 0), (1, 1), (2, 1), (1, 2)],
        [(0, 1), (1, 1), (2, 1), (1, 2)],
        [(1, 0), (0, 1), (1, 1), (1, 2)],
    ],
    // S
    [
        [(1, 0), (2, 0), (0, 1), (1, 1)],
        [(1, 0), (1, 1), (2, 1), (2, 2)],
        [(1, 1), (2, 1), (0, 2), (1, 2)],
        [(0, 0), (0, 1), (1, 1), (1, 2)],
    ],
    // Z
    [
        [(0, 0), (1, 0), (1, 1), (2, 1)],
        [(2, 0), (1, 1), (2, 1), (1, 2)],
        [(0, 1), (1, 1), (1, 2), (2, 2)],
        [(1, 0), (0, 1), (1, 1), (0, 2)],
    ],
    // J
    [
        [(0, 0), (0, 1), (1, 1), (2, 1)],
        [(1, 0), (2, 0), (1, 1), (1, 2)],
        [(0, 1), (1, 1), (2, 1), (2, 2)],
        [(1, 0), (1, 1), (0, 2), (1, 2)],
    ],
    // L
    [
        [(2, 0), (0, 1), (1, 1), (2, 1)],
        [(1, 0), (1, 1), (1, 2), (2, 2)],
        [(0, 1), (1, 1), (2, 1), (0, 2)],
        [(0, 0), (1, 0), (1, 1), (1, 2)],
    ],
];

/// `cellsFor(kind, rotation)` — cells in the order pieces.ts lists them.
pub fn cells_for(kind: Kind, rotation: usize) -> &'static Cells {
    &NATIVE[kind as usize][rotation & 3]
}

/// One rotation as row masks relative to the piece origin (movegen.ts `Shape`).
#[derive(Clone, Copy, Debug)]
pub struct Shape {
    pub min_x: i32,
    pub max_x: i32,
    pub min_y: i32,
    pub height: i32,
    /// `rows[i]` is the mask of row `min_y + i`, relative to `min_x`.
    pub rows: [u16; 4],
}

const fn build_shape(kind: usize, rotation: usize) -> Shape {
    let cells = &NATIVE[kind][rotation];
    let mut min_x = 9;
    let mut max_x = 0;
    let mut min_y = 9;
    let mut max_y = 0;
    let mut i = 0;
    while i < 4 {
        let (x, y) = cells[i];
        if x < min_x {
            min_x = x;
        }
        if x > max_x {
            max_x = x;
        }
        if y < min_y {
            min_y = y;
        }
        if y > max_y {
            max_y = y;
        }
        i += 1;
    }
    let mut rows = [0u16; 4];
    let mut i = 0;
    while i < 4 {
        let (x, y) = cells[i];
        rows[(y - min_y) as usize] |= 1 << (x - min_x);
        i += 1;
    }
    Shape { min_x, max_x, min_y, height: max_y - min_y + 1, rows }
}

const fn build_shapes() -> [[Shape; 4]; 7] {
    let blank = Shape { min_x: 0, max_x: 0, min_y: 0, height: 0, rows: [0; 4] };
    let mut out = [[blank; 4]; 7];
    let mut k = 0;
    while k < 7 {
        let mut r = 0;
        while r < 4 {
            out[k][r] = build_shape(k, r);
            r += 1;
        }
        k += 1;
    }
    out
}

pub static SHAPES: [[Shape; 4]; 7] = build_shapes();

#[inline(always)]
pub fn shape(kind: Kind, rotation: usize) -> &'static Shape {
    &SHAPES[kind as usize][rotation & 3]
}

/// (dx, dy) with dy up, exactly srs.ts. Index: [from][dir] where dir 0 = CW (to from+1),
/// dir 1 = CCW (to from+3).
pub type Kicks = [(i32, i32); 5];

const JLSTZ: [[Kicks; 2]; 4] = [
    // from 0: 0>1, 0>3
    [
        [(0, 0), (-1, 0), (-1, 1), (0, -2), (-1, -2)],
        [(0, 0), (1, 0), (1, 1), (0, -2), (1, -2)],
    ],
    // from 1: 1>2, 1>0
    [
        [(0, 0), (1, 0), (1, -1), (0, 2), (1, 2)],
        [(0, 0), (1, 0), (1, -1), (0, 2), (1, 2)],
    ],
    // from 2: 2>3, 2>1
    [
        [(0, 0), (1, 0), (1, 1), (0, -2), (1, -2)],
        [(0, 0), (-1, 0), (-1, 1), (0, -2), (-1, -2)],
    ],
    // from 3: 3>0, 3>2
    [
        [(0, 0), (-1, 0), (-1, -1), (0, 2), (-1, 2)],
        [(0, 0), (-1, 0), (-1, -1), (0, 2), (-1, 2)],
    ],
];

const I_KICKS: [[Kicks; 2]; 4] = [
    // 0>1, 0>3
    [
        [(0, 0), (-2, 0), (1, 0), (-2, -1), (1, 2)],
        [(0, 0), (-1, 0), (2, 0), (-1, 2), (2, -1)],
    ],
    // 1>2, 1>0
    [
        [(0, 0), (-1, 0), (2, 0), (-1, 2), (2, -1)],
        [(0, 0), (2, 0), (-1, 0), (2, 1), (-1, -2)],
    ],
    // 2>3, 2>1
    [
        [(0, 0), (2, 0), (-1, 0), (2, 1), (-1, -2)],
        [(0, 0), (1, 0), (-2, 0), (1, -2), (-2, 1)],
    ],
    // 3>0, 3>2
    [
        [(0, 0), (1, 0), (-2, 0), (1, -2), (-2, 1)],
        [(0, 0), (-2, 0), (1, 0), (-2, -1), (1, 2)],
    ],
];

/// Kick list for `from` -> `from + 1` (dir 0) or `from + 3` (dir 1). O never rotates in
/// movegen, so it is not covered here.
#[inline(always)]
pub fn kicks(kind: Kind, from: usize, dir: usize) -> &'static Kicks {
    if kind == Kind::I { &I_KICKS[from][dir] } else { &JLSTZ[from][dir] }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shapes_match_ts_masks() {
        // T rot0: row0 = .X. , row1 = XXX
        let t = shape(Kind::T, 0);
        assert_eq!((t.min_x, t.max_x, t.min_y, t.height), (0, 2, 0, 2));
        assert_eq!(&t.rows[..2], &[0b010, 0b111]);
        // I rot1: vertical at x=2, rows 0..3
        let i = shape(Kind::I, 1);
        assert_eq!((i.min_x, i.max_x, i.min_y, i.height), (2, 2, 0, 4));
        assert_eq!(&i.rows, &[1, 1, 1, 1]);
        // O is the same shape in every rotation
        for r in 0..4 {
            assert_eq!(shape(Kind::O, r).rows, shape(Kind::O, 0).rows);
        }
    }
}
