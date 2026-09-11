//! Differential-test probe API: a tiny, serializable surface over the engine so
//! a host (Bun) can feed identical inputs to the TS reference and this crate.

use std::cell::RefCell;
use std::rc::Rc;

use crate::board::{Board, BOARD_HEIGHT};
use crate::evaluate::{evaluate, evaluate_first};
use crate::expand::expand_node;
use crate::gamepack::GamePack;
use crate::nextmino::NextMino;
use crate::shapes::{MinoType, ACT_NONE};
use crate::weights::HoikoWeights;

pub struct ProbeInput {
    pub board: Vec<i32>,
    pub current: MinoType,
    pub queue: Vec<MinoType>,
    pub hold: MinoType,
    pub combo: i32,
    pub btb: i32,
    pub view_next: i32,
    pub weight_index: i32,
    pub is_even: bool,
    pub use_s4w: bool,
    pub trust_rate: f64,
}

#[derive(Clone, Copy)]
pub struct ProbeEval {
    pub family_score: i32,
    pub score: i32,
    pub first_family_score: i32,
    pub first_score: i32,
}

pub struct ProbeChild {
    pub placed_x: i32,
    pub placed_r: i32,
    pub placed_m: MinoType,
    pub act: i32,
    pub stack_height: i32,
    pub board: [i32; BOARD_HEIGHT],
}

pub struct ProbeExpand {
    pub count: usize,
    pub hold_used: usize,
    pub children: Vec<ProbeChild>,
}

/// Mirrors `buildRoot(input, viewNext, feedQueue=false)` from `native/index.ts`.
pub fn build_root(input: &ProbeInput) -> GamePack {
    let next = Rc::new(RefCell::new(NextMino::default()));
    next.borrow_mut().view_next = input.view_next;
    let mut real_next = Vec::with_capacity(input.queue.len() + 1);
    real_next.push(input.current);
    real_next.extend_from_slice(&input.queue);

    let mut g = GamePack::default();
    g.board = Board::default();
    for (y, row) in input.board.iter().enumerate().take(BOARD_HEIGHT) {
        g.board.line[y] = *row;
    }
    g.board.update_max_height();
    g.hold.init();
    g.hold.m = input.hold;
    g.commands.init();
    g.combo = input.combo;
    g.btb = input.btb;
    g.act = ACT_NONE;
    g.falling_mino.init();
    g.locked_mino.init();
    next.borrow_mut().init(&real_next);
    g.set_new_current(&next);
    g
}

pub fn evaluate_probe(input: &ProbeInput, ew: &HoikoWeights) -> ProbeEval {
    let g = build_root(input);
    let e = evaluate(&g, ew, input.weight_index, input.is_even, input.use_s4w, input.trust_rate);
    let f = evaluate_first(&g, ew, input.weight_index, input.is_even);
    ProbeEval {
        family_score: e.family_score,
        score: e.score,
        first_family_score: f.family_score,
        first_score: f.score,
    }
}

pub fn expand_probe(input: &ProbeInput, allow_hold: bool) -> ProbeExpand {
    let g = build_root(input);
    let children = expand_node(&g, allow_hold);
    let hold_used = children.iter().filter(|c| c.hold_used).count();
    let children: Vec<ProbeChild> = children
        .into_iter()
        .map(|c| ProbeChild {
            placed_x: c.placed_x,
            placed_r: c.placed_r,
            placed_m: c.placed_m,
            act: c.act,
            stack_height: c.game.board.stack_height,
            board: c.game.board.line,
        })
        .collect();
    ProbeExpand { count: children.len(), hold_used, children }
}
