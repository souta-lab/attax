//! EvaluateAI `W` enum indices — faithful port of `src/ai/native/weight-index.ts`.
//! Weight scalars arrive as `[i32; 50]`, per-column as `[i32; 10]`, the combo
//! table as `[i32; 5]`, and `nexus` as `f64`.

use crate::weights::HoikoWeights;

pub const WI_MAX_HEIGHT: usize = 0;
pub const WI_OVER10: usize = 1;
pub const WI_OVER15: usize = 2;
pub const WI_UPDOWN2: usize = 3;
pub const WI_DONATE_COVER: usize = 4;
pub const WI_COVER: usize = 5;
pub const WI_ROOF: usize = 6;
pub const WI_BAD_ROOF: usize = 7;
pub const WI_PIERCE: usize = 8;
pub const WI_ANABARA: usize = 9;
pub const WI_WELL_HINT: usize = 10;
pub const WI_WELL_DEPTH: usize = 11;
pub const WI_WELL_PEAK: usize = 12;
pub const WI_COLUMN: usize = 13;
pub const WI_PC_STACK: usize = 14;
pub const WI_PC_CHANCE: usize = 15;
pub const WI_RESOURCE: usize = 16;
pub const WI_RESOURCE_MAX: usize = 17;
pub const WI_TSD_HOLE: usize = 18;
pub const WI_TSD_SPINABLE: usize = 19;
pub const WI_TSD_CLEARABLE: usize = 20;
pub const WI_TSD_OFFENSIVE: usize = 21;
pub const WI_TST_HOLE: usize = 22;
pub const WI_TST_SPINABLE: usize = 23;
pub const WI_TST_CLEARABLE: usize = 24;
pub const WI_TST_HINT: usize = 25;
pub const WI_TST_OFFENSIVE: usize = 26;
pub const WI_TD_HOLE: usize = 27;
pub const WI_TD_HINT: usize = 28;
pub const WI_MOVE_DELAY: usize = 29;
pub const WI_HOLD_I: usize = 30;
pub const WI_HOLD_T: usize = 31;
pub const WI_WASTE_I: usize = 32;
pub const WI_WASTE_T: usize = 33;
pub const WI_SINGLE: usize = 34;
pub const WI_DOUBLE: usize = 35;
pub const WI_TRIPLE: usize = 36;
pub const WI_QUAD: usize = 37;
pub const WI_TSS: usize = 38;
pub const WI_TSD: usize = 39;
pub const WI_TST: usize = 40;
pub const WI_BTB: usize = 41;
pub const WI_PC: usize = 42;
pub const WI_COMBO_BTB: usize = 43;
pub const WI_COMBO_ATK: usize = 44;
pub const WI_COMBO_DEBT: usize = 45;
pub const WI_NEXUS: usize = 46;

#[inline]
pub fn weight_at(ew: &HoikoWeights, i: usize) -> i32 {
    ew.weight.get(i).copied().unwrap_or(0)
}

#[inline]
pub fn column_at(ew: &HoikoWeights, x: usize) -> i32 {
    ew.column.get(x).copied().unwrap_or(0)
}

#[inline]
pub fn combo_at(ew: &HoikoWeights, r: usize) -> i32 {
    ew.combo_table.get(r).copied().unwrap_or(0)
}
