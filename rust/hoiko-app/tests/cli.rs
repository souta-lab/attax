//! CLI parsing tests: the headless/gui dispatch, defaults and typed errors.

use game::contract::WeightPreset;
use game::{VersusTiming, VERSUS_DEFAULTS};
use hoiko_app::cli::{Command, HeadlessArgs, TimingArgs, parse, usage};
use hoiko_app::headless;

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|value| value.to_string()).collect()
}

#[test]
fn no_arguments_open_the_window_with_deterministic_defaults() {
    match parse(&args(&[])).unwrap() {
        Command::Gui(gui) => {
            assert_eq!(gui.seed, 1);
            assert_eq!(gui.speed, 1.0);
        }
        other => panic!("expected Gui, got {other:?}"),
    }
}

#[test]
fn gui_accepts_seed_and_speed() {
    match parse(&args(&["--seed", "42", "--speed", "4"])).unwrap() {
        Command::Gui(gui) => {
            assert_eq!(gui.seed, 42);
            assert_eq!(gui.speed, 4.0);
        }
        other => panic!("expected Gui, got {other:?}"),
    }
}

#[test]
fn headless_reads_timing_knobs() {
    match parse(&args(&[
        "--headless",
        "--timing",
        "independent",
        "--input-ms",
        "60",
        "--latency-left-ms",
        "86",
        "--latency-right-ms",
        "92",
    ]))
    .unwrap()
    {
        Command::Headless(args) => {
            assert_eq!(args.timing.timing, VersusTiming::Independent);
            assert_eq!(args.timing.input_ms, Some(60.0));
            assert_eq!(args.timing.left_latency_ms, Some(86.0));
            assert_eq!(args.timing.right_latency_ms, Some(92.0));
        }
        other => panic!("expected Headless, got {other:?}"),
    }
}

#[test]
fn gui_reads_timing_knobs() {
    match parse(&args(&["--timing", "independent", "--input-ms", "150"])).unwrap() {
        Command::Gui(gui) => {
            assert_eq!(gui.timing.timing, VersusTiming::Independent);
            assert_eq!(gui.timing.input_ms, Some(150.0));
            assert_eq!(gui.timing.left_latency_ms, None);
        }
        other => panic!("expected Gui, got {other:?}"),
    }
}

#[test]
fn timing_args_apply_to_controller_options() {
    let timing = TimingArgs {
        timing: VersusTiming::Independent,
        input_ms: Some(60.0),
        left_latency_ms: Some(86.0),
        right_latency_ms: None,
    };
    let options = timing.apply(VERSUS_DEFAULTS);

    assert_eq!(options.timing, VersusTiming::Independent);
    assert_eq!(options.input_latency_ms, Some(60.0));
    assert_eq!(options.fixed_left_latency_ms, Some(86.0));
    assert_eq!(options.fixed_right_latency_ms, None);
    assert_eq!(options.step_interval_ms, VERSUS_DEFAULTS.step_interval_ms);
    assert_eq!(options.gravity_ms, VERSUS_DEFAULTS.gravity_ms);
}

#[test]
fn headless_defaults_are_deterministic_and_gate_shaped() {
    match parse(&args(&["--headless"])).unwrap() {
        Command::Headless(args) => {
            assert_eq!(args.seeds, vec![1]);
            assert_eq!(args.frames, 12_000);
            assert_eq!(args.tick_ms, 16.0);
            assert!(!args.hoiko.adapt, "headless defaults to adaptation off");
            assert_eq!(args.hoiko.beam_size_limit, 150);
            assert_eq!(args.hoiko.depth_limit, 14);
            assert_eq!(args.deepseek.depth, 7);
            assert!(!args.json);
        }
        other => panic!("expected Headless, got {other:?}"),
    }
}

#[test]
fn headless_reads_every_knob() {
    match parse(&args(&[
        "--headless",
        "--seeds",
        "1,2,3",
        "--frames",
        "500",
        "--tick-ms",
        "8",
        "--hoiko-beam",
        "100",
        "--hoiko-depth",
        "6",
        "--hoiko-adapt",
        "1",
        "--hoiko-offset",
        "0",
        "--hoiko-preset",
        "wo",
        "--ds-depth",
        "3",
        "--ds-width",
        "8",
        "--ds-top-k",
        "4",
        "--json",
    ]))
    .unwrap()
    {
        Command::Headless(args) => {
            assert_eq!(args.seeds, vec![1, 2, 3]);
            assert_eq!(args.frames, 500);
            assert_eq!(args.tick_ms, 8.0);
            assert_eq!(args.hoiko.beam_size_limit, 100);
            assert_eq!(args.hoiko.depth_limit, 6);
            assert!(args.hoiko.adapt);
            assert!(!args.hoiko.offset);
            assert_eq!(args.hoiko.weight_preset, WeightPreset::Wo);
            assert_eq!(args.deepseek.depth, 3);
            assert_eq!(args.deepseek.width, 8);
            assert_eq!(args.deepseek.top_k, 4);
            assert!(args.json);
        }
        other => panic!("expected Headless, got {other:?}"),
    }
}

#[test]
fn headless_seed_flag_is_a_single_seed() {
    match parse(&args(&["--headless", "--seed", "9"])).unwrap() {
        Command::Headless(args) => assert_eq!(args.seeds, vec![9]),
        other => panic!("expected Headless, got {other:?}"),
    }
}

#[test]
fn inline_equals_values_parse() {
    match parse(&args(&["--headless", "--frames=250", "--seeds=4,5"])).unwrap() {
        Command::Headless(args) => {
            assert_eq!(args.frames, 250);
            assert_eq!(args.seeds, vec![4, 5]);
        }
        other => panic!("expected Headless, got {other:?}"),
    }
}

#[test]
fn malformed_values_are_typed_errors() {
    for bad in [
        args(&["--headless", "--frames", "abc"]),
        args(&["--headless", "--hoiko-adapt", "2"]),
        args(&["--headless", "--hoiko-preset", "nope"]),
        args(&["--headless", "--seeds", "1,x"]),
        args(&["--headless", "--timing", "sideways"]),
        args(&["--nope"]),
    ] {
        assert!(parse(&bad).is_err(), "{bad:?} must fail");
    }
}

#[test]
fn usage_mentions_both_modes() {
    let text = usage();
    assert!(text.contains("--headless"));
    assert!(text.contains("spectator window"));
}

#[test]
fn help_is_a_successful_command() {
    assert_eq!(parse(&args(&["--help"])).unwrap(), Command::Help);
    assert_eq!(parse(&args(&["-h"])).unwrap(), Command::Help);
}

#[test]
fn reduced_headless_run_is_clean() {
    let mut args = HeadlessArgs {
        frames: 400,
        ..HeadlessArgs::default()
    };
    args.hoiko.depth_limit = 4;
    args.hoiko.beam_size_limit = 10;
    args.hoiko.min_depth = 2;
    args.deepseek.depth = 2;
    args.deepseek.width = 8;
    args.deepseek.top_k = 4;
    let report = headless::run_seed(&args, 1);
    assert!(report.pieces > 0, "{}", report.summary_line());
    assert_eq!(report.left.mismatches, 0);
    assert_eq!(report.right.mismatches, 0);
    assert_eq!(report.left.board_failures, 0);
    assert_eq!(report.right.board_failures, 0);
}
