//! SRS kick table and kick/tuck-aware placement enumeration.
//!
//! Ported from `src/core/srs.ts` and `enumerateKickPlacements` /
//! `reachableLandings` in `src/ai/search.ts`. The BFS order and the hard-drop
//! dedup semantics are intentionally byte-for-byte equivalent so the beam sees
//! exactly the same placement list (and therefore the same tie-breaks) as the
//! TypeScript v2 fighter.

use std::collections::HashSet;

use crate::board::{Board, collides, drop_y};
use crate::pieces::{Cell, PieceKind, bottom_cells, cells_for, rotation_count};
use crate::search::{ScoredPlacement, enumerate_scored_flat, push_placement};
use crate::weights::Weights;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Kick {
    pub dx: i32,
    pub dy: i32,
}

const NO_KICK: &[Kick] = &[Kick { dx: 0, dy: 0 }];

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
const I_23: &[Kick] = I_10;
const I_32: &[Kick] = I_01;
const I_30: &[Kick] = I_21;
const I_03: &[Kick] = I_12;

/// Kick candidates for a rotation transition, mirroring `kickTable` in
/// `src/core/srs.ts`.
pub fn kick_table(kind: PieceKind, from: usize, to: usize) -> &'static [Kick] {
    if kind == PieceKind::O {
        return NO_KICK;
    }
    let table = if kind == PieceKind::I {
        match (from, to) {
            (0, 1) => I_01,
            (1, 0) => I_10,
            (1, 2) => I_12,
            (2, 1) => I_21,
            (2, 3) => I_23,
            (3, 2) => I_32,
            (3, 0) => I_30,
            (0, 3) => I_03,
            _ => NO_KICK,
        }
    } else {
        match (from, to) {
            (0, 1) => JLSTZ_01,
            (1, 0) => JLSTZ_10,
            (1, 2) => JLSTZ_12,
            (2, 1) => JLSTZ_21,
            (2, 3) => JLSTZ_23,
            (3, 2) => JLSTZ_32,
            (3, 0) => JLSTZ_30,
            (0, 3) => JLSTZ_03,
            _ => NO_KICK,
        }
    };
    table
}

pub fn as_rotation(n: i32) -> usize {
    (((n % 4) + 4) % 4) as usize
}

fn shape_height(kind: PieceKind, rotation: i32) -> i32 {
    let mut max_y = 0;
    for cell in cells_for(kind, rotation) {
        if cell.y > max_y {
            max_y = cell.y;
        }
    }
    max_y
}

/// v2 spawn search row: `20 - shapeHeight(kind, 0)`.
fn spawn_search_y(kind: PieceKind) -> i32 {
    20 - shape_height(kind, 0)
}

/// Canonical cell-set key used to dedup kick landings against hard drops.
fn placement_key(cells: &[Cell; 4], px: i32, y: i32) -> Vec<(i32, i32)> {
    let mut pts: Vec<(i32, i32)> = cells.iter().map(|c| (px + c.x, y + c.y)).collect();
    pts.sort_unstable();
    pts
}

struct State {
    rot: i32,
    px: i32,
    y: i32,
    srs_kick_index: usize,
}

/// BFS over reachable placements from the spawn state for one target rotation.
/// Returns `(px, y, srs_kick_index)` in discovery order.
fn reachable_landings(
    board: &Board,
    kind: PieceKind,
    target_rot: i32,
    start_y: i32,
) -> Vec<(i32, i32, usize)> {
    let mut out = Vec::new();
    if collides(board, &bottom_cells(kind, 0), 3, start_y) {
        return out;
    }
    let mut seen: HashSet<(i32, i32, i32)> = HashSet::new();
    let mut queue: Vec<State> = vec![State {
        rot: 0,
        px: 3,
        y: start_y,
        srs_kick_index: 0,
    }];
    seen.insert((0, 3, start_y));
    let mut head = 0usize;
    let mut guard = 40000i32;
    while head < queue.len() {
        let cur_rot = queue[head].rot;
        let cur_px = queue[head].px;
        let cur_y = queue[head].y;
        let cur_srs = queue[head].srs_kick_index;
        head += 1;
        guard -= 1;
        if guard <= 0 {
            break;
        }
        let cur_cells = bottom_cells(kind, cur_rot);
        if cur_rot == target_rot && collides(board, &cur_cells, cur_px, cur_y - 1) {
            out.push((cur_px, cur_y, cur_srs));
        }

        // left, right
        for dx in [-1i32, 1i32] {
            let rot = cur_rot;
            let px = cur_px + dx;
            let y = cur_y;
            let key = (rot, px, y);
            if seen.contains(&key) {
                continue;
            }
            if collides(board, &bottom_cells(kind, rot), px, y) {
                continue;
            }
            seen.insert(key);
            queue.push(State {
                rot,
                px,
                y,
                srs_kick_index: 0,
            });
        }

        // soft drop
        let down_key = (cur_rot, cur_px, cur_y - 1);
        if !seen.contains(&down_key)
            && !collides(board, &bottom_cells(kind, cur_rot), cur_px, cur_y - 1)
        {
            seen.insert(down_key);
            queue.push(State {
                rot: cur_rot,
                px: cur_px,
                y: cur_y - 1,
                srs_kick_index: 0,
            });
        }

        // rotations (CW then CCW)
        for dir in [1i32, -1i32] {
            let from = as_rotation(cur_rot);
            let to = as_rotation(cur_rot + dir);
            let kicks = kick_table(kind, from, to);
            let mut found: Option<(usize, i32, i32)> = None;
            for (i, k) in kicks.iter().enumerate() {
                let nx = cur_px + k.dx;
                let ny = cur_y + k.dy + shape_height(kind, cur_rot) - shape_height(kind, to as i32);
                if !collides(board, &bottom_cells(kind, to as i32), nx, ny) {
                    found = Some((i, nx, ny));
                    break;
                }
            }
            if let Some((kick_index, nx, ny)) = found {
                let key = (to as i32, nx, ny);
                if !seen.contains(&key) {
                    seen.insert(key);
                    queue.push(State {
                        rot: to as i32,
                        px: nx,
                        y: ny,
                        srs_kick_index: kick_index,
                    });
                }
            }
        }
    }
    out
}

/// Port of `enumerateKickPlacements`: hard drops plus every SRS-reachable
/// landing not already covered by a hard drop. All placements are flat-scored
/// (the v2 generator re-scores every placement from scratch).
pub fn enumerate_kick_placements(
    board: &Board,
    kind: PieceKind,
    weights: &Weights,
) -> Vec<ScoredPlacement> {
    let mut out = enumerate_scored_flat(board, kind, weights);

    let mut hard: HashSet<Vec<(i32, i32)>> = HashSet::new();
    for p in &out {
        let cells = bottom_cells(kind, p.rotation);
        hard.insert(placement_key(&cells, p.x, p.y));
    }

    let rots = rotation_count(kind);
    let start_y = spawn_search_y(kind);
    for r in 0..rots {
        let cells = bottom_cells(kind, r as i32);
        for (px, y, srs_kick_index) in reachable_landings(board, kind, r as i32, start_y) {
            let key = placement_key(&cells, px, y);
            if hard.contains(&key) {
                continue;
            }
            push_placement(
                &mut out,
                board,
                &cells,
                r as i32,
                px,
                y,
                weights,
                true,
                Some(srs_kick_index),
                true,
            );
        }
    }
    out
}

/// `restY` for a hard-drop column; only used internally by the hard-drop key.
#[allow(dead_code)]
fn rest_y(board: &Board, cells: &[Cell; 4], px: i32) -> i32 {
    let start_y = board.len() as i32 + 4;
    if collides(board, cells, px, start_y) {
        return start_y;
    }
    drop_y(board, cells, px, start_y)
}

#[cfg(test)]
mod tests {
    use super::{enumerate_kick_placements, kick_table};
    use crate::board::{Board, ROWS, collides};
    use crate::pieces::{PieceKind, bottom_cells};
    use crate::search::enumerate_scored_flat;
    use crate::weights::DEEPSEEK_V2_WEIGHTS;

    #[test]
    fn empty_board_adds_no_kicks_beyond_hard_drops() {
        let board: Board = [0; ROWS];
        let hard = enumerate_scored_flat(&board, PieceKind::T, &DEEPSEEK_V2_WEIGHTS);
        let kicked = enumerate_kick_placements(&board, PieceKind::T, &DEEPSEEK_V2_WEIGHTS);
        assert_eq!(hard.len(), kicked.len());
        assert!(kicked.iter().all(|p| !p.via_kick));
    }

    #[test]
    fn overhangs_produce_kicks_and_every_landing_is_legal() {
        let mut seed: u32 = 0x1234_5678;
        let mut next = move || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            seed
        };
        let mut found: Option<Board> = None;
        for _ in 0..200 {
            let mut board: Board = [0; ROWS];
            for x in 0..10usize {
                let h = (next() % 12) as usize;
                for y in 0..h {
                    if next() % 100 < 80 {
                        board[y] |= 1u16 << x;
                    }
                }
            }
            let has_kick = [
                PieceKind::T,
                PieceKind::S,
                PieceKind::Z,
                PieceKind::J,
                PieceKind::L,
                PieceKind::I,
            ]
            .iter()
            .any(|&kind| {
                enumerate_kick_placements(&board, kind, &DEEPSEEK_V2_WEIGHTS)
                    .iter()
                    .any(|p| p.via_kick)
            });
            if has_kick {
                found = Some(board);
                break;
            }
        }
        let board = found.expect("a random overhang stack should admit at least one kick");
        for kind in [PieceKind::T, PieceKind::S, PieceKind::Z, PieceKind::J, PieceKind::L] {
            for p in enumerate_kick_placements(&board, kind, &DEEPSEEK_V2_WEIGHTS) {
                assert!(!collides(
                    &board,
                    &bottom_cells(kind, p.rotation),
                    p.x,
                    p.y
                ));
            }
        }
    }

    #[test]
    fn kick_tables_match_ts_geometry() {
        let kicks = kick_table(PieceKind::I, 0, 1);
        assert_eq!((kicks[0].dx, kicks[0].dy), (0, 0));
        assert_eq!((kicks[1].dx, kicks[1].dy), (-2, 0));
        assert_eq!(kick_table(PieceKind::O, 0, 1).len(), 1);
    }
}

