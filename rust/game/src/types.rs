//! Shared core/view-model types.
//!
//! Faithful port of `src/ui/types.ts` (the view model the canvas UI and the
//! versus controller consume) plus the AI step/execution-plan types the
//! controller replays. Constants match `src/ui/types.ts` (`COLS=10`, `ROWS=20`);
//! the bitboard helpers in [`crate::board`] use the same
//! `COLS=10` / bottom-up orientation as `src/core/board.ts`.

pub const COLS: usize = 10;
pub const ROWS: usize = 20;

/// `src/core/board.ts` `FULL_ROW` (low 10 bits).
pub const FULL_ROW: u16 = 0x03ff;

/// `src/ui/types.ts` `CellValue` (0 empty, 1..7 mino, 8 garbage).
pub type CellValue = u8;

/// Top-down playfield (`grid[y][x]`, y=0 is the top row), the engine's internal
/// representation (`Grid = CellValue[][]` in `src/core/engine.ts`).
pub type Grid = [[CellValue; COLS]; ROWS];

pub const EMPTY_CELL: CellValue = 0;
pub const GARBAGE_CELL: CellValue = 8;

/// `src/core/pieces.ts` `PieceKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
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
    /// `src/core/engine.ts` `BAG` order: the order the 7-bag is shuffled in.
    pub const ALL: [PieceKind; 7] = [
        PieceKind::I,
        PieceKind::O,
        PieceKind::T,
        PieceKind::S,
        PieceKind::Z,
        PieceKind::J,
        PieceKind::L,
    ];

    pub const fn as_char(self) -> char {
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

    /// `src/ai/mino-codes.ts` `kindToMino` (native `MinoType` codes).
    pub const fn to_mino(self) -> i32 {
        match self {
            PieceKind::I => MINO_I,
            PieceKind::J => MINO_J,
            PieceKind::L => MINO_L,
            PieceKind::O => MINO_O,
            PieceKind::T => MINO_T,
            PieceKind::S => MINO_S,
            PieceKind::Z => MINO_Z,
        }
    }

    pub const fn from_mino(mino: i32) -> Option<PieceKind> {
        match mino {
            MINO_I => Some(PieceKind::I),
            MINO_J => Some(PieceKind::J),
            MINO_L => Some(PieceKind::L),
            MINO_O => Some(PieceKind::O),
            MINO_T => Some(PieceKind::T),
            MINO_S => Some(PieceKind::S),
            MINO_Z => Some(PieceKind::Z),
            _ => None,
        }
    }
}

// Native `MinoType` codes (`src/ai/mino-codes.ts`, binary `Tetriz` enum).
pub const MINO_I: i32 = 0;
pub const MINO_J: i32 = 1;
pub const MINO_L: i32 = 2;
pub const MINO_O: i32 = 3;
pub const MINO_T: i32 = 4;
pub const MINO_S: i32 = 5;
pub const MINO_Z: i32 = 6;
pub const MINO_NONE: i32 = 7;

/// `src/core/pieces.ts` `Cell`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Cell {
    pub x: i32,
    pub y: i32,
}

pub const fn cell(x: i32, y: i32) -> Cell {
    Cell { x, y }
}

/// `src/ui/types.ts` `LockAction`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum LockAction {
    #[default]
    None,
    Single,
    Double,
    Triple,
    Quad,
    Tss,
    Tsd,
    Tst,
    Tsm,
    Pc,
}

impl LockAction {
    /// App `LockAction` -> native `ClearAct` code (`hoiko-rust-core.ts`
    /// `LOCK_ACTION_CODE`).
    pub const fn code(self) -> i32 {
        match self {
            LockAction::None => 0,
            LockAction::Single => 1,
            LockAction::Double => 2,
            LockAction::Triple => 3,
            LockAction::Quad => 4,
            LockAction::Tss => 5,
            LockAction::Tsd => 6,
            LockAction::Tst => 7,
            LockAction::Tsm => 8,
            LockAction::Pc => 9,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            LockAction::None => "None",
            LockAction::Single => "Single",
            LockAction::Double => "Double",
            LockAction::Triple => "Triple",
            LockAction::Quad => "Quad",
            LockAction::Tss => "Tss",
            LockAction::Tsd => "Tsd",
            LockAction::Tst => "Tst",
            LockAction::Tsm => "Tsm",
            LockAction::Pc => "Pc",
        }
    }
}

/// `src/core/tspin.ts` `TspinKind` (also `garbage.ts` `TspinAttackKind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TspinKind {
    None,
    Mini,
    Full,
}

impl TspinKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            TspinKind::None => "none",
            TspinKind::Mini => "mini",
            TspinKind::Full => "full",
        }
    }
}

/// `src/ui/types.ts` `ActivePieceView`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ActivePieceView {
    pub kind: PieceKind,
    pub rotation: i32,
    pub cells: [Cell; 4],
    pub pos_x: i32,
    pub pos_y: i32,
}

/// `src/ui/types.ts` `BoardView` (`cols`/`rows` are the fixed [`COLS`]/[`ROWS`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BoardView {
    pub grid: Grid,
}

/// The opponent-aware fields the controller adds to a decision snapshot
/// (`src/versus/controller.ts` `think`, mirroring `GameSnapshot`'s optional
/// `opponent*` fields).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpponentView {
    pub combo: i32,
    pub btb: i32,
    pub lock_id: i32,
    pub board: BoardView,
    /// `opponentLastClearLines` — absent when the opponent has no lock transition.
    pub last_clear_lines: Option<i32>,
    pub last_native_combo: Option<i32>,
    pub last_native_btb: Option<i32>,
    pub last_raw_attack: Option<i32>,
}

/// `src/ui/types.ts` `GameSnapshot`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GameSnapshot {
    pub board: BoardView,
    pub active: Option<ActivePieceView>,
    pub ghost_y: Option<i32>,
    pub hold: Option<PieceKind>,
    pub can_hold: bool,
    pub next: Vec<PieceKind>,
    pub score: i32,
    pub lines: i32,
    pub level: i32,
    pub game_over: bool,
    pub combo: i32,
    pub b2b: bool,
    pub native_combo: i32,
    pub native_btb: i32,
    pub lock_id: i32,
    pub last_action: LockAction,
    pub last_raw_attack: i32,
    pub pending_garbage: i32,
    pub last_attack: i32,
    pub last_blocked: i32,
    /// Only set on the decision snapshot handed to a fighter.
    pub opponent: Option<OpponentView>,
}

/// `src/ui/types.ts` `AiExecutionStep`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AiStep {
    Hold,
    RotateCW,
    RotateCCW,
    Left,
    Right,
    SoftDrop,
    Drop,
    PlaceAt {
        rotation: i32,
        x: i32,
        top_row: Option<i32>,
        last_srs: Option<i32>,
    },
}

/// `src/ui/types.ts` `AiExecutionPlan`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AiExecutionPlan {
    pub target_x: i32,
    pub target_rotation: i32,
    pub steps: Vec<AiStep>,
    /// Bottom-up `Board` rows (`Uint16Array`), the engine's lock transition format.
    pub expected_board: Vec<u16>,
    pub expected_lines_cleared: i32,
    pub source_active_kind: PieceKind,
    pub source_rotation: i32,
    pub source_x: i32,
    pub source_board_fingerprint: String,
    pub source_hold: Option<PieceKind>,
    pub source_can_hold: bool,
}

/// `src/ui/types.ts` `AiMove`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AiMove {
    pub target_x: i32,
    pub target_rotation: i32,
    pub use_hold: bool,
    pub garbage_wait: Option<bool>,
    pub execution: Option<AiExecutionPlan>,
}

/// `src/ui/types.ts` `LockTransition`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LockTransition {
    pub board_after_lock_clear: Vec<u16>,
    pub lines_cleared: i32,
    pub garbage_rows_applied: i32,
    pub action: LockAction,
    pub native_combo: i32,
    pub native_btb: i32,
    pub raw_attack: i32,
    pub sent_attack: i32,
    pub lock_id: i32,
}
