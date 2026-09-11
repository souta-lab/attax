//! EvaluateAI.SearchPcBoard + lambdas — faithful port of
//! `src/ai/native/evaluate-pc.ts` (SPEC_EvaluateAI §3, binary 11618).

use crate::board::js_shr;
use crate::board::FULL_ROW;
use crate::gamepack::GamePack;
use crate::shapes::{MinoType, MINO_I, MINO_J, MINO_L, MINO_O};
use crate::weight_index::{weight_at, WI_PC_CHANCE};
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

/// `SearchPcBoard` (SPEC_EvaluateAI §3); returns a weight term, not a boolean.
pub fn search_pc_board(
    g: &GamePack,
    min_height: i32,
    ew: &HoikoWeights,
    is_even_board: bool,
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
    0
}
