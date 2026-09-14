//! Faithful Hoiko VS weight list, mirroring `src/ai/hoiko-weights.ts`.
//!
//! The tables are generated from the TS source by
//! `tools/native-app/dump-rust-presets.ts` and asserted against
//! `evidence/native-app/hoiko-weights.json` in `tests/presets.rs`.

mod presets_data;

use game::contract::WeightPreset;
use hoiko_core::HoikoWeights;

pub use presets_data::{SPRINT_WEIGHTS, ULTRA2_WEIGHTS, VS_WEIGHT_LIST};

/// Native `weightList[4]` size (`hoiko-rust-core.ts` `MAX_WEIGHTS`).
pub const MAX_WEIGHTS: usize = 4;

/// `src/ai/hoiko-weights.ts` `hoikoWeightList`: the four-entry VS list and the
/// duplicated two-entry solo lists. Unused slots stay zeroed, exactly like the
/// TS host writes them (`weights[k]?.weight ?? zeros`).
pub fn weight_list(preset: WeightPreset) -> [HoikoWeights; MAX_WEIGHTS] {
    let mut list = [HoikoWeights::default(); MAX_WEIGHTS];
    match preset {
        WeightPreset::We | WeightPreset::Wo | WeightPreset::Wd | WeightPreset::Wr => {
            list.copy_from_slice(&VS_WEIGHT_LIST);
        }
        WeightPreset::Ultra2 | WeightPreset::Sprint => {
            let solo = if preset == WeightPreset::Ultra2 {
                ULTRA2_WEIGHTS
            } else {
                SPRINT_WEIGHTS
            };
            list[0] = solo;
            list[1] = solo;
        }
    }
    list
}
