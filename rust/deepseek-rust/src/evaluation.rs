use crate::board::Board;
use crate::pieces::PieceKind;
use crate::search::ScoredPlacement;
use crate::tspin::TspinKind;
use crate::weights::{FireWeights, Weights};

#[derive(Clone, Copy)]
pub struct PlyContext<'a> {
    pub ply: i32,
    pub combo: i32,
    pub b2b: bool,
    pub pending: i32,
    pub pending_after: i32,
    pub weights: &'a Weights,
    pub fire: &'a FireWeights,
    pub piece: Option<PieceKind>,
    pub hold: Option<PieceKind>,
    pub next_piece: Option<PieceKind>,
    /// `src/ai/evaluation.ts` `tspinKind`: the engine's T-spin verdict for
    /// the placement (`classify_placement`), used for attack/B2B prediction
    /// (issue #27). The `tspin` scorer argument stays the shape heuristic.
    pub tspin_kind: TspinKind,
}

pub trait Evaluation {
    fn rank(&self, placement: &ScoredPlacement, piece: PieceKind, tspin: bool, ctx: &PlyContext) -> f64;
    fn score(&self, after: &Board, lines: u32, tspin: bool, ctx: &PlyContext) -> f64;
    fn veto(&self, after: &Board, lines: u32, tspin: bool) -> bool;
}

pub struct DefaultEvaluation;

impl Evaluation for DefaultEvaluation {
    fn rank(
        &self,
        placement: &ScoredPlacement,
        _piece: PieceKind,
        _tspin: bool,
        _ctx: &PlyContext,
    ) -> f64 {
        placement.score
    }

    fn score(&self, _after: &Board, _lines: u32, _tspin: bool, _ctx: &PlyContext) -> f64 {
        0.0
    }

    fn veto(&self, _after: &Board, _lines: u32, _tspin: bool) -> bool {
        false
    }
}
