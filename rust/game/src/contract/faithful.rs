//! Faithful shipping-binary in-match configuration for the Hoiko replica.
//!
//! Faithful port of `src/ai/hoiko-faithful.ts`: the fixed binary config
//! (`evidence/hoiko/weights/config.txt`: beamSize 50, minDepth 10, depthLimit
//! 14, viewNext 2, playStyle 0 = `we`, derived cap 150) plus the pure resolver
//! for the gate/harness environment overrides. The resolver takes the
//! environment as data (no `std::env`), so the core stays WASM-friendly.

use std::fmt;

/// `src/ai/hoiko-weights.ts` `HoikoPreset`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WeightPreset {
    We,
    Wo,
    Wd,
    Wr,
    Ultra2,
    Sprint,
}

impl WeightPreset {
    pub const ALL: [WeightPreset; 6] = [
        WeightPreset::We,
        WeightPreset::Wo,
        WeightPreset::Wd,
        WeightPreset::Wr,
        WeightPreset::Ultra2,
        WeightPreset::Sprint,
    ];

    pub const fn as_str(self) -> &'static str {
        match self {
            WeightPreset::We => "we",
            WeightPreset::Wo => "wo",
            WeightPreset::Wd => "wd",
            WeightPreset::Wr => "wr",
            WeightPreset::Ultra2 => "ultra2",
            WeightPreset::Sprint => "sprint",
        }
    }

    pub fn parse(value: &str) -> Option<WeightPreset> {
        WeightPreset::ALL.iter().copied().find(|p| p.as_str() == value)
    }
}

/// `src/ai/hoiko-faithful.ts` `FAITHFUL_HOIKO`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FaithfulHoiko {
    pub weight_preset: WeightPreset,
    pub beam_size_limit: i32,
    pub max_beam_size: i32,
    pub adapt: bool,
    pub depth_limit: i32,
    pub view_next: i32,
}

pub const FAITHFUL_HOIKO: FaithfulHoiko = FaithfulHoiko {
    weight_preset: WeightPreset::We,
    beam_size_limit: 150,
    max_beam_size: 50,
    adapt: true,
    depth_limit: 14,
    view_next: 2,
};

/// `src/ai/hoiko-faithful.ts` `FaithfulHoikoEnv`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FaithfulHoikoEnv<'a> {
    pub hoiko_beam: Option<&'a str>,
    pub hoiko_adapt: Option<&'a str>,
    pub hoiko_offset: Option<&'a str>,
    pub hoiko_frames: Option<&'a str>,
    pub hoiko_nextcarry: Option<&'a str>,
    pub hoiko_even: Option<&'a str>,
}

/// `src/ai/hoiko-faithful.ts` `evenMode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EvenMode {
    Auto,
    True,
    False,
}

impl EvenMode {
    pub const fn as_str(self) -> &'static str {
        match self {
            EvenMode::Auto => "auto",
            EvenMode::True => "true",
            EvenMode::False => "false",
        }
    }
}

/// `src/ai/hoiko-faithful.ts` `RustHoikoOptions`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FaithfulHoikoOptions {
    pub weight_preset: WeightPreset,
    pub beam_size_limit: i32,
    pub max_beam_size: i32,
    pub adapt: bool,
    pub depth_limit: i32,
    pub view_next: i32,
    pub versus: bool,
    pub offset: Option<bool>,
    pub frames_per_think: Option<i32>,
    pub next_carry: Option<bool>,
    pub even_mode: Option<EvenMode>,
}

/// Typed errors mirroring the TS `throw new Error(...)` messages.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FaithfulConfigError {
    NotInteger { name: &'static str, raw: String },
    NotFlag { name: &'static str, raw: String },
    BadEvenMode { raw: String },
}

impl fmt::Display for FaithfulConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FaithfulConfigError::NotInteger { name, raw } => {
                write!(f, "{name} must be an integer, got {raw}")
            }
            FaithfulConfigError::NotFlag { name, raw } => {
                write!(f, "{name} must be 0 or 1, got {raw}")
            }
            FaithfulConfigError::BadEvenMode { raw } => {
                write!(f, "HOIKO_EVEN must be auto, true or false, got {raw}")
            }
        }
    }
}

impl std::error::Error for FaithfulConfigError {}

fn has_env(raw: Option<&str>) -> bool {
    matches!(raw, Some(value) if !value.trim().is_empty())
}

/// JavaScript `Number(raw)` subset: decimal/exponent plus the `0x`/`0o`/`0b`
/// and `Infinity` forms the TS resolver accepts.
fn parse_js_number(raw: &str) -> Option<f64> {
    let t = raw.trim();
    if t.is_empty() {
        return Some(0.0);
    }
    if let Some(hex) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return i64::from_str_radix(hex, 16).ok().map(|v| v as f64);
    }
    if let Some(oct) = t.strip_prefix("0o").or_else(|| t.strip_prefix("0O")) {
        return i64::from_str_radix(oct, 8).ok().map(|v| v as f64);
    }
    if let Some(bin) = t.strip_prefix("0b").or_else(|| t.strip_prefix("0B")) {
        return i64::from_str_radix(bin, 2).ok().map(|v| v as f64);
    }
    match t {
        "Infinity" | "+Infinity" => Some(f64::INFINITY),
        "-Infinity" => Some(f64::NEG_INFINITY),
        _ => t.parse::<f64>().ok(),
    }
}

fn read_env_integer(
    name: &'static str,
    raw: Option<&str>,
    fallback: i32,
) -> Result<i32, FaithfulConfigError> {
    let Some(raw) = raw.filter(|value| !value.trim().is_empty()) else {
        return Ok(fallback);
    };
    let Some(value) = parse_js_number(raw) else {
        return Err(FaithfulConfigError::NotInteger {
            name,
            raw: raw.to_string(),
        });
    };
    if !value.is_finite() || value.fract() != 0.0 {
        return Err(FaithfulConfigError::NotInteger {
            name,
            raw: raw.to_string(),
        });
    }
    Ok(value as i32)
}

fn read_env_flag(
    name: &'static str,
    raw: Option<&str>,
    fallback: bool,
) -> Result<bool, FaithfulConfigError> {
    let Some(raw) = raw.filter(|value| !value.trim().is_empty()) else {
        return Ok(fallback);
    };
    if raw == "0" {
        return Ok(false);
    }
    if raw == "1" {
        return Ok(true);
    }
    Err(FaithfulConfigError::NotFlag {
        name,
        raw: raw.to_string(),
    })
}

fn read_env_even_mode(
    raw: Option<&str>,
    fallback: EvenMode,
) -> Result<EvenMode, FaithfulConfigError> {
    let Some(raw) = raw.filter(|value| !value.trim().is_empty()) else {
        return Ok(fallback);
    };
    if raw == "auto" {
        return Ok(EvenMode::Auto);
    }
    if raw == "true" {
        return Ok(EvenMode::True);
    }
    if raw == "false" {
        return Ok(EvenMode::False);
    }
    Err(FaithfulConfigError::BadEvenMode {
        raw: raw.to_string(),
    })
}

/// `src/ai/hoiko-faithful.ts` `resolveFaithfulHoikoOptions`.
pub fn resolve_faithful_hoiko_options(
    env: &FaithfulHoikoEnv,
    preset: WeightPreset,
) -> Result<FaithfulHoikoOptions, FaithfulConfigError> {
    Ok(FaithfulHoikoOptions {
        weight_preset: preset,
        beam_size_limit: read_env_integer(
            "HOIKO_BEAM",
            env.hoiko_beam,
            FAITHFUL_HOIKO.beam_size_limit,
        )?,
        max_beam_size: FAITHFUL_HOIKO.max_beam_size,
        adapt: read_env_flag("HOIKO_ADAPT", env.hoiko_adapt, FAITHFUL_HOIKO.adapt)?,
        depth_limit: FAITHFUL_HOIKO.depth_limit,
        view_next: FAITHFUL_HOIKO.view_next,
        versus: true,
        offset: if has_env(env.hoiko_offset) {
            Some(read_env_flag("HOIKO_OFFSET", env.hoiko_offset, true)?)
        } else {
            None
        },
        frames_per_think: if has_env(env.hoiko_frames) {
            Some(read_env_integer("HOIKO_FRAMES", env.hoiko_frames, 20)?)
        } else {
            None
        },
        next_carry: if has_env(env.hoiko_nextcarry) {
            Some(read_env_flag("HOIKO_NEXTCARRY", env.hoiko_nextcarry, true)?)
        } else {
            None
        },
        even_mode: if has_env(env.hoiko_even) {
            Some(read_env_even_mode(env.hoiko_even, EvenMode::Auto)?)
        } else {
            None
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constant_carries_the_binary_config_and_derived_bounds() {
        assert_eq!(FAITHFUL_HOIKO.weight_preset, WeightPreset::We);
        assert_eq!(FAITHFUL_HOIKO.beam_size_limit, 150);
        assert_eq!(FAITHFUL_HOIKO.max_beam_size, 50);
        assert!(FAITHFUL_HOIKO.adapt);
        assert_eq!(FAITHFUL_HOIKO.depth_limit, 14);
        assert_eq!(FAITHFUL_HOIKO.view_next, 2);
    }

    #[test]
    fn empty_env_resolves_to_the_faithful_constant_plus_versus() {
        let options = resolve_faithful_hoiko_options(&FaithfulHoikoEnv::default(), WeightPreset::We)
            .expect("empty env");
        assert_eq!(
            options,
            FaithfulHoikoOptions {
                weight_preset: WeightPreset::We,
                beam_size_limit: 150,
                max_beam_size: 50,
                adapt: true,
                depth_limit: 14,
                view_next: 2,
                versus: true,
                offset: None,
                frames_per_think: None,
                next_carry: None,
                even_mode: None,
            }
        );
    }

    #[test]
    fn env_overrides_keep_every_other_faithful_field() {
        let beam = resolve_faithful_hoiko_options(
            &FaithfulHoikoEnv {
                hoiko_beam: Some("1500"),
                ..Default::default()
            },
            WeightPreset::We,
        )
        .expect("beam override");
        assert_eq!(beam.beam_size_limit, 1500);
        assert_eq!(beam.max_beam_size, 50);
        assert_eq!(beam.depth_limit, 14);
        assert!(beam.adapt);

        let adapt = resolve_faithful_hoiko_options(
            &FaithfulHoikoEnv {
                hoiko_adapt: Some("0"),
                ..Default::default()
            },
            WeightPreset::We,
        )
        .expect("adapt override");
        assert!(!adapt.adapt);
        assert_eq!(adapt.beam_size_limit, 150);
    }

    #[test]
    fn preset_argument_overrides_only_the_weight_family() {
        let options =
            resolve_faithful_hoiko_options(&FaithfulHoikoEnv::default(), WeightPreset::Wo)
                .expect("preset override");
        assert_eq!(options.weight_preset, WeightPreset::Wo);
        assert_eq!(options.beam_size_limit, 150);
        assert_eq!(options.depth_limit, 14);
    }

    #[test]
    fn optional_overrides_are_only_present_when_the_env_has_them() {
        let options = resolve_faithful_hoiko_options(
            &FaithfulHoikoEnv {
                hoiko_offset: Some("0"),
                hoiko_frames: Some("20"),
                hoiko_nextcarry: Some("1"),
                hoiko_even: Some("false"),
                ..Default::default()
            },
            WeightPreset::We,
        )
        .expect("optional overrides");
        assert_eq!(options.offset, Some(false));
        assert_eq!(options.frames_per_think, Some(20));
        assert_eq!(options.next_carry, Some(true));
        assert_eq!(options.even_mode, Some(EvenMode::False));
    }

    #[test]
    fn malformed_env_values_are_typed_errors() {
        assert_eq!(
            resolve_faithful_hoiko_options(
                &FaithfulHoikoEnv {
                    hoiko_beam: Some("wide"),
                    ..Default::default()
                },
                WeightPreset::We,
            ),
            Err(FaithfulConfigError::NotInteger {
                name: "HOIKO_BEAM",
                raw: "wide".to_string()
            })
        );
        assert_eq!(
            resolve_faithful_hoiko_options(
                &FaithfulHoikoEnv {
                    hoiko_adapt: Some("yes"),
                    ..Default::default()
                },
                WeightPreset::We,
            ),
            Err(FaithfulConfigError::NotFlag {
                name: "HOIKO_ADAPT",
                raw: "yes".to_string()
            })
        );
        assert_eq!(
            resolve_faithful_hoiko_options(
                &FaithfulHoikoEnv {
                    hoiko_even: Some("maybe"),
                    ..Default::default()
                },
                WeightPreset::We,
            ),
            Err(FaithfulConfigError::BadEvenMode {
                raw: "maybe".to_string()
            })
        );
        assert!(FaithfulConfigError::NotInteger {
            name: "HOIKO_BEAM",
            raw: "wide".into()
        }
        .to_string()
        .contains("HOIKO_BEAM must be an integer"));
    }

    #[test]
    fn whitespace_only_values_fall_back_to_the_default() {
        let options = resolve_faithful_hoiko_options(
            &FaithfulHoikoEnv {
                hoiko_beam: Some("   "),
                hoiko_adapt: Some(""),
                ..Default::default()
            },
            WeightPreset::We,
        )
        .expect("blank env");
        assert_eq!(options.beam_size_limit, 150);
        assert!(options.adapt);
    }

    #[test]
    fn preset_names_match_the_ts_strings() {
        for preset in WeightPreset::ALL {
            assert_eq!(WeightPreset::parse(preset.as_str()), Some(preset));
        }
        assert_eq!(WeightPreset::parse("nope"), None);
    }
}
