use crate::features::{FeatureVector, FireFeatures};

#[derive(Clone, Copy, Debug)]
pub struct Weights {
    pub landing_height: f64,
    pub eroded_cells: f64,
    pub row_transitions: f64,
    pub col_transitions: f64,
    pub holes: f64,
    pub wells: f64,
    pub hole_depth: f64,
    pub rows_with_holes: f64,
    pub bumpiness: f64,
    pub max_height: f64,
    pub lines_cleared: f64,
}

#[derive(Clone, Copy, Debug)]
pub struct FireWeights {
    pub tetris: f64,
    pub tspin: f64,
    pub tspin_single: f64,
    pub tspin_double: f64,
    pub tspin_triple: f64,
    pub b2b_bonus: f64,
    pub combo_step: f64,
    pub perfect_clear: f64,
    pub well_step: Option<f64>,
    pub tslot_step: Option<f64>,
}

pub const DU_WEIGHTS: Weights = Weights {
    landing_height: -4.5,
    eroded_cells: 3.4,
    row_transitions: -3.2,
    col_transitions: -9.35,
    holes: -13.0,
    wells: -10.0,
    hole_depth: -2.0,
    rows_with_holes: -24.0,
    bumpiness: -1.5,
    max_height: -3.0,
    lines_cleared: 200.0,
};

pub const DEEPSEEK_WEIGHTS: Weights = Weights {
    landing_height: -4.5,
    eroded_cells: 3.4,
    row_transitions: -3.2,
    col_transitions: -9.35,
    holes: -14.5,
    wells: -11.0,
    hole_depth: -2.0,
    rows_with_holes: -26.0,
    bumpiness: -1.5,
    max_height: -3.6,
    lines_cleared: 200.0,
};

pub const FIRE_WEIGHTS: FireWeights = FireWeights {
    tetris: 390.0,
    tspin: 121.0,
    tspin_single: 0.0,
    tspin_double: 289.0,
    tspin_triple: 481.0,
    b2b_bonus: 104.0,
    combo_step: 150.0,
    perfect_clear: 999.0,
    well_step: None,
    tslot_step: None,
};

pub const DEEPSEEK_FIRE: FireWeights = FireWeights {
    well_step: Some(7.0),
    tslot_step: Some(42.0),
    ..FIRE_WEIGHTS
};

/// DeepSeek v2 weights: `{ ...DU_WEIGHTS, holes: -15, wells: -11,
/// rowsWithHoles: -27, maxHeight: -3.8 }`.
pub const DEEPSEEK_V2_WEIGHTS: Weights = Weights {
    landing_height: -4.5,
    eroded_cells: 3.4,
    row_transitions: -3.2,
    col_transitions: -9.35,
    holes: -15.0,
    wells: -11.0,
    hole_depth: -2.0,
    rows_with_holes: -27.0,
    bumpiness: -1.5,
    max_height: -3.8,
    lines_cleared: 200.0,
};

pub const DEEPSEEK_V2_FIRE: FireWeights = FireWeights {
    well_step: Some(7.0),
    tslot_step: Some(42.0),
    ..FIRE_WEIGHTS
};

pub fn score_features(f: &FeatureVector, w: &Weights) -> f64 {
    f.landing_height * w.landing_height
        + f.eroded_cells * w.eroded_cells
        + f.row_transitions * w.row_transitions
        + f.col_transitions * w.col_transitions
        + f.holes * w.holes
        + f.wells * w.wells
        + f.hole_depth * w.hole_depth
        + f.rows_with_holes * w.rows_with_holes
        + f.bumpiness * w.bumpiness
        + f.max_height * w.max_height
}

pub fn score_placement(f: &FeatureVector, lines_cleared: u32, w: &Weights) -> f64 {
    score_features(f, w) + lines_cleared as f64 * w.lines_cleared
}

pub fn score_fire(f: &FireFeatures, w: &FireWeights) -> f64 {
    (if f.is_tetris { w.tetris } else { 0.0 })
        + (if f.is_tspin { w.tspin } else { 0.0 })
        + (if f.is_tspin_single { w.tspin_single } else { 0.0 })
        + (if f.is_tspin_double { w.tspin_double } else { 0.0 })
        + (if f.is_tspin_triple { w.tspin_triple } else { 0.0 })
        + (if f.b2b_bonus { w.b2b_bonus } else { 0.0 })
        + f.combo_count as f64 * w.combo_step
        + (if f.is_perfect_clear { w.perfect_clear } else { 0.0 })
}
