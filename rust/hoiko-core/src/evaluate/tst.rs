//! EvaluateAI.SearchTst + lambdas — faithful port of the SearchTst half of
//! `src/ai/native/evaluate-tsd.ts` (SPEC_EvaluateAI §4-§5).

use crate::evaluate::dtcannon::search_dtcannon;
use crate::evaluate::trust::trust_next;
use crate::gamepack::GamePack;
use crate::weight_index::{
    weight_at, WI_ANABARA, WI_BAD_ROOF, WI_DONATE_COVER, WI_PIERCE, WI_TD_HINT, WI_TD_HOLE,
    WI_TST_CLEARABLE, WI_TST_HINT, WI_TST_HOLE, WI_TST_OFFENSIVE, WI_TST_SPINABLE,
};
use crate::weights::HoikoWeights;

fn w(ew: &HoikoWeights, i: usize) -> i32 {
    weight_at(ew, i)
}

fn lambda0dc(g: &GamePack, row: i32, idx: usize) -> bool {
    let m = 480 >> idx;
    let x = g.board.row_at(row + 3) & m;
    if x == 0 && (g.board.row_at(row + 4) & (448 >> idx)) == (256 >> idx) {
        return true;
    }
    if x == (32 >> idx) && (g.board.row_at(row + 4) & m) == (288 >> idx) {
        return true;
    }
    false
}

fn lambda6695(g: &GamePack, row: i32, idx: usize) -> bool {
    (g.board.row_at(row + 3) & (480 >> idx)) == 0
        && (g.board.row_at(row + 4) & (448 >> idx)) == (256 >> idx)
}

fn lambda_a670(g: &GamePack, row: i32, idx: usize) -> bool {
    let m = 1920 >> idx;
    let x = g.board.row_at(row + 3) & m;
    if x == 0 && (g.board.row_at(row + 4) & (896 >> idx)) == (128 >> idx) {
        return true;
    }
    if x == (1024 >> idx) && (g.board.row_at(row + 4) & m) == (1152 >> idx) {
        return true;
    }
    false
}

fn lambda0efe(g: &GamePack, row: i32, idx: usize) -> bool {
    (g.board.row_at(row + 3) & (1920 >> idx)) == 0
        && (g.board.row_at(row + 4) & (896 >> idx)) == (128 >> idx)
}

pub fn search_tst(
    g: &GamePack,
    ch: &[i32; 10],
    y0: i32,
    min_height: i32,
    ew: &HoikoWeights,
) -> i32 {
    let line = |y: i32| g.board.row_at(y);
    let dtc = search_dtcannon(g, ch, y0, ew);
    if dtc != 0 {
        return dtc;
    }

    for idx in 0..7 {
        let row = ch[idx + 2] - 2;
        if row < 0 {
            continue;
        }
        let r = line(row);
        if ((r >> (7 - idx)) & 7) == 5 {
            if (line(row + 1) & (896 >> idx)) == (512 >> idx)
                && (line(row + 2) & (384 >> idx)) == (128 >> idx)
            {
                let x = line(row + 3) & (480 >> idx);
                if x != 0 {
                    let t = 32 >> idx;
                    if x != t || (line(row + 4) & (224 >> idx)) != t {
                        continue;
                    }
                }
                let mut n = w(ew, WI_TST_HOLE);
                if lambda0dc(g, row, idx) {
                    n += w(ew, WI_TST_SPINABLE);
                    let d = row - (row - 1).max(y0) + 2;
                    if d <= 0 {
                        n -= (ch[idx + 1] - row) * w(ew, WI_DONATE_COVER);
                    } else {
                        n -= ((1 << (d - 1)) + (ch[idx + 1] - row - 2) * d - 1) * w(ew, WI_PIERCE);
                    }
                    if (line(row + 3) & (960 >> idx)) == 0 {
                        n -= (ch[idx] - row - 3) * w(ew, WI_PIERCE);
                    }
                }
                let mut bits = 0;
                let c = 256 >> idx;
                if (line(row) | c) == 1023 {
                    n += w(ew, WI_TST_CLEARABLE);
                    bits = 1;
                }
                if (line(row + 1) | (384 >> idx)) == 1023 {
                    n += w(ew, WI_TST_CLEARABLE);
                    bits |= 2;
                }
                if (line(row + 2) | c) == 1023 {
                    n += w(ew, WI_TST_CLEARABLE) - w(ew, WI_ANABARA);
                    bits |= 4;
                }
                let tr = trust_next(g);
                bits += 1;
                if tr > 1 && (bits - (-bits & bits)) == 0 {
                    if row <= 0 {
                        return if tr <= 0 { n >> 1 } else { n };
                    }
                    if (line(row - 1) | (128 >> idx)) == 1023 {
                        n += w(ew, WI_TD_HOLE);
                    }
                }
                if row > 0 && (line(row - 1) & (256 >> idx)) == 0 {
                    n += w(ew, WI_TST_OFFENSIVE);
                }
                return if tr <= 0 { n >> 1 } else { n };
            }
        } else if idx == 6
            && row > 0
            && (line(row + 1) ^ 6) == 1023
            && (line(row - 1) | 2) == 1023
            && (r & 0xe) == 8
            && (line(row + 2) & 6) == 2
            && (line(row + 3) & 7) == 0
        {
            let mut n = w(ew, WI_TST_HOLE);
            if lambda6695(g, row, idx) {
                n += w(ew, WI_TST_SPINABLE);
                let d = row - (row - 1).max(y0) + 2;
                if d <= 0 {
                    n -= (ch[idx + 1] - row) * w(ew, WI_DONATE_COVER);
                } else {
                    n -= ((1 << (d - 1)) + (ch[idx + 1] - row - 2) * d - 1) * w(ew, WI_PIERCE);
                }
            } else {
                n += w(ew, WI_BAD_ROOF) * -2;
            }
            let tr = trust_next(g);
            if (line(row) | (384 >> idx)) == 1023 && tr > 1 {
                n += w(ew, WI_TST_CLEARABLE);
            }
            if (line(row + 2) | (256 >> idx)) == 1023 {
                n += w(ew, WI_TST_CLEARABLE) - w(ew, WI_ANABARA);
            }
            return if tr <= 0 { n >> 1 } else { n };
        }
    }

    for idx in 0..7 {
        let row = ch[idx + 1] - 2;
        if row < 0 {
            continue;
        }
        let r = line(row);
        if ((r >> (6 - idx)) & 7) == 5 {
            if (line(row + 1) & (448 >> idx)) == (64 >> idx)
                && (line(row + 2) & (384 >> idx)) == (256 >> idx)
            {
                let x = line(row + 3) & (1920 >> idx);
                if x != 0 {
                    let t = 1024 >> idx;
                    if x != t || (line(row + 4) & (1792 >> idx)) != t {
                        continue;
                    }
                }
                let mut n = w(ew, WI_TST_HOLE);
                if lambda_a670(g, row, idx) {
                    n += w(ew, WI_TST_SPINABLE);
                    let d = row - (row - 1).max(y0) + 2;
                    if d <= 0 {
                        n -= (ch[idx + 2] - row) * w(ew, WI_DONATE_COVER);
                    } else {
                        n -= ((1 << (d - 1)) + (ch[idx + 2] - row - 2) * d - 1) * w(ew, WI_PIERCE);
                    }
                    if (line(row + 3) & (960 >> idx)) == 0 {
                        n -= (ch[idx + 3] - row - 3) * w(ew, WI_PIERCE);
                    }
                }
                let mut bits = 0;
                let c = 128 >> idx;
                if (line(row) | c) == 1023 {
                    n += w(ew, WI_TST_CLEARABLE);
                    bits = 1;
                }
                if (line(row + 1) | (384 >> idx)) == 1023 {
                    n += w(ew, WI_TST_CLEARABLE);
                    bits |= 2;
                }
                if (line(row + 2) | c) == 1023 {
                    n += w(ew, WI_TST_CLEARABLE) - w(ew, WI_ANABARA);
                    bits |= 4;
                }
                let tr = trust_next(g);
                bits += 1;
                if tr > 1 && (bits - (-bits & bits)) == 0 {
                    if row <= 0 {
                        return if tr <= 0 { n >> 1 } else { n };
                    }
                    if (line(row - 1) | (256 >> idx)) == 1023 {
                        n += w(ew, WI_TD_HOLE);
                    }
                }
                if row > 0 && (line(row - 1) & (128 >> idx)) == 0 {
                    n += w(ew, WI_TST_OFFENSIVE);
                }
                return if tr <= 0 { n >> 1 } else { n };
            }
        } else if idx == 0
            && row > 0
            && (line(row + 1) ^ 0x180) == 1023
            && (line(row - 1) | 0x100) == 1023
            && (r & 0x1c0) == 64
            && (line(row + 2) & 0x180) == 256
            && (line(row + 3) & 0x780) == 0
        {
            let mut n = w(ew, WI_TST_HOLE);
            if lambda0efe(g, row, idx) {
                n += w(ew, WI_TST_SPINABLE);
                let d = row - (row - 1).max(y0) + 2;
                if d <= 0 {
                    n -= (ch[idx + 2] - row) * w(ew, WI_DONATE_COVER);
                } else {
                    n -= ((1 << (d - 1)) + (ch[idx + 2] - row - 2) * d - 1) * w(ew, WI_PIERCE);
                }
            } else {
                n += w(ew, WI_BAD_ROOF) * -2;
            }
            let tr = trust_next(g);
            if (line(row) | (384 >> idx)) == 1023 && tr > 1 {
                n += w(ew, WI_TST_CLEARABLE);
            }
            if (line(row + 2) | (128 >> idx)) == 1023 {
                n += w(ew, WI_TST_CLEARABLE) - w(ew, WI_ANABARA);
            }
            return if tr <= 0 { n >> 1 } else { n };
        }
    }

    let r2 = line(min_height + 2);
    for i in 0..7 {
        if ((r2 >> (6 - i)) & 0xf) == 9 {
            let v = line(min_height + 1) & (960 >> i);
            if i < 6 && v == (704 >> i) {
                if (line(min_height + 3) & (224 >> i)) == 0 {
                    if min_height >= 0 && (line(min_height) & (960 >> i)) == (832 >> i) {
                        return w(ew, WI_TD_HINT);
                    }
                    return w(ew, WI_TST_HINT);
                }
            } else if i > 0
                && v == (832 >> i)
                && (line(min_height + 3) & (1792 >> i)) == 0
            {
                if min_height >= 0 && (line(min_height) & (960 >> i)) == (704 >> i) {
                    return w(ew, WI_TD_HINT);
                }
                return w(ew, WI_TST_HINT);
            }
        }
    }
    0
}
