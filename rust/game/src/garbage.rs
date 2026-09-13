//! Guideline-style versus garbage rules (PPT/TEC-like attack table).
//!
//! Faithful port of `src/core/garbage.ts`: attack is computed from the lock
//! result, cancels the sender's own pending (unspawned) garbage first, and the
//! remainder goes to the opponent, where it spawns after a one-lock delay.

use crate::rng::Rng;
use crate::types::TspinKind;

/// `src/core/garbage.ts` `ClearInfo`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClearInfo {
    pub lines: i32,
    pub tspin_lines: i32,
    pub combo: i32,
    pub b2b_active: bool,
    pub perfect_clear: bool,
    /// When absent, `attackForClear` infers `full` from `tspin_lines > 0`.
    pub tspin_kind: Option<TspinKind>,
}

/// `src/core/garbage.ts` `PERFECT_CLEAR_BONUS`.
pub const PERFECT_CLEAR_BONUS: i32 = 10;

const LINE_BASE: [i32; 5] = [0, 0, 1, 2, 4];
const TSPIN_BASE: [i32; 4] = [0, 2, 4, 6];
const MINI_TSPIN_BASE: [i32; 4] = [0, 0, 1, 0];

fn table_get(table: &[i32], index: i32) -> i32 {
    if index < 0 {
        return 0;
    }
    table.get(index as usize).copied().unwrap_or(0)
}

/// `src/core/garbage.ts` `comboBonus`.
pub fn combo_bonus(combo: i32) -> i32 {
    if combo <= 1 {
        0
    } else if combo <= 3 {
        1
    } else if combo <= 5 {
        2
    } else if combo <= 7 {
        3
    } else if combo <= 10 {
        4
    } else {
        5
    }
}

/// `src/core/garbage.ts` `attackForClear`.
pub fn attack_for_clear(info: &ClearInfo) -> i32 {
    if info.lines <= 0 {
        return 0;
    }
    let kind = info
        .tspin_kind
        .unwrap_or(if info.tspin_lines > 0 { TspinKind::Full } else { TspinKind::None });
    let base = match kind {
        TspinKind::Mini => table_get(&MINI_TSPIN_BASE, info.lines),
        TspinKind::Full | TspinKind::None => {
            if info.tspin_lines > 0 {
                table_get(&TSPIN_BASE, info.tspin_lines)
            } else {
                table_get(&LINE_BASE, info.lines)
            }
        }
    };
    let b2b = if info.b2b_active && (info.lines == 4 || info.tspin_lines > 0) {
        1
    } else {
        0
    };
    let combo = combo_bonus(info.combo);
    let pc = if info.perfect_clear { PERFECT_CLEAR_BONUS } else { 0 };
    base + b2b + combo + pc
}

/// `src/core/garbage.ts` `PendingChunk`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PendingChunk {
    pub rows: i32,
    pub timer: i32,
}

/// `src/core/garbage.ts` `GARBAGE_DELAY`.
pub const GARBAGE_DELAY: i32 = 1;

/// `src/core/garbage.ts` `pushIncoming`: merge into the last still-waiting
/// chunk, otherwise append a new chunk with `delay` locks of timer.
pub fn push_incoming(queue: &mut Vec<PendingChunk>, rows: i32, delay: i32) {
    if rows <= 0 {
        return;
    }
    if let Some(last) = queue.last_mut() {
        if last.timer > 0 {
            last.rows += rows;
            return;
        }
    }
    queue.push(PendingChunk { rows, timer: delay });
}

/// `src/core/garbage.ts` `pendingTotal`.
pub fn pending_total(queue: &[PendingChunk]) -> i32 {
    queue.iter().map(|c| c.rows).sum()
}

/// `src/core/garbage.ts` `cancelPending`: consume `attack` from the queue in
/// order and drop emptied chunks from the back.
pub fn cancel_pending(queue: &mut Vec<PendingChunk>, attack: i32) -> i32 {
    let mut rest = attack;
    let mut blocked = 0;
    for chunk in queue.iter_mut() {
        if rest <= 0 {
            break;
        }
        let take = chunk.rows.min(rest);
        chunk.rows -= take;
        rest -= take;
        blocked += take;
    }
    let mut i = queue.len();
    while i > 0 {
        i -= 1;
        if queue[i].rows <= 0 {
            queue.remove(i);
        }
    }
    blocked
}

/// `src/core/garbage.ts` `tickPending`: decrement every timer and return the
/// rows that became due (removed from the queue).
pub fn tick_pending(queue: &mut Vec<PendingChunk>) -> i32 {
    for chunk in queue.iter_mut() {
        chunk.timer -= 1;
    }
    let mut due = 0;
    let mut i = queue.len();
    while i > 0 {
        i -= 1;
        if queue[i].timer <= 0 {
            due += queue[i].rows;
            queue.remove(i);
        }
    }
    due
}

/// `src/core/garbage.ts` `genGarbageHoles`: one hole column per row, with the
/// exact `rand()` call order (a re-roll only when the column repeats and the
/// second roll is below 0.5).
pub fn gen_garbage_holes(count: i32, rng: &mut dyn Rng, prev_hole: i32) -> (Vec<i32>, i32) {
    let mut holes = Vec::with_capacity(count.max(0) as usize);
    let mut prev = prev_hole;
    for _ in 0..count {
        let roll = (rng.next_f64() * 10.0).floor() as i32;
        let mut hole = if (0..=9).contains(&roll) { roll } else { ((roll % 10) + 10) % 10 };
        if hole == prev && rng.next_f64() < 0.5 {
            let reroll = (rng.next_f64() * 10.0).floor() as i32;
            hole = if (0..=9).contains(&reroll) { reroll } else { ((reroll % 10) + 10) % 10 };
        }
        holes.push(hole);
        prev = hole;
    }
    (holes, prev)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rng::SeededRng;
    use crate::types::TspinKind;

    fn info(lines: i32, tspin_lines: i32, combo: i32, b2b: bool, pc: bool, kind: Option<TspinKind>) -> ClearInfo {
        ClearInfo {
            lines,
            tspin_lines,
            combo,
            b2b_active: b2b,
            perfect_clear: pc,
            tspin_kind: kind,
        }
    }

    #[test]
    fn combo_bonus_matches_the_ts_ladder() {
        assert_eq!(combo_bonus(-1), 0);
        assert_eq!(combo_bonus(0), 0);
        assert_eq!(combo_bonus(1), 0);
        assert_eq!(combo_bonus(2), 1);
        assert_eq!(combo_bonus(3), 1);
        assert_eq!(combo_bonus(4), 2);
        assert_eq!(combo_bonus(5), 2);
        assert_eq!(combo_bonus(6), 3);
        assert_eq!(combo_bonus(7), 3);
        assert_eq!(combo_bonus(8), 4);
        assert_eq!(combo_bonus(10), 4);
        assert_eq!(combo_bonus(11), 5);
    }

    #[test]
    fn line_attacks_match_ppt_base() {
        assert_eq!(attack_for_clear(&info(1, 0, 0, false, false, None)), 0);
        assert_eq!(attack_for_clear(&info(2, 0, 0, false, false, None)), 1);
        assert_eq!(attack_for_clear(&info(3, 0, 0, false, false, None)), 2);
        assert_eq!(attack_for_clear(&info(4, 0, 0, false, false, None)), 4);
        assert_eq!(attack_for_clear(&info(0, 0, 0, false, false, None)), 0);
    }

    #[test]
    fn tspin_tables_and_mini_table_select_on_kind() {
        assert_eq!(attack_for_clear(&info(1, 1, 0, false, false, Some(TspinKind::Full))), 2);
        assert_eq!(attack_for_clear(&info(2, 2, 0, false, false, Some(TspinKind::Full))), 4);
        assert_eq!(attack_for_clear(&info(3, 3, 0, false, false, Some(TspinKind::Full))), 6);
        assert_eq!(attack_for_clear(&info(1, 0, 0, false, false, Some(TspinKind::Mini))), 0);
        assert_eq!(attack_for_clear(&info(2, 0, 0, false, false, Some(TspinKind::Mini))), 1);
        // Absent kind + tspin_lines > 0 infers full (the garbage.ts default).
        assert_eq!(attack_for_clear(&info(2, 2, 0, false, false, None)), 4);
    }

    #[test]
    fn b2b_combo_and_perfect_clear_bonuses_stack() {
        let quad = info(4, 0, 0, true, false, None);
        assert_eq!(attack_for_clear(&quad), 5); // 4 + 1 b2b
        let pc_quad = info(4, 0, 0, false, true, None);
        assert_eq!(attack_for_clear(&pc_quad), 14); // 4 + 10
        let combo_triple = info(3, 0, 4, false, false, None);
        assert_eq!(attack_for_clear(&combo_triple), 4); // 2 + 2 combo
        // b2b only applies to quads and T-spin clears.
        let b2b_double = info(2, 0, 0, true, false, None);
        assert_eq!(attack_for_clear(&b2b_double), 1);
    }

    #[test]
    fn push_incoming_merges_into_a_waiting_chunk_only() {
        let mut queue = Vec::new();
        push_incoming(&mut queue, 2, GARBAGE_DELAY);
        assert_eq!(queue, vec![PendingChunk { rows: 2, timer: 1 }]);
        push_incoming(&mut queue, 3, GARBAGE_DELAY);
        assert_eq!(queue, vec![PendingChunk { rows: 5, timer: 1 }]);
        push_incoming(&mut queue, 0, GARBAGE_DELAY);
        push_incoming(&mut queue, -1, GARBAGE_DELAY);
        assert_eq!(queue, vec![PendingChunk { rows: 5, timer: 1 }]);
        // A zero-timer chunk at the tail does not absorb new rows.
        let mut drained = vec![PendingChunk { rows: 1, timer: 0 }];
        push_incoming(&mut drained, 2, GARBAGE_DELAY);
        assert_eq!(drained.len(), 2);
    }

    #[test]
    fn cancel_pending_consumes_in_order_and_drops_empty_tail_chunks() {
        let mut queue = vec![
            PendingChunk { rows: 2, timer: 1 },
            PendingChunk { rows: 3, timer: 2 },
        ];
        let blocked = cancel_pending(&mut queue, 4);
        assert_eq!(blocked, 4);
        assert_eq!(queue, vec![PendingChunk { rows: 1, timer: 2 }]);

        let mut queue = vec![PendingChunk { rows: 1, timer: 1 }];
        assert_eq!(cancel_pending(&mut queue, 5), 1);
        assert!(queue.is_empty());

        let mut empty: Vec<PendingChunk> = Vec::new();
        assert_eq!(cancel_pending(&mut empty, 3), 0);
    }

    #[test]
    fn tick_pending_decrements_and_returns_due_rows_last_chunk_first() {
        let mut queue = vec![
            PendingChunk { rows: 2, timer: 2 },
            PendingChunk { rows: 3, timer: 1 },
        ];
        assert_eq!(tick_pending(&mut queue), 3);
        assert_eq!(queue, vec![PendingChunk { rows: 2, timer: 1 }]);
        assert_eq!(tick_pending(&mut queue), 2);
        assert!(queue.is_empty());
    }

    #[test]
    fn garbage_holes_are_in_range_and_deterministic_per_seed() {
        let mut rng = SeededRng::new(12345);
        let (holes, prev) = gen_garbage_holes(64, &mut rng, 4);
        assert_eq!(holes.len(), 64);
        assert!(holes.iter().all(|h| (0..10).contains(h)));
        assert_eq!(*holes.last().unwrap(), prev);

        let mut rng_a = SeededRng::new(999);
        let mut rng_b = SeededRng::new(999);
        assert_eq!(
            gen_garbage_holes(32, &mut rng_a, 4),
            gen_garbage_holes(32, &mut rng_b, 4)
        );
    }

    #[test]
    fn repeated_hole_rerolls_only_below_half() {
        // rand() = 0.999 puts every roll at column 9; the reroll branch fires
        // only when the second roll is < 0.5, which 0.999 never is.
        struct ConstantRng;
        impl Rng for ConstantRng {
            fn next_f64(&mut self) -> f64 {
                0.999
            }
        }
        let (holes, prev) = gen_garbage_holes(3, &mut ConstantRng, 9);
        assert_eq!(holes, vec![9, 9, 9]);
        assert_eq!(prev, 9);
    }
}
