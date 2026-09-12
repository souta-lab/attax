//! EvaluateAI.SearchPcBoard + lambdas — faithful port of
//! `src/ai/native/evaluate-pc.ts` (SPEC_EvaluateAI §3, binary 11618).

use crate::board::js_shr;
use crate::board::FULL_ROW;
use crate::gamepack::GamePack;
use crate::shapes::{MinoType, MINO_I, MINO_J, MINO_L, MINO_O};
use crate::weight_index::{weight_at, WI_PC_CHANCE, WI_PC_STACK};
use crate::weights::HoikoWeights;

fn search_pc(g: &GamePack, m: MinoType) -> bool {
    let line = |y: i32| g.board.row_at(y);
    let sh = g.board.stack_height;
    if m == MINO_I {
        if sh == 0 {
            for x in 0..7 {
                if (line(0) ^ (960 >> x)) == FULL_ROW {
                    return true;
                }
            }
        } else if sh == 3 {
            for x in 0..10 {
                if (line(3) ^ (512 >> x)) == FULL_ROW {
                    let t = line(3);
                    if line(2) != t || line(1) != t || line(0) != t {
                        break;
                    }
                    return true;
                }
            }
        }
    } else if m == MINO_J {
        if sh == 1 {
            for x in 0..8 {
                if (line(1) ^ (896 >> x)) == FULL_ROW {
                    if (line(0) ^ (128 >> x)) != FULL_ROW {
                        break;
                    }
                    return true;
                }
            }
            for x in 0..8 {
                if (line(0) ^ (896 >> x)) == FULL_ROW {
                    if (line(1) ^ (512 >> x)) != FULL_ROW {
                        break;
                    }
                    return true;
                }
            }
        } else if sh == 2 {
            for x in 0..9 {
                if (line(2) ^ (768 >> x)) == FULL_ROW {
                    if (line(1) ^ (512 >> x)) != FULL_ROW {
                        break;
                    }
                    if (line(0) ^ (512 >> x)) != FULL_ROW {
                        break;
                    }
                    return true;
                }
            }
        }
    } else if m == MINO_L {
        if sh == 1 {
            for x in 0..8 {
                if (line(1) ^ (896 >> x)) == FULL_ROW {
                    if (line(0) ^ (512 >> x)) != FULL_ROW {
                        break;
                    }
                    return true;
                }
            }
            for x in 0..8 {
                if (line(0) ^ (896 >> x)) == FULL_ROW {
                    if (line(1) ^ (128 >> x)) != FULL_ROW {
                        break;
                    }
                    return true;
                }
            }
        } else if sh == 2 {
            for x in 0..9 {
                if (line(2) ^ (768 >> x)) == FULL_ROW {
                    if (line(1) ^ (256 >> x)) != FULL_ROW {
                        break;
                    }
                    if (line(0) ^ (256 >> x)) != FULL_ROW {
                        break;
                    }
                    return true;
                }
            }
        }
    } else if m == MINO_O {
        if sh == 1 {
            for x in 0..9 {
                if (line(1) ^ (768 >> x)) == FULL_ROW {
                    if (line(0) ^ (768 >> x)) != FULL_ROW {
                        break;
                    }
                    return true;
                }
            }
        }
    } else if m == 4 {
        if sh == 1 {
            for x in 0..8 {
                if (line(1) ^ (896 >> x)) == FULL_ROW {
                    if (line(0) ^ (256 >> x)) != FULL_ROW {
                        break;
                    }
                    return true;
                }
            }
        }
    } else if m == 5 {
        if sh == 1 {
            for x in 0..8 {
                if (line(1) ^ (384 >> x)) == FULL_ROW {
                    if (line(0) ^ (768 >> x)) != FULL_ROW {
                        break;
                    }
                    return true;
                }
            }
        }
    } else if m == 6
        && sh == 1
    {
        for x in 0..8 {
            if (line(1) ^ (768 >> x)) == FULL_ROW {
                if (line(0) ^ (384 >> x)) != FULL_ROW {
                    break;
                }
                return true;
            }
        }
    }
    false
}

fn pc_setup(g: &GamePack) -> bool {
    if g.board.stack_height > 1 {
        return false;
    }
    if g.locked_mino.m != MINO_O {
        return false;
    }
    let mut ci = 0;
    let mut cj = 0;
    let mut cl = 0;
    let mut co = 1;
    match g.hold.m {
        MINO_O => co = 2,
        MINO_L => cl = 1,
        MINO_J => cj = 1,
        MINO_I => ci = 1,
        _ => {}
    }
    for i in 0..4 {
        match g.next_it.get_at(i) {
            MINO_O => co += 1,
            MINO_L => cl += 1,
            MINO_J => cj += 1,
            MINO_I => ci += 1,
            _ => {}
        }
    }
    let v = g.locked_mino.x;
    let v_ok = v != 2 && v != 3 && v != 4;
    let row_ok = || g.board.row_at(0) == js_shr(768, v + 1);
    if ci >= 1 && cj >= 1 && cl >= 1 && co >= 2 {
        return v_ok && row_ok();
    }
    if (ci >= 2 && (cj >= 2 || cl >= 2)) || (cj >= 2 && cl >= 2) {
        return v_ok && row_ok();
    }
    false
}

/// `lambda1b_valid` (binary 11697): for every run of non-full columns between
/// two full-through-`goal_h` columns, the holes over rows `0..=goal_h` must be a
/// multiple of 4. The asymmetry (a full column leading the scan does not seed
/// `acc`) is transcribed exactly from IL 11715-11748.
fn pc_stack_valid(g: &GamePack, goal_h: i32) -> bool {
    let mut full = FULL_ROW;
    for i in 0..=goal_h {
        full &= g.board.row_at(i);
    }
    let mut acc = 0i32;
    for col in 0..10 {
        let bit = js_shr(512, col);
        if (full & bit) != 0 {
            if acc == 0 {
                continue;
            }
            let mut holes = 0;
            for i in 0..=goal_h {
                holes += crate::board::popcount((!g.board.row_at(i)) & acc);
            }
            if (holes & 3) != 0 {
                return false;
            }
            acc = 0;
        }
        acc |= bit;
    }
    true
}

/// `lambda1_pcStack` (binary 11660) — the PC-stack board-depth estimate.
fn pc_stack(g: &GamePack) -> i32 {
    if g.board.stack_height > 3 {
        return 0;
    }
    let goal_h = if (g.board.pop_count() & 3) == 0 { 3 } else { 2 };
    if goal_h > g.board.stack_height {
        return 1;
    }
    if !pc_stack_valid(g, goal_h) {
        return 0;
    }
    let mut full = FULL_ROW;
    for i in 0..=g.board.stack_height {
        full &= g.board.row_at(i);
    }
    crate::board::popcount(full) + 1
}

/// `SearchPcBoard` (SPEC_EvaluateAI §3); returns a weight term, not a boolean.
/// The `usePCstack` config gate (binary 11649) only guards `lambda1`;
/// the `minHeight == -1` PcChance branch always runs.
pub fn search_pc_board(
    g: &GamePack,
    min_height: i32,
    ew: &HoikoWeights,
    is_even_board: bool,
    use_pcstack: bool,
) -> i32 {
    if !is_even_board {
        return 0;
    }
    if min_height == -1 {
        if search_pc(g, g.falling_mino.m) {
            return weight_at(ew, WI_PC_CHANCE);
        }
        if g.falling_mino.m != g.hold.m && search_pc(g, g.hold.m) {
            return weight_at(ew, WI_PC_CHANCE);
        }
        if pc_setup(g) {
            return weight_at(ew, WI_PC_CHANCE);
        }
    }
    if use_pcstack {
        let w = weight_at(ew, WI_PC_STACK);
        if w != 0 {
            return pc_stack(g) * w;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(rows: &[i32], stack_height: i32) -> GamePack {
        let mut g = GamePack::default();
        for (y, row) in rows.iter().enumerate() {
            g.board.line[y] = *row;
        }
        g.board.stack_height = stack_height;
        g
    }

    #[test]
    fn pc_stack_goal_above_stack_returns_one() {
        assert_eq!(pc_stack(&g(&[0b10], 0)), 1);
        assert_eq!(pc_stack(&g(&[], -1)), 1);
    }

    #[test]
    fn pc_stack_valid_columns_with_hole_run() {
        assert_eq!(pc_stack(&g(&[0x201, 0x201, 0x201], 2)), 3);
    }

    #[test]
    fn pc_stack_invalid_hole_run_returns_zero() {
        assert_eq!(pc_stack(&g(&[0x00f, 0x00f, 0x01f], 2)), 0);
    }
}
