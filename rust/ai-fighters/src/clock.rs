//! Wall-clock helpers for the native app.
//!
//! Used for two independent things: the faithful `SetNextOption` beam
//! adaptation (only when `adapt` is on) and the controller's think-time
//! metrics. Neither affects a decision when adaptation is off.

/// Milliseconds clock. Only differences are consumed.
pub type WallClock = Box<dyn Fn() -> f64>;

/// Monotonic-enough millisecond timestamp.
pub fn wall_clock_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

/// Boxed [`wall_clock_ms`].
pub fn wall_clock() -> WallClock {
    Box::new(wall_clock_ms)
}
