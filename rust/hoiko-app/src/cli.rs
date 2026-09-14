//! Command-line surface for the native app.
//!
//! `hoiko-app` (no flags) opens the spectator window; `--headless` runs
//! DeepSeek-vs-Hoiko matches without a display and prints a summary, so the
//! native path is testable in CI and in the evidence runs.

use ai_fighters::{DeepSeekFighterOptions, HoikoFighterOptions};
use game::contract::WeightPreset;
use game::{VersusControllerOptions, VersusTiming};

/// `scripts/gate-v2.ts` `MAX_TICKS`.
pub const DEFAULT_FRAMES: u64 = 12_000;
/// `scripts/gate-v2.ts` `TICK_MS`.
pub const DEFAULT_TICK_MS: f64 = 16.0;

/// `VERSUS_TIMING` / `VERSUS_INPUT_MS` / `VERSUS_LATENCY_*` mirror for the
/// native app: the same independent-timing knobs the scoreboard gate exposes.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct TimingArgs {
    pub timing: VersusTiming,
    pub input_ms: Option<f64>,
    pub left_latency_ms: Option<f64>,
    pub right_latency_ms: Option<f64>,
}

impl TimingArgs {
    /// Apply the timing flags on top of a base option set (gate shape:
    /// `scripts/gate-v2.ts` `controllerOptions`).
    pub fn apply(&self, base: VersusControllerOptions) -> VersusControllerOptions {
        VersusControllerOptions {
            timing: self.timing,
            input_latency_ms: self.input_ms,
            fixed_left_latency_ms: self.left_latency_ms,
            fixed_right_latency_ms: self.right_latency_ms,
            ..base
        }
    }
}

/// Spectator window options.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GuiArgs {
    pub seed: i32,
    pub speed: f64,
    pub timing: TimingArgs,
}

impl Default for GuiArgs {
    fn default() -> GuiArgs {
        GuiArgs {
            seed: 1,
            speed: 1.0,
            timing: TimingArgs::default(),
        }
    }
}

/// Headless match options.
#[derive(Clone, Debug, PartialEq)]
pub struct HeadlessArgs {
    pub seeds: Vec<i32>,
    pub frames: u64,
    pub tick_ms: f64,
    pub json: bool,
    pub timing: TimingArgs,
    pub hoiko: HoikoFighterOptions,
    pub deepseek: DeepSeekFighterOptions,
}

impl Default for HeadlessArgs {
    fn default() -> HeadlessArgs {
        HeadlessArgs {
            seeds: vec![1],
            frames: DEFAULT_FRAMES,
            tick_ms: DEFAULT_TICK_MS,
            json: false,
            timing: TimingArgs::default(),
            // Deterministic by default: the honest 23-9 gate is adapt = 0.
            hoiko: HoikoFighterOptions {
                adapt: false,
                ..HoikoFighterOptions::default()
            },
            deepseek: DeepSeekFighterOptions::default(),
        }
    }
}

/// Parsed command line.
#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    Gui(GuiArgs),
    Headless(HeadlessArgs),
    Help,
}

/// Typed parse failure, printed with a usage hint.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CliError(pub String);

impl std::fmt::Display for CliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::error::Error for CliError {}

fn parse_i32(name: &str, value: &str) -> Result<i32, CliError> {
    value
        .parse::<i32>()
        .map_err(|_| CliError(format!("{name} must be an integer, got {value}")))
}

fn parse_u64(name: &str, value: &str) -> Result<u64, CliError> {
    value
        .parse::<u64>()
        .map_err(|_| CliError(format!("{name} must be an integer, got {value}")))
}

fn parse_f64(name: &str, value: &str) -> Result<f64, CliError> {
    value
        .parse::<f64>()
        .map_err(|_| CliError(format!("{name} must be a number, got {value}")))
}

fn parse_bool(name: &str, value: &str) -> Result<bool, CliError> {
    match value {
        "0" => Ok(false),
        "1" => Ok(true),
        _ => Err(CliError(format!("{name} must be 0 or 1, got {value}"))),
    }
}

fn parse_timing(value: &str) -> Result<VersusTiming, CliError> {
    match value {
        "shared" => Ok(VersusTiming::Shared),
        "independent" => Ok(VersusTiming::Independent),
        _ => Err(CliError(format!(
            "--timing must be shared|independent, got {value}"
        ))),
    }
}

fn parse_seeds(value: &str) -> Result<Vec<i32>, CliError> {
    let seeds: Vec<i32> = value
        .split(',')
        .map(|part| parse_i32("--seeds", part.trim()))
        .collect::<Result<_, _>>()?;
    if seeds.is_empty() {
        return Err(CliError("--seeds must list at least one seed".to_string()));
    }
    Ok(seeds)
}

/// Parse `std::env::args().skip(1)` (program name already removed).
pub fn parse(args: &[String]) -> Result<Command, CliError> {
    let mut headless = false;
    let mut seed: Option<i32> = None;
    let mut seeds: Vec<i32> = Vec::new();
    let mut frames: Option<u64> = None;
    let mut tick_ms: Option<f64> = None;
    let mut speed: Option<f64> = None;
    let mut json = false;
    let mut timing = TimingArgs::default();
    let mut hoiko = HeadlessArgs::default().hoiko;
    let mut deepseek = DeepSeekFighterOptions::default();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        let mut value = None;
        let mut flag = arg;
        if let Some((name, inline)) = arg.split_once('=') {
            flag = name;
            value = Some(inline.to_string());
        }
        if value.is_none() && index + 1 < args.len() && !flag.starts_with("--") {
            return Err(CliError(format!("unexpected argument {arg}")));
        }
        let mut take = |label: &str| -> Result<String, CliError> {
            if let Some(inline) = value.take() {
                return Ok(inline);
            }
            index += 1;
            args.get(index)
                .cloned()
                .ok_or_else(|| CliError(format!("{label} needs a value")))
        };
        match flag {
            "--headless" => headless = true,
            "--json" => json = true,
            "--seed" => seed = Some(parse_i32("--seed", &take("--seed")?)?),
            "--seeds" => seeds = parse_seeds(&take("--seeds")?)?,
            "--frames" => frames = Some(parse_u64("--frames", &take("--frames")?)?),
            "--tick-ms" => tick_ms = Some(parse_f64("--tick-ms", &take("--tick-ms")?)?),
            "--speed" => speed = Some(parse_f64("--speed", &take("--speed")?)?),
            "--timing" => timing.timing = parse_timing(&take("--timing")?)?,
            "--input-ms" => {
                timing.input_ms = Some(parse_f64("--input-ms", &take("--input-ms")?)?);
            }
            "--latency-left-ms" => {
                timing.left_latency_ms =
                    Some(parse_f64("--latency-left-ms", &take("--latency-left-ms")?)?);
            }
            "--latency-right-ms" => {
                timing.right_latency_ms =
                    Some(parse_f64("--latency-right-ms", &take("--latency-right-ms")?)?);
            }
            "--hoiko-beam" => {
                hoiko.beam_size_limit = parse_i32("--hoiko-beam", &take("--hoiko-beam")?)?;
            }
            "--hoiko-depth" => {
                hoiko.depth_limit = parse_i32("--hoiko-depth", &take("--hoiko-depth")?)?;
            }
            "--hoiko-frames" => {
                hoiko.frames_per_think = parse_i32("--hoiko-frames", &take("--hoiko-frames")?)?;
            }
            "--hoiko-adapt" => {
                hoiko.adapt = parse_bool("--hoiko-adapt", &take("--hoiko-adapt")?)?;
            }
            "--hoiko-offset" => {
                hoiko.offset = parse_bool("--hoiko-offset", &take("--hoiko-offset")?)?;
            }
            "--hoiko-preset" => {
                let raw = take("--hoiko-preset")?;
                hoiko.weight_preset = WeightPreset::parse(&raw)
                    .ok_or_else(|| CliError(format!("unknown hoiko preset {raw}")))?;
            }
            "--ds-depth" => {
                deepseek.depth = parse_u64("--ds-depth", &take("--ds-depth")?)? as usize;
            }
            "--ds-width" => {
                deepseek.width = parse_u64("--ds-width", &take("--ds-width")?)? as usize;
            }
            "--ds-top-k" => {
                deepseek.top_k = parse_u64("--ds-top-k", &take("--ds-top-k")?)? as usize;
            }
            "--help" | "-h" => return Ok(Command::Help),
            other => return Err(CliError(format!("unknown flag {other}\n\n{}", usage()))),
        }
        index += 1;
    }
    if headless {
        let args = HeadlessArgs {
            seeds: if seeds.is_empty() {
                seed.map_or_else(|| vec![1], |seed| vec![seed])
            } else {
                seeds
            },
            frames: frames.unwrap_or(DEFAULT_FRAMES),
            tick_ms: tick_ms.unwrap_or(DEFAULT_TICK_MS),
            json,
            timing,
            hoiko,
            deepseek,
        };
        return Ok(Command::Headless(args));
    }
    Ok(Command::Gui(GuiArgs {
        seed: seed.unwrap_or(1),
        speed: speed.unwrap_or(1.0),
        timing,
    }))
}

/// `--help` text.
pub fn usage() -> String {
    [
        "usage: hoiko-app [--seed N] [--speed 0.5|1|2|4]",
        "       hoiko-app [--timing shared|independent] [--input-ms MS]",
        "                 [--latency-left-ms MS] [--latency-right-ms MS]",
        "       hoiko-app --headless [--seeds 1,2,3] [--frames N] [--tick-ms MS]",
        "                          [--hoiko-beam N] [--hoiko-depth N] [--hoiko-adapt 0|1]",
        "                          [--hoiko-preset we|wo|wd|wr] [--ds-depth N]",
        "                          [--ds-width N] [--ds-top-k N] [--json]",
        "",
        "no flags opens the spectator window; --headless runs matches and prints a summary.",
        "--timing independent locks each side after its own decision + --input-ms latency;",
        "--latency-left-ms/--latency-right-ms pin a side for deterministic runs.",
    ]
    .join("\n")
}
