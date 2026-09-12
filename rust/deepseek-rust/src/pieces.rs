#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PieceKind {
    I,
    O,
    T,
    S,
    Z,
    J,
    L,
}

impl PieceKind {
    pub const ALL: [PieceKind; 7] = [
        PieceKind::I,
        PieceKind::O,
        PieceKind::T,
        PieceKind::S,
        PieceKind::Z,
        PieceKind::J,
        PieceKind::L,
    ];

    pub fn from_char(c: char) -> Option<PieceKind> {
        match c {
            'I' => Some(PieceKind::I),
            'O' => Some(PieceKind::O),
            'T' => Some(PieceKind::T),
            'S' => Some(PieceKind::S),
            'Z' => Some(PieceKind::Z),
            'J' => Some(PieceKind::J),
            'L' => Some(PieceKind::L),
            _ => None,
        }
    }

    pub fn as_char(self) -> char {
        match self {
            PieceKind::I => 'I',
            PieceKind::O => 'O',
            PieceKind::T => 'T',
            PieceKind::S => 'S',
            PieceKind::Z => 'Z',
            PieceKind::J => 'J',
            PieceKind::L => 'L',
        }
    }

    pub fn code(self) -> i8 {
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cell {
    pub x: i32,
    pub y: i32,
}

pub fn rotation_count(kind: PieceKind) -> usize {
    if kind == PieceKind::O { 1 } else { 4 }
}

fn native_cells(kind: PieceKind, rotation: usize) -> [[i32; 2]; 4] {
    match kind {
        PieceKind::I => [
            [[0, 1], [1, 1], [2, 1], [3, 1]],
            [[2, 0], [2, 1], [2, 2], [2, 3]],
            [[0, 2], [1, 2], [2, 2], [3, 2]],
            [[1, 0], [1, 1], [1, 2], [1, 3]],
        ][rotation],
        PieceKind::J => [
            [[0, 0], [0, 1], [1, 1], [2, 1]],
            [[1, 0], [2, 0], [1, 1], [1, 2]],
            [[0, 1], [1, 1], [2, 1], [2, 2]],
            [[1, 0], [1, 1], [0, 2], [1, 2]],
        ][rotation],
        PieceKind::L => [
            [[2, 0], [0, 1], [1, 1], [2, 1]],
            [[1, 0], [1, 1], [1, 2], [2, 2]],
            [[0, 1], [1, 1], [2, 1], [0, 2]],
            [[0, 0], [1, 0], [1, 1], [1, 2]],
        ][rotation],
        PieceKind::O => [[[1, 0], [2, 0], [1, 1], [2, 1]]][0],
        PieceKind::T => [
            [[1, 0], [0, 1], [1, 1], [2, 1]],
            [[1, 0], [1, 1], [2, 1], [1, 2]],
            [[0, 1], [1, 1], [2, 1], [1, 2]],
            [[1, 0], [0, 1], [1, 1], [1, 2]],
        ][rotation],
        PieceKind::S => [
            [[1, 0], [2, 0], [0, 1], [1, 1]],
            [[1, 0], [1, 1], [2, 1], [2, 2]],
            [[1, 1], [2, 1], [0, 2], [1, 2]],
            [[0, 0], [0, 1], [1, 1], [1, 2]],
        ][rotation],
        PieceKind::Z => [
            [[0, 0], [1, 0], [1, 1], [2, 1]],
            [[2, 0], [1, 1], [2, 1], [1, 2]],
            [[0, 1], [1, 1], [1, 2], [2, 2]],
            [[1, 0], [0, 1], [1, 1], [0, 2]],
        ][rotation],
    }
}

pub fn cells_for(kind: PieceKind, rotation: i32) -> [Cell; 4] {
    let n = (((rotation % 4) + 4) % 4) as usize;
    let idx = if kind == PieceKind::O { 0 } else { n };
    let raw = native_cells(kind, idx);
    let mut out = [Cell { x: 0, y: 0 }; 4];
    for (i, c) in raw.iter().enumerate() {
        out[i] = Cell { x: c[0], y: c[1] };
    }
    out
}

pub fn bottom_cells(kind: PieceKind, rotation: i32) -> [Cell; 4] {
    let cells = cells_for(kind, rotation);
    let mut max_y = 0;
    for c in &cells {
        if c.y > max_y {
            max_y = c.y;
        }
    }
    let mut out = [Cell { x: 0, y: 0 }; 4];
    for (i, c) in cells.iter().enumerate() {
        out[i] = Cell {
            x: c.x,
            y: max_y - c.y,
        };
    }
    out
}
