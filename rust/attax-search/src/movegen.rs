//! Exact placement generator — a line-by-line port of `src/ai/bot/movegen.ts`.
//!
//! Output ORDER matters as much as the set: the beam sorts children with a stable sort, so
//! ties between equal-valued children are broken by generation order. The BFS below
//! therefore visits states in exactly the TS order (open-air seed loop, then left, right,
//! down, CW kicks, CCW kicks) and emits resting states in dequeue order.

use crate::pieces::{Kind, Shape, cells_for, kicks, shape};

pub const COLS: i32 = 10;
pub const ROWS: usize = 20;
pub const FULL_ROW: u16 = 0x3ff;
/// Largest supported field (the external rig uses 40).
pub const MAX_ROWS: usize = 40;

/// Engine row order: `rows[0]` is the top row, bit x = column x. Only `rows[..len]` is used;
/// the tail is kept zero so `Board` can be compared/hashed as a whole.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Board {
    pub len: usize,
    pub rows: [u16; MAX_ROWS],
}

impl Board {
    pub fn new(len: usize) -> Board {
        assert!(len <= MAX_ROWS, "board taller than MAX_ROWS");
        Board { len, rows: [0; MAX_ROWS] }
    }
    pub fn from_rows(rows: &[u16]) -> Board {
        let mut b = Board::new(rows.len());
        b.rows[..rows.len()].copy_from_slice(rows);
        b
    }
    #[inline(always)]
    pub fn row(&self, r: usize) -> u16 {
        self.rows[r]
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Tspin {
    None = 0,
    Mini = 1,
    Full = 2,
}

impl Tspin {
    pub fn as_str(self) -> &'static str {
        match self {
            Tspin::None => "none",
            Tspin::Mini => "mini",
            Tspin::Full => "full",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Placement {
    pub kind: Kind,
    pub rotation: u8,
    pub x: i8,
    /// Engine `topRow` for `placeMinoAt`.
    pub y: i8,
    /// 0 = arrived by shift/drop, >0 = by rotation (engine lastSrs).
    pub last_srs: u8,
    pub tspin: Tspin,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Pos {
    pub rotation: i32,
    pub x: i32,
    pub y: i32,
}

/// Engine collision rule: outside the side walls or floor collides; above the top is free.
#[inline(always)]
pub fn collides_shape(board: &Board, s: &Shape, x: i32, y: i32) -> bool {
    if x + s.min_x < 0 || x + s.max_x >= COLS {
        return true;
    }
    let shift = (x + s.min_x) as u32;
    let len = board.len as i32;
    for i in 0..s.height {
        let row = y + s.min_y + i;
        if row >= len {
            return true;
        }
        if row >= 0 && board.rows[row as usize] & (s.rows[i as usize] << shift) != 0 {
            return true;
        }
    }
    false
}

#[inline(always)]
pub fn collides(board: &Board, kind: Kind, rotation: i32, x: i32, y: i32) -> bool {
    collides_shape(board, shape(kind, (rotation & 3) as usize), x, y)
}

/// Engine spawn position for a freshly drawn piece.
pub fn spawn_position(kind: Kind, rows: usize) -> Pos {
    let y = if rows > ROWS { rows as i32 - 21 } else { -shape(kind, 0).min_y };
    Pos { rotation: 0, x: 3, y }
}

// BFS state id: rotation (4) x row (-4..59) x column (-3..12).
const X_OFF: i32 = 3;
const Y_OFF: i32 = 4;
const X_SPAN: i32 = 16;
const Y_SPAN: i32 = 64;
const STATE_COUNT: usize = (4 * Y_SPAN * X_SPAN) as usize;

#[inline(always)]
fn encode(rotation: i32, x: i32, y: i32) -> usize {
    ((rotation * Y_SPAN + (y + Y_OFF)) * X_SPAN + (x + X_OFF)) as usize
}

#[inline(always)]
fn decode(id: usize) -> (i32, i32, i32) {
    let id = id as i32;
    let x = (id % X_SPAN) - X_OFF;
    let y = ((id / X_SPAN) % Y_SPAN) - Y_OFF;
    let rotation = id / (X_SPAN * Y_SPAN);
    (rotation, x, y)
}

/// Reusable BFS scratch (the TS module-level typed arrays).
pub struct MoveGen {
    visited: Vec<u32>,
    spin_arrival: Vec<u8>,
    spin_stamp: Vec<u32>,
    queue: Vec<u16>,
    resting: Vec<u16>,
    seen: Vec<u64>,
    stamp: u32,
}

impl Default for MoveGen {
    fn default() -> Self {
        Self::new()
    }
}

impl MoveGen {
    pub fn new() -> MoveGen {
        MoveGen {
            visited: vec![0; STATE_COUNT],
            spin_arrival: vec![0; STATE_COUNT],
            spin_stamp: vec![0; STATE_COUNT],
            queue: vec![0; STATE_COUNT],
            resting: Vec::with_capacity(256),
            seen: Vec::with_capacity(128),
            stamp: 0,
        }
    }

    /// All distinct resting placements reachable from `start` by engine inputs, appended to
    /// `out` in TS order. Placements locking entirely above the field are dropped.
    pub fn generate(&mut self, board: &Board, kind: Kind, start: Pos, out: &mut Vec<Placement>) {
        let mut start = start;
        let len = board.len as i32;
        if board.len > ROWS
            && start.y == len - 21
            && collides(board, kind, start.rotation, start.x, start.y)
        {
            start.y -= 1;
        }
        if collides(board, kind, start.rotation, start.x, start.y) {
            return;
        }
        self.stamp = self.stamp.wrapping_add(1);
        if self.stamp == u32::MAX || self.stamp == 0 {
            self.visited.fill(0);
            self.spin_stamp.fill(0);
            self.stamp = 1;
        }
        let stamp = self.stamp;
        let rotations = kind.rotations() as i32;
        let mut head = 0usize;
        let mut tail = 0usize;
        self.resting.clear();

        // Open-air shortcut (see movegen.ts).
        let mut top = 0usize;
        while top < board.len && board.rows[top] == 0 {
            top += 1;
        }
        let top = top as i32;
        let ss = shape(kind, (start.rotation & 3) as usize);
        let start_bottom = start.y + ss.min_y + ss.height - 1;
        if start_bottom < top - 1 {
            for rotation in 0..rotations {
                let s = shape(kind, rotation as usize);
                let lowest = top - s.min_y - s.height;
                let highest = (lowest - 2).max(start.y);
                let mut x = -s.min_x;
                while x + s.max_x < COLS {
                    let mut y = lowest;
                    while y >= highest {
                        self.visit(board, kind, stamp, rotation, x, y, &mut tail);
                        y -= 1;
                    }
                    x += 1;
                }
            }
        } else {
            self.visit(board, kind, stamp, start.rotation, start.x, start.y, &mut tail);
        }

        while head < tail {
            let id = self.queue[head] as usize;
            head += 1;
            let (rotation, x, y) = decode(id);
            let grounded = collides(board, kind, rotation, x, y + 1);
            if grounded {
                self.resting.push(id as u16);
            }
            self.visit(board, kind, stamp, rotation, x - 1, y, &mut tail);
            self.visit(board, kind, stamp, rotation, x + 1, y, &mut tail);
            if !grounded {
                self.visit(board, kind, stamp, rotation, x, y + 1, &mut tail);
            }
            if rotations == 1 {
                continue;
            }
            for dir in 0..2usize {
                let to = (rotation + if dir == 0 { 1 } else { 3 }) & 3;
                let ks = kicks(kind, rotation as usize, dir);
                let ts = shape(kind, to as usize);
                for (i, &(dx, dy)) in ks.iter().enumerate() {
                    let nx = x + dx;
                    let ny = y - dy;
                    if collides_shape(board, ts, nx, ny) {
                        continue;
                    }
                    // Engine `tryRotate`: first fitting kick wins; lastSrs = 1 for kick 0, else i + 1.
                    let last_srs = if i == 0 { 1 } else { (i + 1) as u8 };
                    if collides_shape(board, ts, nx, ny + 1) {
                        // A grounded target is always in the BFS window (TS indexes the
                        // typed arrays unchecked; out-of-window ids cannot be grounded
                        // resting states that survive the visit bounds check anyway).
                        if ny + Y_OFF >= 0 && ny + Y_OFF < Y_SPAN && nx + X_OFF >= 0 && nx + X_OFF < X_SPAN {
                            let target = encode(to, nx, ny);
                            if self.spin_stamp[target] != stamp || last_srs > self.spin_arrival[target] {
                                self.spin_stamp[target] = stamp;
                                self.spin_arrival[target] = last_srs;
                            }
                        }
                    }
                    self.visit(board, kind, stamp, to, nx, ny, &mut tail);
                    break;
                }
            }
        }

        self.seen.clear();
        for k in 0..self.resting.len() {
            let id = self.resting[k] as usize;
            let (rotation, x, y) = decode(id);
            let s = shape(kind, rotation as usize);
            if y + s.min_y + s.height - 1 < 0 {
                continue;
            }
            let last_srs = if self.spin_stamp[id] == stamp { self.spin_arrival[id] } else { 0 };
            let tspin = if kind == Kind::T && last_srs > 0 {
                tspin_kind(board, rotation, x, y, last_srs)
            } else {
                Tspin::None
            };
            if kind != Kind::T {
                let key = cell_key(s, x, y);
                if self.seen.contains(&key) {
                    continue;
                }
                self.seen.push(key);
            }
            out.push(Placement {
                kind,
                rotation: rotation as u8,
                x: x as i8,
                y: y as i8,
                last_srs: if kind == Kind::T { last_srs } else { 0 },
                tspin,
            });
        }
    }

    #[inline(always)]
    #[allow(clippy::too_many_arguments)]
    fn visit(&mut self, board: &Board, kind: Kind, stamp: u32, rotation: i32, x: i32, y: i32, tail: &mut usize) {
        if y + Y_OFF < 0 || y + Y_OFF >= Y_SPAN || x + X_OFF < 0 || x + X_OFF >= X_SPAN {
            return;
        }
        let id = encode(rotation, x, y);
        if self.visited[id] == stamp {
            return;
        }
        if collides(board, kind, rotation, x, y) {
            return;
        }
        self.visited[id] = stamp;
        self.queue[*tail] = id as u16;
        *tail += 1;
    }
}

fn cell_key(s: &Shape, x: i32, y: i32) -> u64 {
    let mut key = (y + s.min_y + Y_OFF) as u64;
    for i in 0..s.height as usize {
        key = key * 1024 + ((s.rows[i] as u64) << (x + s.min_x));
    }
    key
}

/// Board cell test used by the T-slot feature and the T-spin corner rule (engine row order):
/// walls and floor are filled, above the top is empty.
#[inline(always)]
pub fn filled(board: &Board, x: i32, row: i32) -> bool {
    if x < 0 || x >= COLS || row >= board.len as i32 {
        return true;
    }
    if row < 0 {
        return false;
    }
    board.rows[row as usize] & (1 << x) != 0
}

/// Engine T-spin verdict (`classifyTspin` on the locked, bottom-up board). The four corners
/// of the T's 3x3 box are never T cells, so they are read straight off the unlocked board;
/// in engine rows they are TL (x, y), TR (x+2, y), BR (x+2, y+2), BL (x, y+2).
fn tspin_kind(board: &Board, rotation: i32, x: i32, y: i32, last_srs: u8) -> Tspin {
    let occupied = [
        filled(board, x, y),
        filled(board, x + 2, y),
        filled(board, x + 2, y + 2),
        filled(board, x, y + 2),
    ];
    let count = occupied.iter().filter(|&&c| c).count();
    if count < 3 {
        return Tspin::None;
    }
    let (a, b) = match rotation & 3 {
        0 => (0, 1),
        1 => (1, 2),
        2 => (2, 3),
        _ => (3, 0),
    };
    if occupied[a] != occupied[b] && last_srs != 5 { Tspin::Mini } else { Tspin::Full }
}

pub struct LockOutcome {
    pub board: Board,
    pub lines_cleared: u32,
    pub perfect_clear: bool,
}

/// Lock a placement and clear full rows (survivors fall, empty rows on top).
pub fn lock_placement(board: &Board, p: &Placement) -> LockOutcome {
    let mut next = *board;
    let s = shape(p.kind, p.rotation as usize);
    let len = board.len as i32;
    let shift = (p.x as i32 + s.min_x) as u32;
    for i in 0..s.height {
        let row = p.y as i32 + s.min_y + i;
        if row >= 0 && row < len {
            next.rows[row as usize] |= s.rows[i as usize] << shift;
        }
    }
    let mut write = len - 1;
    let mut cleared = 0u32;
    let mut read = len - 1;
    while read >= 0 {
        let row = next.rows[read as usize];
        if row == FULL_ROW {
            cleared += 1;
        } else {
            next.rows[write as usize] = row;
            write -= 1;
        }
        read -= 1;
    }
    while write >= 0 {
        next.rows[write as usize] = 0;
        write -= 1;
    }
    let empty = next.rows[..board.len].iter().all(|&r| r == 0);
    LockOutcome { board: next, lines_cleared: cleared, perfect_clear: cleared > 0 && empty }
}

/// True when every cell of the placement is above the visible 20 rows (guideline lock-out).
pub fn locks_out(p: &Placement, len: usize) -> bool {
    let limit = len as i32 - 20;
    cells_for(p.kind, p.rotation as usize).iter().all(|&(_, cy)| (p.y as i32) + cy < limit)
}
