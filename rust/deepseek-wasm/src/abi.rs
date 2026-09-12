use deepseek_rust::{
    Board, PieceKind, V2Input, V2OpponentTelemetry, V2Options, find_best_move_v2_details,
};

pub const BOARD_ROWS: usize = 20;
pub const NEXT_SLOTS: usize = 28;
pub const OPP_SLOTS: usize = 7;

#[derive(Clone, Copy)]
#[repr(C)]
pub struct DsInput {
    pub board: [i32; BOARD_ROWS],
    pub active: i32,
    pub next: [i32; NEXT_SLOTS],
    pub next_len: i32,
    pub hold: i32,
    pub can_hold: i32,
    pub b2b: i32,
    pub combo: i32,
    pub pending_garbage: i32,
    pub pieces: i32,
    pub opp_present: [i32; OPP_SLOTS],
    pub opp_values: [i32; OPP_SLOTS],
    pub depth: i32,
    pub width: i32,
    pub top_k: i32,
    pub use_kicks: i32,
    pub use_opponent: i32,
    pub use_garbage_defense: i32,
    pub use_downstack: i32,
}

#[derive(Clone, Copy, Default)]
#[repr(C)]
pub struct DsOutput {
    pub ok: i32,
    pub x: i32,
    pub rotation: i32,
    pub y: i32,
    pub use_hold: i32,
    pub lines_cleared: i32,
    pub is_tspin: i32,
    pub search_depth: i32,
    pub top_holes: i32,
    pub pad: i32,
    pub score: f64,
    pub fire_score: f64,
    pub top_max_height: f64,
}

fn piece_from_code(code: i32) -> Option<PieceKind> {
    match code {
        0 => Some(PieceKind::I),
        1 => Some(PieceKind::O),
        2 => Some(PieceKind::T),
        3 => Some(PieceKind::S),
        4 => Some(PieceKind::Z),
        5 => Some(PieceKind::J),
        6 => Some(PieceKind::L),
        _ => None,
    }
}

fn option_value(present: i32, value: i32) -> Option<i64> {
    if present == 0 { None } else { Some(i64::from(value)) }
}

pub fn run_best_move(input: &DsInput, out: &mut DsOutput) -> i32 {
    let Some(active) = piece_from_code(input.active) else {
        return 0;
    };
    let mut board: Board = [0u16; BOARD_ROWS];
    for (i, &row) in input.board.iter().enumerate() {
        board[i] = (row as u32 & 0x3ff) as u16;
    }
    let next_len = input.next_len.clamp(0, NEXT_SLOTS as i32) as usize;
    let next: Vec<PieceKind> = input.next[..next_len]
        .iter()
        .filter_map(|&code| piece_from_code(code))
        .collect();
    let opponent = V2OpponentTelemetry {
        lock_id: option_value(input.opp_present[0], input.opp_values[0]),
        last_clear_lines: option_value(input.opp_present[1], input.opp_values[1]),
        last_native_combo: option_value(input.opp_present[2], input.opp_values[2]),
        last_native_btb: option_value(input.opp_present[3], input.opp_values[3]),
        last_raw_attack: option_value(input.opp_present[4], input.opp_values[4]),
        combo: option_value(input.opp_present[5], input.opp_values[5]),
        btb: option_value(input.opp_present[6], input.opp_values[6]),
    };
    let options = V2Options {
        depth: input.depth.max(0) as usize,
        width: input.width.max(0) as usize,
        top_k: input.top_k.max(0) as usize,
        use_kicks: input.use_kicks != 0,
        use_opponent: input.use_opponent != 0,
        use_garbage_defense: input.use_garbage_defense != 0,
        use_downstack: input.use_downstack != 0,
    };
    let v2_input = V2Input {
        board: &board,
        active,
        next: &next,
        hold: piece_from_code(input.hold),
        can_hold: input.can_hold != 0,
        b2b: input.b2b != 0,
        combo: input.combo,
        pending_garbage: input.pending_garbage,
        pieces: input.pieces.max(0) as u32,
        opponent,
        options,
    };
    let Some(details) = find_best_move_v2_details(&v2_input) else {
        *out = DsOutput::default();
        return 0;
    };
    *out = DsOutput {
        ok: 1,
        x: details.mv.x,
        rotation: details.mv.rotation,
        y: details.y,
        use_hold: if details.mv.use_hold { 1 } else { 0 },
        lines_cleared: details.lines_cleared as i32,
        is_tspin: if details.is_tspin { 1 } else { 0 },
        search_depth: details.search_depth as i32,
        top_holes: details.top_holes as i32,
        pad: 0,
        score: details.score,
        fire_score: details.fire_score,
        top_max_height: details.top_max_height,
    };
    1
}

#[cfg(test)]
mod tests {
    use super::{DsInput, DsOutput};
    use core::mem::size_of;

    #[test]
    fn abi_layout_is_stable() {
        assert_eq!(size_of::<DsInput>(), 308);
        assert_eq!(size_of::<DsOutput>(), 64);
    }
}
