//! SRS kick tables — faithful port of `src/core/srs.ts`.
//!
//! `kick_table(kind, from, to)` returns the native 5-entry kick list (index 0 is
//! the identity kick). The engine's `Board.SrsA` / `SrsB` index entries `1..=4`.

/// A single kick offset `(dx, dy)`.
pub type Kick = (i32, i32);

const NO_KICK: [Kick; 1] = [(0, 0)];

const JLSTZ_0_1: [Kick; 5] = [(0, 0), (-1, 0), (-1, 1), (0, -2), (-1, -2)];
const JLSTZ_1_0: [Kick; 5] = [(0, 0), (1, 0), (1, -1), (0, 2), (1, 2)];
const JLSTZ_1_2: [Kick; 5] = [(0, 0), (1, 0), (1, -1), (0, 2), (1, 2)];
const JLSTZ_2_1: [Kick; 5] = [(0, 0), (-1, 0), (-1, 1), (0, -2), (-1, -2)];
const JLSTZ_2_3: [Kick; 5] = [(0, 0), (1, 0), (1, 1), (0, -2), (1, -2)];
const JLSTZ_3_2: [Kick; 5] = [(0, 0), (-1, 0), (-1, -1), (0, 2), (-1, 2)];
const JLSTZ_3_0: [Kick; 5] = [(0, 0), (-1, 0), (-1, -1), (0, 2), (-1, 2)];
const JLSTZ_0_3: [Kick; 5] = [(0, 0), (1, 0), (1, 1), (0, -2), (1, -2)];

const I_0_1: [Kick; 5] = [(0, 0), (-2, 0), (1, 0), (-2, -1), (1, 2)];
const I_1_0: [Kick; 5] = [(0, 0), (2, 0), (-1, 0), (2, 1), (-1, -2)];
const I_1_2: [Kick; 5] = [(0, 0), (-1, 0), (2, 0), (-1, 2), (2, -1)];
const I_2_1: [Kick; 5] = [(0, 0), (1, 0), (-2, 0), (1, -2), (-2, 1)];
const I_2_3: [Kick; 5] = [(0, 0), (2, 0), (-1, 0), (2, 1), (-1, -2)];
const I_3_2: [Kick; 5] = [(0, 0), (-2, 0), (1, 0), (-2, -1), (1, 2)];
const I_3_0: [Kick; 5] = [(0, 0), (1, 0), (-2, 0), (1, -2), (-2, 1)];
const I_0_3: [Kick; 5] = [(0, 0), (-1, 0), (2, 0), (-1, 2), (2, -1)];

/// `PieceKind` as a mino-independent index: I=0, O=1, T=2, S=3, Z=4, J=5, L=6.
pub const KIND_I: i32 = 0;
pub const KIND_O: i32 = 1;
pub const KIND_T: i32 = 2;
pub const KIND_S: i32 = 3;
pub const KIND_Z: i32 = 4;
pub const KIND_J: i32 = 5;
pub const KIND_L: i32 = 6;

fn jlstz(from: i32, to: i32) -> &'static [Kick] {
    match (from, to) {
        (0, 1) => &JLSTZ_0_1,
        (1, 0) => &JLSTZ_1_0,
        (1, 2) => &JLSTZ_1_2,
        (2, 1) => &JLSTZ_2_1,
        (2, 3) => &JLSTZ_2_3,
        (3, 2) => &JLSTZ_3_2,
        (3, 0) => &JLSTZ_3_0,
        (0, 3) => &JLSTZ_0_3,
        _ => &NO_KICK,
    }
}

fn i_kicks(from: i32, to: i32) -> &'static [Kick] {
    match (from, to) {
        (0, 1) => &I_0_1,
        (1, 0) => &I_1_0,
        (1, 2) => &I_1_2,
        (2, 1) => &I_2_1,
        (2, 3) => &I_2_3,
        (3, 2) => &I_3_2,
        (3, 0) => &I_3_0,
        (0, 3) => &I_0_3,
        _ => &NO_KICK,
    }
}

/// `kickTable(kind, from, to)` — O always returns the no-kick list.
pub fn kick_table(kind: i32, from: i32, to: i32) -> &'static [Kick] {
    if kind == KIND_O {
        return &NO_KICK;
    }
    if kind == KIND_I {
        return i_kicks(from, to);
    }
    jlstz(from, to)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_first_entry_and_iat() {
        assert_eq!(kick_table(KIND_T, 0, 1)[0], (0, 0));
        assert_eq!(kick_table(KIND_I, 0, 1)[1], (-2, 0));
        assert_eq!(kick_table(KIND_I, 0, 1)[4], (1, 2));
        assert_eq!(kick_table(KIND_J, 2, 3)[3], (0, -2));
        assert_eq!(kick_table(KIND_O, 0, 1), &NO_KICK);
    }
}
