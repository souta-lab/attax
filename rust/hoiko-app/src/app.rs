//! Spectator window: two labeled boards, hold/next trays, stats, pending
//! garbage meters, winner banner, pause / speed / seed / rematch controls and a
//! recent-battle log — the native counterpart of the web app (`src/main.ts`).
//!
//! The simulation is the phase-1 [`VersusController`] with the phase-2 native
//! fighters; this module only drives and paints it.

use std::cell::Cell;
use std::rc::Rc;

use ai_fighters::{DeepSeekFighter, DeepSeekFighterOptions, HoikoFighter, HoikoFighterOptions};
use eframe::egui::{self, Color32, RichText};
use game::{
    Side, SideState, VersusConfig, VersusController, VersusControllerOptions, VersusResult, Winner,
    speed_options,
};

use crate::cli::{GuiArgs, TimingArgs};
use crate::view;

const SPEEDS: [f64; 4] = [0.5, 1.0, 2.0, 4.0];
const GARBAGE_METER_MAX: i32 = 12;
const NEXT_PREVIEW_COUNT: usize = 5;
const MAX_LOG_ROWS: usize = 5;

const HOIKO_COLOR: Color32 = Color32::from_rgb(0xe9, 0x4f, 0xb0);
const DEEPSEEK_COLOR: Color32 = Color32::from_rgb(0x38, 0xbd, 0xf8);

fn next_seed(seed: i32) -> i32 {
    seed.wrapping_mul(1103515245).wrapping_add(12345) & 0x7fff_ffff
}

/// The engine's draw reason is Japanese; the default egui fonts have no CJK
/// glyphs, so the banner shows the equivalent label.
fn reason_label(reason: &str) -> &str {
    if reason == "同時死亡" {
        "double KO"
    } else {
        reason
    }
}

struct BattleRow {
    no: i32,
    winner: String,
    reason: String,
    lines: String,
    sent: String,
    wins: String,
}

/// Open the native window.
pub fn run(args: GuiArgs) -> eframe::Result<()> {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([1080.0, 880.0])
            .with_title("HOIKO vs DEEPSEEK — TETRIS"),
        ..Default::default()
    };
    eframe::run_native(
        "hoiko-app",
        options,
        Box::new(move |cc| Ok(Box::new(HoikoApp::new(cc, args)))),
    )
}

pub struct HoikoApp {
    controller: VersusController,
    options: VersusControllerOptions,
    timing: TimingArgs,
    speed: f64,
    paused: bool,
    auto_rematch: bool,
    seed_cell: Rc<Cell<i32>>,
    seed_text: String,
    log: Vec<BattleRow>,
    match_no: i32,
    last_result: Option<VersusResult>,
}

impl HoikoApp {
    pub fn new(cc: &eframe::CreationContext<'_>, args: GuiArgs) -> HoikoApp {
        cc.egui_ctx.set_visuals(egui::Visuals::dark());
        let seed_cell = Rc::new(Cell::new(args.seed));
        let mut controller = VersusController::new(
            Box::new(HoikoFighter::new(HoikoFighterOptions::default())),
            Box::new(DeepSeekFighter::new(DeepSeekFighterOptions::default())),
            args.seed,
            VersusConfig::default(),
        );
        let cell = Rc::clone(&seed_cell);
        controller.set_seed_source(Box::new(move || {
            let seed = next_seed(cell.get());
            cell.set(seed);
            seed
        }));
        controller.set_clock(ai_fighters::wall_clock());
        let speed = if args.speed > 0.0 { args.speed } else { 1.0 };
        HoikoApp {
            controller,
            options: args.timing.apply(speed_options(speed)),
            timing: args.timing,
            speed,
            paused: false,
            auto_rematch: true,
            seed_cell,
            seed_text: args.seed.to_string(),
            log: Vec::new(),
            match_no: 0,
            last_result: None,
        }
    }

    fn apply_seed(&mut self, seed: i32) {
        self.seed_cell.set(seed);
        self.seed_text = seed.to_string();
        self.controller.reset_match(seed);
        self.last_result = None;
    }

    fn tick(&mut self, dt_ms: f64) {
        if self.paused {
            return;
        }
        if self.controller.result.is_some() && !self.auto_rematch {
            return;
        }
        self.controller.tick(dt_ms.min(250.0), &self.options);
        if self.controller.result != self.last_result {
            self.last_result = self.controller.result.clone();
            if let Some(result) = self.controller.result.clone() {
                self.log.insert(0, self.battle_row(&result));
                self.log.truncate(MAX_LOG_ROWS);
                self.match_no += 1;
            }
        }
    }

    fn battle_row(&self, result: &VersusResult) -> BattleRow {
        let winner = match result.winner {
            Winner::Left => "HOIKO",
            Winner::Right => "DEEPSEEK",
            Winner::Draw => "DRAW",
        };
        BattleRow {
            no: self.match_no + 1,
            winner: winner.to_string(),
            reason: reason_label(&result.reason).to_string(),
            lines: format!("{}–{}", result.lines_left, result.lines_right),
            sent: format!("{}–{}", result.sent_left, result.sent_right),
            wins: format!(
                "{}–{}",
                self.controller.left.wins, self.controller.right.wins
            ),
        }
    }
}

impl eframe::App for HoikoApp {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let dt_ms = f64::from(ui.ctx().input(|input| input.stable_dt)) * 1000.0;
        self.tick(dt_ms);
        ui.ctx().request_repaint();
        egui::CentralPanel::default().show(ui, |ui| {
            self.header(ui);
            self.banner(ui);
            ui.separator();
            // Fixed-width centered row; `ui.columns` left-aligns each fixed-width
            // side and leaves a lopsided gap on the right.
            const BLOCK_WIDTH: f32 = 520.0;
            let spacing = ui.spacing().item_spacing.x;
            let block = BLOCK_WIDTH.min(ui.available_width() - spacing).max(0.0);
            let side_width = block / 2.0;
            ui.horizontal(|ui| {
                let pad = ((ui.available_width() - (block + spacing)) / 2.0).max(0.0);
                ui.add_space(pad);
                let height = ui.available_height();
                ui.allocate_ui_with_layout(
                    egui::vec2(side_width, height),
                    egui::Layout::top_down(egui::Align::Min),
                    |ui| self.side(ui, Side::Left),
                );
                ui.allocate_ui_with_layout(
                    egui::vec2(side_width, height),
                    egui::Layout::top_down(egui::Align::Min),
                    |ui| self.side(ui, Side::Right),
                );
            });
            ui.separator();
            self.log_view(ui);
        });
    }
}

impl HoikoApp {
    fn header(&mut self, ui: &mut egui::Ui) {
        ui.horizontal(|ui| {
            ui.label(
                RichText::new("HOIKO")
                    .color(HOIKO_COLOR)
                    .size(22.0)
                    .strong(),
            );
            ui.label("vs");
            ui.label(
                RichText::new("DEEPSEEK")
                    .color(DEEPSEEK_COLOR)
                    .size(22.0)
                    .strong(),
            );
            ui.separator();
            let pause_label = if self.paused { "resume" } else { "pause" };
            if ui.button(pause_label).clicked() {
                self.paused = !self.paused;
            }
            for speed in SPEEDS {
                let selected = (self.speed - speed).abs() < f64::EPSILON;
                if ui.selectable_label(selected, format!("{speed}x")).clicked() {
                    self.speed = speed;
                    self.options = self.timing.apply(speed_options(speed));
                    self.paused = false;
                }
            }
            ui.label(format!("timing: {}", self.timing.timing.as_str()));
            ui.checkbox(&mut self.auto_rematch, "auto rematch");
            ui.separator();
            ui.label("seed");
            ui.add(egui::TextEdit::singleline(&mut self.seed_text).desired_width(72.0));
            if ui.button("set").clicked()
                && let Ok(seed) = self.seed_text.parse::<i32>()
            {
                self.apply_seed(seed);
            }
            if ui.button("rematch").clicked() {
                self.apply_seed(self.seed_cell.get());
            }
            if ui.button("new seed").clicked() {
                self.apply_seed(next_seed(self.seed_cell.get()));
            }
            ui.label(format!(
                "match #{} (seed {})",
                self.match_no + 1,
                self.seed_cell.get()
            ));
        });
    }

    fn banner(&mut self, ui: &mut egui::Ui) {
        if let Some(result) = self.controller.result.clone() {
            let (title, color) = match result.winner {
                Winner::Left => ("HOIKO WINS", HOIKO_COLOR),
                Winner::Right => ("DEEPSEEK WINS", DEEPSEEK_COLOR),
                Winner::Draw => ("DRAW", Color32::GRAY),
            };
            ui.horizontal(|ui| {
                ui.label(RichText::new(title).color(color).size(26.0).strong());
                ui.label(format!(
                    "— {} | lines {}–{} | sent {}–{} | pieces {}",
                    reason_label(&result.reason),
                    result.lines_left,
                    result.lines_right,
                    result.sent_left,
                    result.sent_right,
                    result.pieces,
                ));
            });
            if self.auto_rematch {
                let remaining = self.controller.rematch_in.unwrap_or(0.0).max(0.0);
                ui.label(format!("next battle in {:.1}s", remaining / 1000.0));
            } else {
                ui.label("match over — rematch or pick a new seed to continue");
            }
            return;
        }
        let (title, color) = if self.paused {
            ("PAUSED", Color32::from_rgb(0xfa, 0xcc, 0x15))
        } else {
            ("BATTLE IN PROGRESS", Color32::from_rgb(0x4a, 0xde, 0x80))
        };
        ui.horizontal(|ui| {
            ui.label(RichText::new(title).color(color).size(22.0).strong());
            ui.label(format!("{} pieces placed", self.controller.pieces));
        });
    }

    fn side(&self, ui: &mut egui::Ui, side: Side) {
        let (name, color, state) = match side {
            Side::Left => ("HOIKO", HOIKO_COLOR, &self.controller.left),
            Side::Right => ("DEEPSEEK", DEEPSEEK_COLOR, &self.controller.right),
        };
        let snapshot = state.core.snapshot();
        ui.horizontal(|ui| {
            ui.label(RichText::new(name).color(color).size(20.0).strong());
            ui.label(format!("wins {}", state.wins));
            if snapshot.game_over {
                ui.label(RichText::new("GAME OVER").color(Color32::from_rgb(0xf8, 0x71, 0x71)));
            }
        });
        side_meter(ui, snapshot.pending_garbage);
        ui.horizontal(|ui| {
            ui.label(RichText::new("hold").small());
            view::hold(ui, snapshot.hold);
            ui.separator();
            ui.label(RichText::new("next").small());
            view::next_queue(ui, &snapshot.next, NEXT_PREVIEW_COUNT);
        });
        view::board(ui, &snapshot);
        stats(ui, name, state);
    }

    fn log_view(&self, ui: &mut egui::Ui) {
        ui.label(RichText::new("recent battles").strong());
        if self.log.is_empty() {
            ui.label("first battle in progress…");
            return;
        }
        for row in &self.log {
            ui.monospace(format!(
                "#{} {:<16} {:<8} lines {:<9} sent {:<9} score {}",
                row.no, row.winner, row.reason, row.lines, row.sent, row.wins,
            ));
        }
    }
}

fn side_meter(ui: &mut egui::Ui, pending: i32) {
    let queued = pending.min(GARBAGE_METER_MAX);
    let fraction = queued as f32 / GARBAGE_METER_MAX as f32;
    let fill = if queued * 2 >= GARBAGE_METER_MAX {
        Color32::from_rgb(0xf8, 0x71, 0x71)
    } else {
        Color32::from_rgb(0x60, 0xa5, 0xfa)
    };
    ui.add(
        egui::ProgressBar::new(fraction)
            .desired_width(260.0)
            .fill(fill)
            .text(format!("{pending} incoming")),
    );
}

fn stats(ui: &mut egui::Ui, name: &str, state: &SideState) {
    let snapshot = state.core.snapshot();
    let average_think = if state.think_count > 0 {
        state.think_ms / f64::from(state.think_count)
    } else {
        0.0
    };
    egui::Grid::new(format!("stats-{name}"))
        .num_columns(4)
        .spacing([16.0, 4.0])
        .show(ui, |ui| {
            stat(ui, "lines", &snapshot.lines.to_string());
            stat(ui, "sent", &state.sent_total.to_string());
            ui.end_row();
            stat(ui, "pending", &snapshot.pending_garbage.to_string());
            stat(ui, "attack", &snapshot.last_attack.to_string());
            ui.end_row();
            stat(ui, "score", &snapshot.score.to_string());
            stat(ui, "level", &snapshot.level.to_string());
            ui.end_row();
            let combo = if snapshot.combo > 0 {
                snapshot.combo.to_string()
            } else {
                "—".to_string()
            };
            stat(ui, "combo", &combo);
            stat(ui, "b2b", if snapshot.b2b { "on" } else { "—" });
            ui.end_row();
            stat(ui, "locks", &snapshot.lock_id.to_string());
            stat(ui, "avg ms", &format!("{average_think:.1}"));
            ui.end_row();
        });
}

fn stat(ui: &mut egui::Ui, label: &str, value: &str) {
    ui.label(RichText::new(label).small());
    ui.monospace(value);
}
