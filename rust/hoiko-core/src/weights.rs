//! EvaluateAI weight struct — mirrors `EvaluateAI::EvalWeight`.

#[derive(Clone, Copy)]
pub struct HoikoWeights {
    pub weight: [i32; 50],
    pub column: [i32; 10],
    pub combo_table: [i32; 5],
    pub nexus: f64,
}

impl Default for HoikoWeights {
    fn default() -> Self {
        Self { weight: [0; 50], column: [0; 10], combo_table: [0; 5], nexus: 0.0 }
    }
}
