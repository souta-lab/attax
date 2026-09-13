//! Injected randomness. The core never reads the OS clock or entropy: the
//! versus controller and the game engine own an [`Rng`] supplied by the caller
//! (`src/core/engine.ts` `EngineOptions.random`, `src/versus/controller.ts`
//! `seededRandom`).

/// Deterministic random source used by the game engine (bag shuffle + garbage
/// holes) and by the versus controller (side seeds).
pub trait Rng {
    /// Uniform in `[0, 1)`, the contract of the TS `random: () => number`.
    fn next_f64(&mut self) -> f64;
}

/// Exact port of `src/versus/controller.ts` `seededRandom`:
/// a 32-bit LCG `s = (imul(s, 1103515245) + 12345) & 0x7fffffff`, `s / 2^31`.
#[derive(Clone, Copy, Debug)]
pub struct SeededRng {
    s: i32,
}

impl SeededRng {
    pub fn new(seed: i32) -> SeededRng {
        SeededRng { s: seed }
    }
}

impl Rng for SeededRng {
    fn next_f64(&mut self) -> f64 {
        // `Math.imul` wraps to i32; `+12345` and `& 0x7fffffff` keep the low 31
        // bits, which i64 math reproduces exactly for any i32 seed.
        let next = ((self.s as i64 * 1103515245 + 12345) & 0x7fff_ffff) as i32;
        self.s = next;
        next as f64 / 2147483648.0
    }
}

/// `src/versus/controller.ts` `seededRandom(seed)`.
pub fn seeded_random(seed: i32) -> SeededRng {
    SeededRng::new(seed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_ts_lcg_sequence() {
        // tests/versus-rng.test.ts, seed 12345.
        let mut rng = SeededRng::new(12345);
        assert_eq!(rng.next_f64(), 0.6551540484651923);
        assert_eq!(rng.next_f64(), 0.30481432331725955);
        assert_eq!(rng.next_f64(), 0.6749606337398291);
    }

    #[test]
    fn stays_in_unit_interval_and_is_non_degenerate() {
        let mut rng = SeededRng::new(987654321);
        let seq: Vec<f64> = (0..200).map(|_| rng.next_f64()).collect();
        for value in &seq {
            assert!((0.0..1.0).contains(value));
        }
        let unique: std::collections::HashSet<u64> =
            seq.iter().map(|v| v.to_bits()).collect();
        assert!(unique.len() > 50);
    }
}
