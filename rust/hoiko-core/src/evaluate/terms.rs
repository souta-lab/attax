//! EvaluateAI board terms — faithful port of `src/ai/native/evaluate-terms.ts`
//! (SPEC_EvaluateAI §2): GetHeight, GetWellColumn, GetUpDown, GetUnderground,
//! GetGround, GetResource.

use crate::board::{log2, popcount, Board, BOARD_HEIGHT, FULL_ROW};
use crate::gamepack::GamePack;
use crate::weight_index::{
    column_at, combo_at, weight_at, WI_ANABARA, WI_BAD_ROOF, WI_COVER, WI_DONATE_COVER, WI_MAX_HEIGHT,
    WI_OVER10, WI_OVER15, WI_PIERCE, WI_RESOURCE, WI_RESOURCE_MAX, WI_ROOF, WI_UPDOWN2,
    WI_WELL_DEPTH, WI_WELL_HINT, WI_WELL_PEAK,
};
use crate::weights::HoikoWeights;

fn w(ew: &HoikoWeights, i: usize) -> i32 {
    weight_at(ew, i)
}

fn col(ew: &HoikoWeights, x: usize) -> i32 {
    column_at(ew, x)
}

fn well_col(line: i32) -> i32 {
    if popcount(line) != 9 {
        return -1;
    }
    popcount(line + 1) - 1
}

pub fn build_column_height(board: &Board, ch: &mut [i32; 10]) -> i32 {
    board.get_column_height(ch)
}

pub fn get_height(board: &Board, ch: &[i32; 10], ew: &HoikoWeights) -> i32 {
    let mut score = (board.stack_height + 1) * w(ew, WI_MAX_HEIGHT);
    if board.stack_height > 9 {
        let mut c4 = ch[3].max(ch[4]).max(ch[5]).max(ch[6]);
        c4 = c4.max(10);
        score += (c4 + 1 - 10) * w(ew, WI_OVER10);
        if c4 > 14 {
            score += (c4 + 1 - 15) * w(ew, WI_OVER15);
        }
    }
    score
}

pub struct WellColumn {
    pub score: i32,
    pub well_column: i32,
    pub well_depth: i32,
}

pub fn get_well_column(
    board: &Board,
    _ch: &[i32; 10],
    garbage_height: i32,
    ew: &HoikoWeights,
) -> WellColumn {
    let line = board.row_at(garbage_height + 1);
    let column = well_col(line);
    if column == -1 {
        return WellColumn { score: 0, well_column: -1, well_depth: 0 };
    }
    let start = ((garbage_height + 2).max(0) as usize).min(BOARD_HEIGHT);
    let mut depth = 1;
    for &row in &board.line[start..] {
        if row != line {
            break;
        }
        depth += 1;
    }
    let mut hint = 1;
    let mask = (1280 >> column) & FULL_ROW;
    for &row in &board.line[start..] {
        if (row & mask) != mask {
            break;
        }
        hint += 1;
    }
    let peak = |dep: i32| if dep == 2 { 1 } else { dep.min(w(ew, WI_WELL_PEAK)) };
    let score = peak(hint) * w(ew, WI_WELL_HINT)
        + peak(depth) * w(ew, WI_WELL_DEPTH)
        + col(ew, column as usize);
    WellColumn { score, well_column: column, well_depth: depth }
}

pub fn get_up_down(
    ch: &[i32; 10],
    well_column: i32,
    well_depth: i32,
    ew: &HoikoWeights,
) -> i32 {
    let mut c = *ch;
    let peak = |dep: i32| dep.min(w(ew, WI_WELL_PEAK));
    if well_column >= 0 {
        c[well_column as usize] += peak(well_depth);
    }
    let mut updown2 = 0;
    let mut diff = c[0] - c[1];
    updown2 += diff * diff * if diff < 0 { 2 } else { 1 };
    for x in 1..8 {
        diff = c[x] - c[x + 1];
        updown2 += diff * diff;
    }
    diff = c[8] - c[9];
    updown2 += diff * diff * if diff > 0 { 2 } else { 1 };
    updown2 * w(ew, WI_UPDOWN2)
}

pub fn get_underground(
    board: &Board,
    ch: &[i32; 10],
    garbage_height: i32,
    ew: &HoikoWeights,
) -> i32 {
    if garbage_height == -1 {
        return 0;
    }
    let mut cover = 0;
    let mut donate_cover = 0;
    let mut bit = board.row_at(garbage_height) ^ FULL_ROW;
    let mut prev_bit = bit;
    while bit != 0 {
        let x = bit & -bit;
        let depth = ch[log2(x) as usize] - garbage_height;
        donate_cover += depth.min(5);
        bit &= !x;
    }
    let mut y = garbage_height - 1;
    while y >= 0 {
        let neg = board.row_at(y) ^ FULL_ROW;
        bit = neg;
        if (bit & !prev_bit) != 0 {
            let mut x = bit & -bit;
            if (bit & !x) == 0 {
                let depth = ch[log2(x) as usize] - y;
                cover += depth.min(5);
            } else {
                loop {
                    let depth = ch[log2(x) as usize] - y;
                    donate_cover += depth;
                    bit &= !x;
                    if bit == 0 {
                        break;
                    }
                    x = bit & -bit;
                }
            }
        }
        prev_bit = neg;
        y -= 1;
    }
    donate_cover * w(ew, WI_DONATE_COVER) + cover * w(ew, WI_COVER)
}

/// Binary `GetResource.<lambda>` (IL 11490): recognizes only `line[y] == 0x3F`
/// (right six columns full) / `0x3F0` (left six), counts the equal-mask run
/// height `h`, requires >=2 cells outside the mask below it, then returns the
/// `comboTable` tier for `h` (plus `game.combo` when `h >= 4 && combo > 2`).
/// `opponent_is_powerful_board` is the EvaluateAI static the versus
/// `ObserveOpponent` sets each turn (IL 4687); when set it vetoes the `h < 11`
/// tiers. Solo/offline keeps it false (IL 11045).
fn s4w_bonus(
    g: &GamePack,
    min_height: i32,
    ew: &HoikoWeights,
    opponent_is_powerful_board: bool,
) -> i32 {
    let sh = g.board.stack_height;
    if sh <= min_height {
        return 0;
    }
    let mut y = sh;
    let mut cover = 0;
    loop {
        let row = g.board.row_at(y);
        cover |= row;
        let mask = if row == 0x3F {
            if (cover & 0x3C0) != 0 {
                return 0;
            }
            0x3F
        } else if row == 0x3F0 {
            if (cover & 0xF) != 0 {
                return 0;
            }
            0x3F0
        } else {
            y -= 1;
            if y <= min_height {
                return 0;
            }
            continue;
        };
        if y == 0 || sh + 1 > 13 {
            return 0;
        }
        let mut h = 1;
        let mut below = y - 1;
        if below > min_height {
            while g.board.row_at(below) == mask {
                h += 1;
                below -= 1;
                if below <= min_height {
                    break;
                }
            }
        }
        if below > min_height {
            let mut overhang = 0;
            loop {
                overhang += popcount(g.board.row_at(below) & !mask);
                below -= 1;
                if below <= min_height {
                    break;
                }
            }
            if overhang >= 2 {
                if h >= 4 && g.combo > 2 {
                    h += g.combo;
                }
                let mut bonus = 0;
                if min_height <= h && h >= 4 {
                    if h >= 6 {
                        if h >= 8 {
                            if h >= 11 {
                                if h >= 12 {
                                    bonus = combo_at(ew, 4);
                                }
                                bonus += combo_at(ew, 3);
                            } else if opponent_is_powerful_board {
                                return 0;
                            }
                            bonus += combo_at(ew, 2);
                        } else if opponent_is_powerful_board {
                            return 0;
                        }
                        bonus += combo_at(ew, 1);
                    } else if opponent_is_powerful_board {
                        return 0;
                    }
                    bonus += combo_at(ew, 0);
                }
                return bonus;
            }
        }
        return 0;
    }
}

pub fn get_resource(
    g: &GamePack,
    _ch: &[i32; 10],
    garbage_height: i32,
    ew: &HoikoWeights,
    use_s4w: bool,
    opponent_is_powerful_board: bool,
) -> i32 {
    let board = &g.board;
    let mut anabara = 0;
    let mut resource = 0;
    let mut line = board.row_at(0);
    for y in 1..=garbage_height {
        if (line | board.row_at(y)) != line {
            anabara += 1;
        }
        line = board.row_at(y);
    }
    let mut y = garbage_height + 1;
    while y <= board.stack_height {
        resource += popcount(board.row_at(y));
        if resource >= w(ew, WI_RESOURCE_MAX) {
            resource = w(ew, WI_RESOURCE_MAX);
            break;
        }
        y += 1;
    }
    line = 0;
    if garbage_height >= 0 {
        let x = well_col(board.row_at(garbage_height));
        if x >= 0 {
            line = (col(ew, x as usize) as f64 * 0.5) as i32;
        }
    }
    if use_s4w {
        line += s4w_bonus(g, garbage_height, ew, opponent_is_powerful_board);
    }
    line + anabara * w(ew, WI_ANABARA) + resource * w(ew, WI_RESOURCE)
}

pub fn get_ground(g: &GamePack, ch: &[i32; 10], y0: i32, ew: &HoikoWeights) -> i32 {
    let mut roof = 0;
    let mut roof_cnt = 0;
    let mut bad_roof = 0;
    let mut pierce = 0;
    let bd = &g.board;
    let top_row = if 0 >= bd.stack_height { 0 } else { bd.stack_height };
    let mut cover = bd.row_at(top_row);
    let mut y = bd.stack_height - 1;
    if y > y0 {
        let mut count = y - y0;
        loop {
            let row = bd.row_at(y);
            let mut empty = !row & cover;
            let mut row_max = 0;
            while empty != 0 {
                let x = log2(empty & -empty);
                let depth = ch[x as usize] - y;
                if x < 8 && ch[(x + 1) as usize] < y {
                    if ch[(x + 2) as usize] < y {
                        roof += depth;
                        roof_cnt += 1;
                    } else {
                        bad_roof += depth;
                    }
                } else if x > 1 && ch[(x - 1) as usize] < y {
                    if ch[(x - 2) as usize] < y {
                        roof += depth;
                        roof_cnt += 1;
                    } else {
                        bad_roof += depth;
                    }
                } else {
                    row_max = row_max.max(depth);
                }
                empty &= !(512 >> x);
            }
            pierce += row_max;
            cover |= row;
            y -= 1;
            count -= 1;
            if count == 0 {
                break;
            }
        }
        if roof_cnt == 1 {
            roof = 1;
        }
    }
    w(ew, WI_PIERCE) * pierce + w(ew, WI_BAD_ROOF) * bad_roof + w(ew, WI_ROOF) * roof
}
