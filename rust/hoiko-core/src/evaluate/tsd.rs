//! EvaluateAI.SearchTsd — faithful port of the SearchTsd half of
//! `src/ai/native/evaluate-tsd.ts` (SPEC_EvaluateAI §4).

use crate::board::{log2, Board};
use crate::gamepack::GamePack;
use crate::shapes::MINO_T;
use crate::weight_index::{
    weight_at, WI_PIERCE, WI_TSD_CLEARABLE, WI_TSD_HOLE, WI_TSD_OFFENSIVE, WI_TSD_SPINABLE,
};
use crate::weights::HoikoWeights;


fn w(ew: &HoikoWeights, i: usize) -> i32 {
    weight_at(ew, i)
}

fn tsd_pierce(ch: &[i32; 10], y: i32, off: i32, mask: i32, board: &Board) -> i32 {
    let mut m = board.row_at(y - 1) | mask;
    if m == 1023 {
        return 0;
    }
    m ^= 1023;
    let mut mx = 0;
    while m != 0 {
        let b = m & -m;
        mx = mx.max(ch[log2(b) as usize] - y + 1);
        m &= !b;
    }
    if off < 2 {
        mx -= 1;
    }
    if mx > 2 {
        mx = 4 - mx;
    }
    if mx > 0 { mx } else { 0 }
}

pub fn search_tsd(g: &GamePack, ch: &[i32; 10], y0: i32, ew: &HoikoWeights) -> i32 {
    let line = |y: i32| g.board.row_at(y);
    let mut score = 0;

    let mut lim = ch[0].min(ch[2]) + 1;
    let mut start = y0.max(ch[1] + 1);
    let mut y = start;
    while y < lim {
        let off = y - y0;
        if (line(y) & 0x380) == 0x280 {
            if (line(y + 1) & 0x380) == 0 {
                score += w(ew, WI_TSD_HOLE);
                if (line(y + 2) & 0x380) == 0x080 {
                    score += w(ew, WI_TSD_SPINABLE);
                }
                if y > 0 && (line(y - 1) & 0x280) == 0x200 {
                    score += w(ew, WI_TSD_OFFENSIVE);
                }
                let mut clearable = 0;
                if (line(y) | 0x100) == 1023 {
                    clearable = 1;
                }
                if (line(y + 1) | 0x380) == 1023 {
                    clearable += 1;
                }
                if clearable > 0 {
                    score += w(ew, WI_TSD_CLEARABLE) * clearable;
                    if y > 0 && y != y0 {
                        score -= w(ew, WI_PIERCE) * tsd_pierce(ch, y, off, 0x380, &g.board);
                    }
                }
            }
        }
        y += 1;
    }

    lim = ch[9].min(ch[7]) + 1;
    start = y0.max(ch[8] + 1);
    y = start;
    while y < lim {
        let off = y - y0;
        if (line(y) & 7) == 5 {
            if (line(y + 1) & 7) == 0 {
                score += w(ew, WI_TSD_HOLE);
                if (line(y + 2) & 7) == 4 {
                    score += w(ew, WI_TSD_SPINABLE);
                }
                if y > 0 && (line(y - 1) & 5) == 1 {
                    score += w(ew, WI_TSD_OFFENSIVE);
                }
                let mut clearable = 0;
                if (line(y) | 2) == 1023 {
                    clearable = 1;
                }
                if (line(y + 1) | 7) == 1023 {
                    clearable += 1;
                }
                if clearable > 0 {
                    score += w(ew, WI_TSD_CLEARABLE) * clearable;
                    if y > 0 && y != y0 {
                        score -= w(ew, WI_PIERCE) * tsd_pierce(ch, y, off, 7, &g.board);
                    }
                }
            }
        }
        y += 1;
    }

    for k in 0..6 {
        let lim_k = ch[k + 1].min(ch[k + 3]) + 1;
        let start_k = y0.max(ch[k + 2] + 1);
        let mut y = start_k;
        while y < lim_k {
            let off = y - y0;
            let ma = 320 >> k;
            let mabc = 448 >> k;
            if (line(y) & mabc) == ma {
                if (line(y + 1) & mabc) == 0 {
                    score += w(ew, WI_TSD_HOLE);
                    let v = line(y + 2) & mabc;
                    if v == (256 >> k) {
                        score += w(ew, WI_TSD_SPINABLE);
                        if y > 0 && (line(y - 1) & ma) == (64 >> k) {
                            score += w(ew, WI_TSD_OFFENSIVE);
                        }
                    } else if v == (64 >> k) {
                        score += w(ew, WI_TSD_SPINABLE);
                        if y > 0 && (line(y - 1) & ma) == (256 >> k) {
                            score += w(ew, WI_TSD_OFFENSIVE);
                        }
                    }
                    let mut clearable = 0;
                    if ((128 >> k) | line(y)) == 1023 {
                        clearable = 1;
                    }
                    if (line(y + 1) | mabc) == 1023 {
                        clearable += 1;
                    }
                    if clearable > 0 {
                        score += w(ew, WI_TSD_CLEARABLE) * clearable;
                        if y > 0 && y != y0 {
                            score -= w(ew, WI_PIERCE) * tsd_pierce(ch, y, off, mabc, &g.board);
                        }
                    }
                }
            }
            y += 1;
        }
    }

    if score != 0 {
        if g.hold.m == MINO_T {
            return score;
        }
        for i in 0..7 {
            if g.next_it.get_at(i) == MINO_T {
                return score;
            }
        }
        return score >> 1;
    }
    score
}

