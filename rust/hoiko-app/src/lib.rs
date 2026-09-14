//! Native AI-vs-AI Tetris app: RustHoiko vs DeepSeek v2 driven by the phase-1
//! versus core, with an egui spectator window and a headless match mode.
//!
//! ```text
//! cargo run --release -p hoiko-app                          # spectator window
//! cargo run --release -p hoiko-app -- --headless --seeds 1  # headless match
//! ```

#![forbid(unsafe_code)]

pub mod app;
pub mod cli;
pub mod headless;
mod view;

use cli::Command;

/// Parse `std::env::args()` and dispatch to the window or the headless runner.
pub fn run_cli() -> eframe::Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match cli::parse(&args) {
        Ok(Command::Headless(args)) => {
            headless::run(&args);
            Ok(())
        }
        Ok(Command::Gui(args)) => app::run(args),
        Ok(Command::Help) => {
            println!("{}", cli::usage());
            Ok(())
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    }
}
