//! SRS kick tables.
//!
//! Faithful port of `src/core/srs.ts` (`JLSTZ`, `I_KICKS`, `NO_KICK`), including
//! the exact kick order the engine's `tryRotate` and `reachable` replay.

use crate::types::PieceKind;

pub use crate::pieces::as_rotation;

/// `src/core/srs.ts` `Kick`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Kick {
    pub dx: i32,
    pub dy: i32,
}

pub const NO_KICK: &[Kick] = &[Kick { dx: 0, dy: 0 }];

const JLSTZ_01: &[Kick] = &[
    Kick { dx: 0, dy: 0 },
    Kick { dx: -1, dy: 0 },
    Kick { dx: -1, dy: 1 },
    Kick { dx: 0, dy: -2 },
    Kick { dx: -1, dy: -2 },
];
const JLSTZ_10: &[Kick] = &[
    Kick { dx: 0, dy: 0 },
    Kick { dx: 1, dy: 0 },
    Kick { dx: 1, dy: -1 },
    Kick { dx: 0, dy: 2 },
    Kick { dx: 1, dy: 2 },
];
const JLSTZ_12: &[Kick] = JLSTZ_10;
const JLSTZ_21: &[Kick] = JLSTZ_01;
const JLSTZ_23: &[Kick] = &[
    Kick { dx: 0, dy: 0 },
    Kick { dx: 1, dy: 0 },
    Kick { dx: 1, dy: 1 },
    Kick { dx: 0, dy: -2 },
    Kick { dx: 1, dy: -2 },
];
const JLSTZ_32: &[Kick] = &[
    Kick { dx: 0, dy: 0 },
    Kick { dx: -1, dy: 0 },
    Kick { dx: -1, dy: -1 },
    Kick { dx: 0, dy: 2 },
    Kick { dx: -1, dy: 2 },
];
const JLSTZ_30: &[Kick] = JLSTZ_32;
const JLSTZ_03: &[Kick] = JLSTZ_23;

const I_01: &[Kick] = &[
    Kick { dx: 0, dy: 0 },
    Kick { dx: -2, dy: 0 },
    Kick { dx: 1, dy: 0 },
    Kick { dx: -2, dy: -1 },
    Kick { dx: 1, dy: 2 },
];
const I_10: &[Kick] = &[
    Kick { dx: 0, dy: 0 },
    Kick { dx: 2, dy: 0 },
    Kick { dx: -1, dy: 0 },
    Kick { dx: 2, dy: 1 },
    Kick { dx: -1, dy: -2 },
];
const I_12: &[Kick] = &[
    Kick { dx: 0, dy: 0 },
    Kick { dx: -1, dy: 0 },
    Kick { dx: 2, dy: 0 },
    Kick { dx: -1, dy: 2 },
    Kick { dx: 2, dy: -1 },
];
const I_21: &[Kick] = &[
    Kick { dx: 0, dy: 0 },
    Kick { dx: 1, dy: 0 },
    Kick { dx: -2, dy: 0 },
    Kick { dx: 1, dy: -2 },
    Kick { dx: -2, dy: 1 },
];
const I_23: &[Kick] = &[
    Kick { dx: 0, dy: 0 },
    Kick { dx: 2, dy: 0 },
    Kick { dx: -1, dy: 0 },
    Kick { dx: 2, dy: 1 },
    Kick { dx: -1, dy: -2 },
];
const I_32: &[Kick] = &[
    Kick { dx: 0, dy: 0 },
    Kick { dx: -2, dy: 0 },
    Kick { dx: 1, dy: 0 },
    Kick { dx: -2, dy: -1 },
    Kick { dx: 1, dy: 2 },
];
const I_30: &[Kick] = &[
    Kick { dx: 0, dy: 0 },
    Kick { dx: 1, dy: 0 },
    Kick { dx: -2, dy: 0 },
    Kick { dx: 1, dy: -2 },
    Kick { dx: -2, dy: 1 },
];
const I_03: &[Kick] = &[
    Kick { dx: 0, dy: 0 },
    Kick { dx: -1, dy: 0 },
    Kick { dx: 2, dy: 0 },
    Kick { dx: -1, dy: 2 },
    Kick { dx: 2, dy: -1 },
];

/// `src/core/srs.ts` `kickTable`. `from`/`to` are normalized rotations.
pub fn kick_table(kind: PieceKind, from: i32, to: i32) -> &'static [Kick] {
    if kind == PieceKind::O {
        return NO_KICK;
    }
    match (kind == PieceKind::I, from, to) {
        (false, 0, 1) => JLSTZ_01,
        (false, 1, 0) => JLSTZ_10,
        (false, 1, 2) => JLSTZ_12,
        (false, 2, 1) => JLSTZ_21,
        (false, 2, 3) => JLSTZ_23,
        (false, 3, 2) => JLSTZ_32,
        (false, 3, 0) => JLSTZ_30,
        (false, 0, 3) => JLSTZ_03,
        (true, 0, 1) => I_01,
        (true, 1, 0) => I_10,
        (true, 1, 2) => I_12,
        (true, 2, 1) => I_21,
        (true, 2, 3) => I_23,
        (true, 3, 2) => I_32,
        (true, 3, 0) => I_30,
        (true, 0, 3) => I_03,
        _ => NO_KICK,
    }
}

/// `src/core/srs.ts` `isTspinKick` (the last SRS kick, index 4).
pub fn is_tspin_kick(kind: PieceKind, kick_index: usize) -> bool {
    if kind != PieceKind::T {
        return false;
    }
    kick_index == 4
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jlstz_0_to_1_has_five_kicks_starting_with_origin() {
        let kicks = kick_table(PieceKind::T, 0, 1);
        assert_eq!(kicks.len(), 5);
        assert_eq!(kicks[0], Kick { dx: 0, dy: 0 });
        assert_eq!(kicks[1], Kick { dx: -1, dy: 0 });
    }

    #[test]
    fn i_0_to_1_differs_from_jlstz() {
        let i = kick_table(PieceKind::I, 0, 1);
        let t = kick_table(PieceKind::T, 0, 1);
        assert_eq!(i.len(), 5);
        assert_ne!(i[1], t[1]);
        assert_eq!(i[1], Kick { dx: -2, dy: 0 });
    }

    #[test]
    fn o_has_no_kicks() {
        assert_eq!(kick_table(PieceKind::O, 0, 1), NO_KICK);
        assert_eq!(kick_table(PieceKind::O, 3, 2), NO_KICK);
    }

    #[test]
    fn every_adjacent_rotation_pair_has_five_kicks_starting_at_origin() {
        for kind in [PieceKind::I, PieceKind::T, PieceKind::S, PieceKind::Z, PieceKind::J, PieceKind::L] {
            for from in 0..4 {
                for delta in [1, 3] {
                    let to = (from + delta) % 4;
                    let kicks = kick_table(kind, from, to);
                    assert_eq!(kicks.len(), 5, "{kind:?} {from}>{to}");
                    assert_eq!(kicks[0], Kick { dx: 0, dy: 0 });
                }
            }
            // 180-degree pairs are absent from the table, like the TS record.
            assert_eq!(kick_table(kind, 0, 2), NO_KICK);
            assert_eq!(kick_table(kind, 2, 0), NO_KICK);
        }
    }

    #[test]
    fn t_spin_kick_is_the_fifth_entry_and_only_for_t() {
        assert!(is_tspin_kick(PieceKind::T, 4));
        assert!(!is_tspin_kick(PieceKind::T, 0));
        assert!(!is_tspin_kick(PieceKind::S, 4));
    }

    #[test]
    fn as_rotation_wraps() {
        assert_eq!(as_rotation(-1), 3);
        assert_eq!(as_rotation(4), 0);
    }
}
