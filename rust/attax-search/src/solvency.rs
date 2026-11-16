//! C2 — geometry-aware solvency for the S2 search (canonical design §C2), a port of
//! src/ai/bot/solvency.ts. See that file for the design: a smooth lower-tail penalty
//! plus a certain-death demotion, priced on the real post-lock state at every layer.

/// `SolvencyParams` from solvency.ts.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SolvencyParams {
    /// Points per squared row of margin shortfall below `margin_band`.
    pub coefficient: f64,
    /// Margin (rows below the visible-field top) at or above which no penalty applies.
    pub margin_band: f64,
    /// Finite demotion for nodes the next tank kills outright.
    pub doomed_penalty: f64,
}

impl Default for SolvencyParams {
    fn default() -> Self {
        SolvencyParams { coefficient: 40.0, margin_band: 6.0, doomed_penalty: 1_000_000.0 }
    }
}

/// Worst margin over the next-lock pressure step: visibleRows − height − pending
/// (`solvencyMargin` in solvency.ts; also the champion's root-veto arithmetic).
pub fn solvency_margin(max_height: i32, pending: i32, visible_rows: i32) -> i32 {
    visible_rows - max_height - pending
}

/// The penalty of a post-lock state (`assessSolvency(...).penalty` in solvency.ts).
pub fn solvency_penalty(max_height: i32, pending: i32, params: &SolvencyParams, visible_rows: i32) -> f64 {
    let margin = solvency_margin(max_height, pending, visible_rows);
    let doomed = margin < 0;
    let shortfall = (params.margin_band - margin as f64).max(0.0);
    params.coefficient * shortfall * shortfall + if doomed { params.doomed_penalty } else { 0.0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn margin_and_penalty_match_the_ts_formulas() {
        let p = SolvencyParams::default();
        assert_eq!(solvency_margin(10, 3, 20), 7);
        assert_eq!(solvency_penalty(10, 3, &p, 20), 0.0);
        // Margin 4 is 2 rows into the band: 40 * 2^2.
        assert_eq!(solvency_penalty(13, 3, &p, 20), 160.0);
        // Negative margin is doomed on top of the shortfall.
        assert_eq!(solvency_penalty(19, 3, &p, 20), 40.0 * 64.0 + 1_000_000.0);
    }
}
