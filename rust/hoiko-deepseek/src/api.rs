use crate::beam::{BeamOptions, DEFAULT_TOP_K, DEFAULT_WIDTH, beam_best_move};
use crate::board::{Board, is_empty};
use crate::evaluation::DefaultEvaluation;
use crate::pieces::PieceKind;
use crate::scorer::{DeepSeekAdjust, DeepSeekEvaluation, DeepSeekScorer, DeepSeekVeto};
use crate::weights::{DEEPSEEK_FIRE, DEEPSEEK_WEIGHTS, DU_WEIGHTS, FIRE_WEIGHTS};

pub const SEARCH_DEPTH: usize = 6;

pub struct BestMoveInput<'a> {
    pub board: &'a Board,
    pub active: PieceKind,
    pub next: &'a [PieceKind],
    pub hold: Option<PieceKind>,
    pub can_hold: bool,
    pub b2b: bool,
    pub combo: i32,
    pub pending_garbage: i32,
    pub pieces: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Move {
    pub x: i32,
    pub rotation: i32,
    pub use_hold: bool,
}

pub fn best_move(input: &BestMoveInput) -> Option<Move> {
    let queue: Vec<PieceKind> = input.next.iter().take(SEARCH_DEPTH).copied().collect();
    if is_empty(input.board) {
        let evaluation = DefaultEvaluation;
        let options = BeamOptions {
            weights: &DU_WEIGHTS,
            fire: &FIRE_WEIGHTS,
            width: DEFAULT_WIDTH,
            depth: SEARCH_DEPTH,
            top_k: DEFAULT_TOP_K,
            use_hold: true,
            pending: input.pending_garbage,
            evaluation: &evaluation,
        };
        let (rotation, x, use_hold) = beam_best_move(
            input.board,
            input.active,
            &queue,
            input.hold,
            input.can_hold,
            input.b2b,
            input.combo,
            &options,
        )?;
        return Some(Move {
            x,
            rotation,
            use_hold,
        });
    }

    let scorer = DeepSeekScorer::new(input.hold, input.can_hold, &queue, input.pieces);
    let adjust = DeepSeekAdjust::new(input.pieces);
    let veto = DeepSeekVeto::new(input.pending_garbage);
    let evaluation = DeepSeekEvaluation {
        scorer: &scorer,
        adjust: &adjust,
        veto: &veto,
    };
    let options = BeamOptions {
        weights: &DEEPSEEK_WEIGHTS,
        fire: &DEEPSEEK_FIRE,
        width: DEFAULT_WIDTH,
        depth: SEARCH_DEPTH,
        top_k: DEFAULT_TOP_K,
        use_hold: true,
        pending: input.pending_garbage,
        evaluation: &evaluation,
    };
    let (rotation, x, use_hold) = beam_best_move(
        input.board,
        input.active,
        &queue,
        input.hold,
        input.can_hold,
        input.b2b,
        input.combo,
        &options,
    )?;
    Some(Move {
        x,
        rotation,
        use_hold,
    })
}
