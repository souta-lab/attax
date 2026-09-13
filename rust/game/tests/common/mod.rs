//! Shared helpers for the differential replay tests.

#![allow(dead_code)]

use serde_json::Value;
use std::path::PathBuf;

pub fn fixture(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("evidence")
        .join("native-app")
        .join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

pub fn int(value: &Value) -> i32 {
    value
        .as_i64()
        .unwrap_or_else(|| panic!("expected integer, got {value}")) as i32
}

pub fn flag(value: &Value) -> bool {
    value
        .as_bool()
        .unwrap_or_else(|| panic!("expected bool, got {value}"))
}

pub fn opt_str(value: &Value) -> Option<String> {
    value.as_str().map(str::to_string)
}
