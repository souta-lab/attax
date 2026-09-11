//! EvaluateAI shared `trustNext` lambda — faithful port of
//! `src/ai/native/evaluate-trust.ts` (SPEC_EvaluateAI §5.1, binary 12706).

use crate::gamepack::GamePack;
use crate::shapes::MINO_T;

pub fn trust_next(g: &GamePack) -> i32 {
    if g.hold.m == MINO_T {
        let mut result = 1;
        for i in 0..7 {
            if g.next_it.get_at(i) == MINO_T {
                result = 2;
                break;
            }
        }
        return result;
    }
    let mut i = 0;
    while g.next_it.get_at(i) != MINO_T {
        i += 1;
        if i >= 6 {
            return 0;
        }
    }
    if !g.next_it.is_trust_next(i) {
        return 0;
    }
    let mut result = 1;
    let mut j = i + 1;
    while j < i + 1 + 6 {
        if g.next_it.get_at(j) == MINO_T {
            result = 2;
            break;
        }
        j += 1;
    }
    result
}
