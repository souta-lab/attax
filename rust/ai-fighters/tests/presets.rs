//! Preset differential: the embedded Rust weight tables must match the TS
//! `hoikoWeightList` fixture field for field.
//!
//! `hoiko_core::HoikoWeights` intentionally derives neither `PartialEq` nor
//! `Debug` (the engine crate is not to be changed), so comparisons go through
//! [`same`] and report by formatted value.

use ai_fighters::presets::{VS_WEIGHT_LIST, weight_list};
use game::contract::WeightPreset;
use hoiko_core::HoikoWeights;
use serde_json::Value;
use std::path::PathBuf;

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("evidence")
        .join("native-app")
        .join("hoiko-weights.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

fn read_weights(value: &Value) -> HoikoWeights {
    let ints = |key: &str| -> Vec<i32> {
        value[key]
            .as_array()
            .unwrap_or_else(|| panic!("{key} array"))
            .iter()
            .map(|v| v.as_i64().unwrap_or_else(|| panic!("{key} int")) as i32)
            .collect()
    };
    let mut entry = HoikoWeights::default();
    entry.weight.copy_from_slice(&ints("weight"));
    entry.column.copy_from_slice(&ints("column"));
    entry.combo_table.copy_from_slice(&ints("comboTable"));
    entry.nexus = value["nexus"].as_f64().unwrap_or_else(|| panic!("nexus"));
    entry
}

fn same(left: &HoikoWeights, right: &HoikoWeights) -> bool {
    left.weight == right.weight
        && left.column == right.column
        && left.combo_table == right.combo_table
        && left.nexus == right.nexus
}

fn show(value: &HoikoWeights) -> String {
    format!(
        "weight={:?} column={:?} combo={:?} nexus={}",
        value.weight, value.column, value.combo_table, value.nexus
    )
}

#[test]
fn embedded_vs_weight_list_matches_the_ts_fixture() {
    let fixture = fixture();
    let expected = fixture["weightList"].as_array().unwrap();
    assert_eq!(expected.len(), VS_WEIGHT_LIST.len(), "weight list length");
    for (index, value) in expected.iter().enumerate() {
        let expected = read_weights(value);
        assert!(
            same(&VS_WEIGHT_LIST[index], &expected),
            "entry {index}:\n rust: {}\n ts:   {}",
            show(&VS_WEIGHT_LIST[index]),
            show(&expected)
        );
    }
}

#[test]
fn every_vs_preset_resolves_to_the_same_four_entry_list() {
    for preset in [
        WeightPreset::We,
        WeightPreset::Wo,
        WeightPreset::Wd,
        WeightPreset::Wr,
    ] {
        let list = weight_list(preset);
        for (index, entry) in list.iter().enumerate() {
            assert!(
                same(entry, &VS_WEIGHT_LIST[index]),
                "{preset:?} entry {index}: {}",
                show(entry)
            );
        }
    }
}

#[test]
fn solo_presets_duplicate_their_single_table_and_zero_the_rest() {
    for preset in [WeightPreset::Ultra2, WeightPreset::Sprint] {
        let list = weight_list(preset);
        assert!(same(&list[0], &list[1]), "{preset:?}: first two entries");
        assert!(
            same(&list[2], &HoikoWeights::default()),
            "{preset:?}: third entry"
        );
        assert!(
            same(&list[3], &HoikoWeights::default()),
            "{preset:?}: fourth entry"
        );
        assert!(
            !same(&list[0], &HoikoWeights::default()),
            "{preset:?}: solo table is empty"
        );
    }
    assert!(
        !same(
            &weight_list(WeightPreset::Ultra2)[0],
            &weight_list(WeightPreset::Sprint)[0]
        ),
        "solo presets must differ"
    );
}
