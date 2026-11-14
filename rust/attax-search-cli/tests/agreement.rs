//! Frozen TS outputs from recorded 40-row, guideline, width-96 boards.
#[test]
fn recorded_ts_search_agreement() {
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_attax-agree"))
        .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/recorded.jsonl"))
        .output()
        .expect("run agreement CLI");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
