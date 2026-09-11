//! EvaluateAI.SearchDTCannon + lambdas — faithful port of
//! `src/ai/native/evaluate-dtcannon.ts` (SPEC_EvaluateAI §6, binary 12829).

use crate::evaluate::trust::trust_next;
use crate::gamepack::GamePack;
use crate::weight_index::{
    weight_at, WI_ANABARA, WI_DONATE_COVER, WI_PIERCE, WI_TD_HOLE, WI_TST_CLEARABLE, WI_TST_HOLE,
    WI_TST_OFFENSIVE, WI_TST_SPINABLE,
};
use crate::weights::HoikoWeights;

fn w(ew: &HoikoWeights, i: usize) -> i32 {
    weight_at(ew, i)
}

fn lambda23b(g: &GamePack, base: i32, idx: i32) -> bool {
    (g.board.row_at(base + 5) & (240 >> idx)) == 0
        && (g.board.row_at(base + 6) & (224 >> idx)) == (128 >> idx)
}

fn lambda_e8ff(g: &GamePack, base: i32, idx: i32) -> bool {
    (g.board.row_at(base + 5) & (1920 >> idx)) == 0
        && (g.board.row_at(base + 6) & (896 >> idx)) == (128 >> idx)
}

pub fn search_dtcannon(g: &GamePack, ch: &[i32; 10], y0: i32, ew: &HoikoWeights) -> i32 {
    let line = |y: i32| g.board.row_at(y);
    let trust;

    let mut b = ch[8] - 4;
    if b >= 0
        && (line(b) | 4) == 1023
        && (line(b + 1) | 4) == 1023
        && (line(b + 2) & 0x1f) == 17
        && (line(b + 3) & 0xf) == 9
        && (line(b + 4) & 7) == 3
    {
        if (line(b + 5) & 7) != 0 {
            return 0;
        }
        let mut n = w(ew, WI_TST_HOLE);
        if lambda23b(g, b, 5) {
            n += w(ew, WI_TST_SPINABLE);
            let lo = (b - 1).max(y0);
            let d = b - lo + 4;
            if d <= 2 {
                n -= (ch[7] - (b + 2) * 2 + ch[6]) * w(ew, WI_DONATE_COVER);
            }
            if d > 0 {
                let dd = 3.min(d);
                let dd = (1 << (dd - 1)) + (ch[7] - b - 4) * dd - 1;
                n -= w(ew, WI_PIERCE) * dd;
            }
            if (line(b + 3) & 0xf) == 0 {
                n -= (ch[6] - b - 3) * w(ew, WI_PIERCE);
            }
        }
        let trust = trust_next(g);
        if b > 0 {
            let r = line(b - 1);
            if (r | 2) == 1023 && trust > 1 {
                n += w(ew, WI_TD_HOLE);
            }
            if (r & 4) == 0 {
                n += w(ew, WI_TST_OFFENSIVE);
            }
        }
        if (line(b) | 4) == 1023 && trust > 1 {
            n += w(ew, WI_TST_CLEARABLE);
        }
        if (line(b + 1) | 4) == 1023 {
            n += w(ew, WI_TST_CLEARABLE);
        }
        if (line(b + 2) | 0xe) == 1023 {
            n += w(ew, WI_TST_CLEARABLE);
        }
        if (line(b + 3) | 6) == 1023 {
            if trust > 1 {
                n += w(ew, WI_TST_CLEARABLE);
            }
            n -= w(ew, WI_ANABARA);
        }
        if (line(b + 4) | 4) == 1023 {
            if trust > 1 {
                n += w(ew, WI_TST_CLEARABLE);
            }
            n -= w(ew, WI_ANABARA);
        }
        return if trust <= 0 { n >> 1 } else { n };
    }

    b = ch[1] - 4;
    if b >= 0
        && (line(b) | 0x80) == 1023
        && (line(b + 1) | 0x80) == 1023
        && (line(b + 2) & 0x3e0) == 544
        && (line(b + 3) & 0x3c0) == 576
        && (line(b + 4) & 0x380) == 768
    {
        if (line(b + 5) & 0x780) != 0 {
            return 0;
        }
        let mut n = w(ew, WI_TST_HOLE);
        if lambda_e8ff(g, b, 0) {
            n += w(ew, WI_TST_SPINABLE);
            let lo = (b - 1).max(y0);
            let d = b - lo + 4;
            if d <= 2 {
                n -= (ch[3] - (b + 2) * 2 + ch[2]) * w(ew, WI_DONATE_COVER);
            }
            if d > 0 {
                let dd = 3.min(d);
                let dd = (1 << (dd - 1)) + (ch[3] - b - 4) * dd - 1;
                n -= w(ew, WI_PIERCE) * dd;
            }
            if (line(b + 3) & 0x3c0) == 0 {
                n -= (ch[3] - b - 3) * w(ew, WI_PIERCE);
            }
        }
        trust = trust_next(g);
        if b > 0 {
            let r = line(b - 1);
            if (r | 0x100) == 1023 && trust > 1 {
                n += w(ew, WI_TD_HOLE);
            }
            if (r & 0x80) == 0 {
                n += w(ew, WI_TST_OFFENSIVE);
            }
        }
        if (line(b) | 0x80) == 1023 && trust > 1 {
            n += w(ew, WI_TST_CLEARABLE);
        }
        if (line(b + 1) | 0x80) == 1023 {
            n += w(ew, WI_TST_CLEARABLE);
        }
        if (line(b + 2) | 0x1c0) == 1023 {
            n += w(ew, WI_TST_CLEARABLE);
        }
        if (line(b + 3) | 0x180) == 1023 {
            if trust > 1 {
                n += w(ew, WI_TST_CLEARABLE);
            }
            n -= w(ew, WI_ANABARA);
        }
        if (line(b + 4) | 0x80) == 1023 {
            if trust > 1 {
                n += w(ew, WI_TST_CLEARABLE);
            }
            n -= w(ew, WI_ANABARA);
        }
        return if trust <= 0 { n >> 1 } else { n };
    }
    0
}
