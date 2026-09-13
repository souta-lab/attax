//! Contract differential: replays the TS-recorded `NextState` sequences,
//! opponent-flag corpus, faithful config resolutions and bridge helpers from
//! `evidence/native-app/contract.json`.

mod common;

use game::contract::{
    board_to_native_rows, frame_step_ms, native_stack_height, opponent_is_pc_board,
    opponent_is_powerful_board, resolve_faithful_hoiko_options, EvenMode, FaithfulHoikoEnv,
    NextState, WeightPreset, FAITHFUL_HOIKO,
};
use game::types::{BoardView, COLS, ROWS};
use serde_json::Value;

fn env_str<'a>(env: &'a Value, key: &str) -> Option<&'a str> {
    env.get(key).and_then(Value::as_str)
}

#[test]
fn next_state_differential_matches_recorded_sequences() {
    let fixture = common::fixture("contract.json");
    for case in fixture["nextStates"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let view_next = common::int(&case["viewNext"]);
        let init: Vec<i32> = case["init"]
            .as_array()
            .unwrap()
            .iter()
            .map(common::int)
            .collect();
        let mut state = NextState::new(view_next);
        state.init(&init);
        for op in case["ops"].as_array().unwrap() {
            match op["kind"].as_str().unwrap() {
                "shiftNext" => state.shift_next(),
                "compare" => {
                    let nx: Vec<i32> = op["nx"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(common::int)
                        .collect();
                    state.compare(common::int(&op["first"]), &nx);
                }
                other => panic!("{name}: unknown next op {other}"),
            }
        }
        let expected_m: Vec<i32> = case["m"]
            .as_array()
            .unwrap()
            .iter()
            .map(common::int)
            .collect();
        assert_eq!(state.m.to_vec(), expected_m, "{name}: m");
        assert_eq!(
            state.trust_end,
            common::int(&case["trustEnd"]),
            "{name}: trustEnd"
        );
        assert_eq!(
            state.bag_remains,
            common::int(&case["bagRemains"]),
            "{name}: bagRemains"
        );
    }
    for case in fixture["trustRange"].as_array().unwrap() {
        assert_eq!(
            game::contract::trust_range(common::int(&case["remains"])),
            common::int(&case["range"])
        );
    }
}

#[test]
fn opponent_flag_differential_matches_the_recorded_corpus() {
    let fixture = common::fixture("contract.json");
    for case in fixture["opponentCases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let rows: Vec<i32> = case["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(common::int)
            .collect();
        let combo = common::int(&case["combo"]);
        let garbage = common::int(&case["garbage"]);
        assert_eq!(
            opponent_is_pc_board(&rows),
            common::flag(&case["pc"]),
            "{name}: pc"
        );
        assert_eq!(
            opponent_is_powerful_board(&rows, combo, garbage),
            common::flag(&case["powerful"]),
            "{name}: powerful"
        );
        assert_eq!(
            native_stack_height(&rows),
            if rows.is_empty() {
                -1
            } else {
                rows.iter().rposition(|&row| row != 0)
                    .map(|y| y as i32)
                    .unwrap_or(-1)
            },
            "{name}: stack height"
        );
    }
}

#[test]
fn faithful_config_differential_matches_the_recorded_env_resolutions() {
    let fixture = common::fixture("contract.json");
    let constant = &fixture["faithful"]["constant"];
    assert_eq!(
        FAITHFUL_HOIKO.weight_preset.as_str(),
        constant["weightPreset"].as_str().unwrap()
    );
    assert_eq!(
        FAITHFUL_HOIKO.beam_size_limit,
        common::int(&constant["beamSizeLimit"])
    );
    assert_eq!(FAITHFUL_HOIKO.max_beam_size, common::int(&constant["maxBeamSize"]));
    assert_eq!(FAITHFUL_HOIKO.adapt, common::flag(&constant["adapt"]));
    assert_eq!(FAITHFUL_HOIKO.depth_limit, common::int(&constant["depthLimit"]));
    assert_eq!(FAITHFUL_HOIKO.view_next, common::int(&constant["viewNext"]));

    for case in fixture["faithful"]["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let env_json = &case["env"];
        let env = FaithfulHoikoEnv {
            hoiko_beam: env_str(env_json, "HOIKO_BEAM"),
            hoiko_adapt: env_str(env_json, "HOIKO_ADAPT"),
            hoiko_offset: env_str(env_json, "HOIKO_OFFSET"),
            hoiko_frames: env_str(env_json, "HOIKO_FRAMES"),
            hoiko_nextcarry: env_str(env_json, "HOIKO_NEXTCARRY"),
            hoiko_even: env_str(env_json, "HOIKO_EVEN"),
        };
        let preset = WeightPreset::parse(case["preset"].as_str().unwrap()).unwrap();
        let options = resolve_faithful_hoiko_options(&env, preset)
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        let expected = &case["options"];
        assert_eq!(
            options.weight_preset.as_str(),
            expected["weightPreset"].as_str().unwrap(),
            "{name}: preset"
        );
        assert_eq!(
            options.beam_size_limit,
            common::int(&expected["beamSizeLimit"]),
            "{name}: beam"
        );
        assert_eq!(
            options.max_beam_size,
            common::int(&expected["maxBeamSize"]),
            "{name}: maxBeam"
        );
        assert_eq!(options.adapt, common::flag(&expected["adapt"]), "{name}: adapt");
        assert_eq!(
            options.depth_limit,
            common::int(&expected["depthLimit"]),
            "{name}: depth"
        );
        assert_eq!(
            options.view_next,
            common::int(&expected["viewNext"]),
            "{name}: viewNext"
        );
        assert_eq!(options.versus, common::flag(&expected["versus"]), "{name}: versus");
        assert_eq!(
            options.offset,
            expected.get("offset").and_then(Value::as_bool),
            "{name}: offset"
        );
        assert_eq!(
            options.frames_per_think,
            expected.get("framesPerThink").and_then(Value::as_i64).map(|v| v as i32),
            "{name}: framesPerThink"
        );
        assert_eq!(
            options.next_carry,
            expected.get("nextCarry").and_then(Value::as_bool),
            "{name}: nextCarry"
        );
        let even = expected.get("evenMode").and_then(Value::as_str).map(|value| match value {
            "auto" => EvenMode::Auto,
            "true" => EvenMode::True,
            "false" => EvenMode::False,
            other => panic!("{name}: unknown evenMode {other}"),
        });
        assert_eq!(options.even_mode, even, "{name}: evenMode");
    }
}

#[test]
fn bridge_helpers_differential_matches_recorded_values() {
    let fixture = common::fixture("contract.json");
    for case in fixture["bridge"]["frameSteps"].as_array().unwrap() {
        assert_eq!(
            frame_step_ms(common::int(&case["frames"])),
            case["ms"].as_f64().unwrap()
        );
    }
    for case in fixture["bridge"]["boardToNative"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let native_rows: Vec<i32> = case["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(common::int)
            .collect();
        let expected: Vec<i32> = case["native"]
            .as_array()
            .unwrap()
            .iter()
            .map(common::int)
            .collect();
        let mut grid = [[0u8; COLS]; ROWS];
        for (y, native) in native_rows.iter().enumerate().take(ROWS) {
            let row = &mut grid[ROWS - 1 - y];
            for x in 0..COLS {
                if native & (1 << (COLS - 1 - x)) != 0 {
                    row[x] = 1;
                }
            }
        }
        let board = BoardView { grid };
        assert_eq!(board_to_native_rows(&board), expected, "{name}");
    }
}
