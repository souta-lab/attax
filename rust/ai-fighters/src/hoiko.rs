//! Native `RustHoiko` fighter — the exact host side of
//! `src/ai/hoiko-rust-core.ts`, with `h_search` replaced by the safe
//! `hoiko_core::ffi::run_search_ffi` it wraps.
//!
//! Carry contract (all mirrored from the TS adapter):
//! - [`NextState`] queue carry (`RootNode.SetPPTData` `ShiftNext` + `Compare`),
//! - carried `SearchAI.Search` fields (`weightIndex`, beam cap, timer limit),
//! - carried `OffsetOffAI` state (15 fields) and the `OffsetDecisionOffsetOff`
//!   wait gate,
//! - the deterministic virtual frame clock (`framesPerThink / 0.06` ms/think),
//! - `garbageWait` + `first_x/first_r` first-move result, executed as a
//!   `placeAt` plan via `game::contract::bridge::make_place_at_move`.
//!
//! `SetNextOption` adaptation is host-side in the TS adapter (the wasm engine
//! runs with `adapt = 0`); it is reproduced here with a caller-injectable clock
//! so headless runs stay deterministic while the window app can pass wall time.

use game::AiFighter;
use game::contract::bridge::{
    RawRequestOptions, RawSearchRequest, SyncFields, frame_step_ms, make_place_at_move,
    raw_request_from_snapshot, sync_from_snapshot,
};
use game::contract::{EvenMode, FAITHFUL_HOIKO, FaithfulHoikoOptions, NextState, WeightPreset};
use game::types::{AiMove, GameSnapshot, MINO_NONE, ROWS};
use hoiko_core::HoikoWeights;
use hoiko_core::ffi::{HSearchInput, HSearchOutput, MAX_WEIGHTS, run_search_ffi};
use hoiko_core::get_delay;

use crate::clock::{WallClock, wall_clock};
use crate::presets::weight_list;

/// `hoiko-rust-core.ts` `RustHoikoOptions`, with the two `undefined`-defaulted
/// optional resolved to their faithful values.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HoikoFighterOptions {
    pub weight_preset: WeightPreset,
    pub beam_size_limit: i32,
    pub max_beam_size: i32,
    pub adapt: bool,
    pub depth_limit: i32,
    pub min_depth: i32,
    pub view_next: i32,
    /// `OffsetOffAI` garbage management (`offset`, default true).
    pub offset: bool,
    /// Deterministic frame-clock step per think (`framesPerThink`, default 20).
    pub frames_per_think: i32,
    /// `NextMino` carry (`nextCarry`, defaults to `versus`, i.e. true here).
    pub next_carry: bool,
    /// Versus `isEvenBoard` source (`evenMode`, default auto).
    pub even_mode: EvenMode,
    pub use_s4w: bool,
    pub use_pcstack: bool,
}

impl Default for HoikoFighterOptions {
    fn default() -> HoikoFighterOptions {
        HoikoFighterOptions {
            weight_preset: FAITHFUL_HOIKO.weight_preset,
            beam_size_limit: FAITHFUL_HOIKO.beam_size_limit,
            max_beam_size: FAITHFUL_HOIKO.max_beam_size,
            adapt: FAITHFUL_HOIKO.adapt,
            depth_limit: FAITHFUL_HOIKO.depth_limit,
            min_depth: 10,
            view_next: FAITHFUL_HOIKO.view_next,
            offset: true,
            frames_per_think: 20,
            next_carry: true,
            even_mode: EvenMode::Auto,
            use_s4w: false,
            use_pcstack: false,
        }
    }
}

impl From<FaithfulHoikoOptions> for HoikoFighterOptions {
    fn from(options: FaithfulHoikoOptions) -> HoikoFighterOptions {
        let defaults = HoikoFighterOptions::default();
        HoikoFighterOptions {
            weight_preset: options.weight_preset,
            beam_size_limit: options.beam_size_limit,
            max_beam_size: options.max_beam_size,
            adapt: options.adapt,
            depth_limit: options.depth_limit,
            view_next: options.view_next,
            offset: options.offset.unwrap_or(defaults.offset),
            frames_per_think: options
                .frames_per_think
                .unwrap_or(defaults.frames_per_think),
            next_carry: options.next_carry.unwrap_or(defaults.next_carry),
            even_mode: options.even_mode.unwrap_or(defaults.even_mode),
            ..defaults
        }
    }
}

/// Read-only view of the carried `SearchAI.Search` state (`searchState` in TS).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HoikoSearchState {
    pub weight_index: i32,
    pub max_beam_size: i32,
    pub beam_size_limit: i32,
    pub timer_limit_ms: i32,
}

/// Per-decision debug values (`RustHoikoFighter.getDebug` + `RustOut`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HoikoDebug {
    pub score: i32,
    pub depth: i32,
    pub node: i32,
    pub think_ms: f64,
}

/// The native fighter. One instance per side; [`AiFighter::reset`] restores the
/// new-match state exactly like `RustHoikoEngine.resetMatchState`.
pub struct HoikoFighter {
    options: HoikoFighterOptions,
    weights: [HoikoWeights; MAX_WEIGHTS],
    clock: WallClock,

    // Carried SearchAI.Search state (initial = defaultSearchState).
    weight_index: i32,
    max_beam_size: i32,
    beam_size_limit: i32,
    timer_limit_ms: i32,

    // Carried OffsetOffAI state.
    use_offset_off: i32,
    ofs_can_wait: i32,
    ofs_center4: i32,
    ofs_atk: i32,
    ofs_pc_chance: i32,
    ofs_near_offset: i32,
    gb_opponents_atk: i32,
    gb_cool_time: i32,
    gb_remaining_time: i32,
    gb_opponents_lock_count: i32,
    gb_first_invalid_lock: i32,
    has_last_own_lock: i32,
    last_own_lock_id: i32,
    has_last_opp_lock: i32,
    last_opp_lock_id: i32,

    // Frame clock + NextMino carry.
    frame_ms: f64,
    next: NextState,
    searches_done: i32,
    prev_used_hold: bool,

    last_debug: Option<HoikoDebug>,
}

impl HoikoFighter {
    /// Faithful wall-clock fighter (the window app's default).
    pub fn new(options: HoikoFighterOptions) -> HoikoFighter {
        HoikoFighter::with_clock(options, wall_clock())
    }

    /// Fighter with an injected clock: pass a deterministic closure for
    /// reproducible headless runs (adaptation off ignores the clock entirely).
    pub fn with_clock(options: HoikoFighterOptions, clock: WallClock) -> HoikoFighter {
        let weights = weight_list(options.weight_preset);
        let mut fighter = HoikoFighter {
            options,
            weights,
            clock,
            weight_index: 0,
            max_beam_size: FAITHFUL_HOIKO.max_beam_size,
            beam_size_limit: options.beam_size_limit,
            timer_limit_ms: 1000,
            use_offset_off: 0,
            ofs_can_wait: 0,
            ofs_center4: 0,
            ofs_atk: 0,
            ofs_pc_chance: 0,
            ofs_near_offset: 0,
            gb_opponents_atk: 0,
            gb_cool_time: 0,
            gb_remaining_time: 0,
            gb_opponents_lock_count: 0,
            gb_first_invalid_lock: 0,
            has_last_own_lock: 0,
            last_own_lock_id: 0,
            has_last_opp_lock: 0,
            last_opp_lock_id: 0,
            frame_ms: 0.0,
            next: NextState::new(options.view_next),
            searches_done: 0,
            prev_used_hold: false,
            last_debug: None,
        };
        fighter.reset_match_state();
        fighter
    }

    pub fn options(&self) -> HoikoFighterOptions {
        self.options
    }

    /// `RustHoikoEngine.searchState`.
    pub fn search_state(&self) -> HoikoSearchState {
        HoikoSearchState {
            weight_index: self.weight_index,
            max_beam_size: self.max_beam_size,
            beam_size_limit: self.beam_size_limit,
            timer_limit_ms: self.timer_limit_ms,
        }
    }

    pub fn last_debug(&self) -> Option<HoikoDebug> {
        self.last_debug
    }

    /// `RustHoikoEngine.resetMatchState`: a rematch must not inherit the
    /// previous match's queue/weight/beam/offset/frame state.
    pub fn reset_match_state(&mut self) {
        self.weight_index = 0;
        self.max_beam_size = FAITHFUL_HOIKO.max_beam_size;
        self.beam_size_limit = self.options.beam_size_limit;
        self.timer_limit_ms = 1000;
        self.use_offset_off = flag(self.options.offset);
        self.ofs_can_wait = 0;
        self.ofs_center4 = 0;
        self.ofs_atk = 0;
        self.ofs_pc_chance = 0;
        self.ofs_near_offset = 0;
        self.gb_opponents_atk = 0;
        self.gb_cool_time = 0;
        self.gb_remaining_time = 0;
        self.gb_opponents_lock_count = 0;
        self.gb_first_invalid_lock = 0;
        self.has_last_own_lock = 0;
        self.last_own_lock_id = 0;
        self.has_last_opp_lock = 0;
        self.last_opp_lock_id = 0;
        self.next = NextState::new(self.options.view_next);
        self.searches_done = 0;
        self.prev_used_hold = false;
        self.frame_ms = 0.0;
        self.last_debug = None;
    }

    /// `rawRequestFromSnapshot` options: the native fighter is always the
    /// in-match versus opponent (`createRustHoiko({ versus: true })`).
    fn raw_options(&self) -> RawRequestOptions {
        RawRequestOptions {
            versus: true,
            use_s4w: self.options.use_s4w,
            use_pcstack: self.options.use_pcstack,
            view_next: self.options.view_next,
            is_even_board: true,
            depth: self.options.depth_limit,
            even_mode: self.options.even_mode,
        }
    }

    /// `RustHoikoEngine.advanceNext` (`RootNode.SetPPTData`).
    fn advance_next(&mut self, request: &RawSearchRequest) {
        let mut live = [MINO_NONE; game::contract::NEXT_SIZE];
        live[0] = request.current;
        for (index, kind) in request.next.iter().enumerate() {
            if index + 1 >= game::contract::NEXT_SIZE {
                break;
            }
            live[index + 1] = *kind;
        }
        if self.searches_done == 0 {
            self.next.init(&live);
            return;
        }
        self.next.shift_next();
        if self.prev_used_hold {
            self.next.shift_next();
        }
        self.next.compare(0, &live);
    }

    /// `RustHoikoEngine.writeInput`, field for field.
    fn build_input(
        &self,
        request: &RawSearchRequest,
        sync: &SyncFields,
        pending_garbage: i32,
    ) -> HSearchInput {
        let mut input = empty_input();
        for index in 0..MAX_WEIGHTS {
            input.nexus[index] = self.weights[index].nexus;
            input.weight[index] = self.weights[index].weight;
            input.column[index] = self.weights[index].column;
            input.combo_table[index] = self.weights[index].combo_table;
        }
        input.weight_count = MAX_WEIGHTS as i32;
        for (row, bits) in request.board.iter().enumerate().take(32) {
            input.board[row] = *bits;
        }
        input.current = request.current;
        for (index, kind) in request.next.iter().enumerate().take(28) {
            input.next[index] = *kind;
        }
        input.hold = request.hold;
        input.combo = request.combo;
        input.btb = request.btb;
        input.is_even_board = flag(request.is_even);
        input.use_s4w = flag(request.use_s4w);
        input.use_pcstack = flag(request.use_pcstack);
        input.view_next = request.view_next;
        input.allow_hold = flag(request.allow_hold);
        input.multi_evaluation = flag(request.multi_evaluation);
        input.opponent_is_pc_board = flag(request.opponent_is_pc_board);
        input.opponent_is_powerful_board = flag(request.opponent_is_powerful_board);
        input.opponents_combo = request.opponents_combo;
        input.weight_index = self.weight_index;
        input.min_depth = self.options.min_depth;
        input.depth_limit = self.options.depth_limit;
        input.beam_size_limit = self.beam_size_limit;
        input.max_beam_size = self.max_beam_size;
        input.timer_limit_ms = self.timer_limit_ms;
        input.time_limit_ms = 1000;
        let now_ms = self.frame_ms.trunc() as i32;
        input.now_ms = now_ms;
        // The TS host always writes adapt = 0: `SetNextOption` runs host-side.
        input.adapt = 0;
        input.offset_enabled = flag(self.options.offset);
        input.pending_garbage = pending_garbage;
        input.use_offset_off = self.use_offset_off;
        input.ofs_can_wait_garbage = self.ofs_can_wait;
        input.ofs_center4_height = self.ofs_center4;
        input.ofs_atk = self.ofs_atk;
        input.ofs_pc_chance = self.ofs_pc_chance;
        input.ofs_near_offset = self.ofs_near_offset;
        input.gb_opponents_atk = self.gb_opponents_atk;
        input.gb_cool_time = self.gb_cool_time;
        input.gb_remaining_time = self.gb_remaining_time;
        input.gb_opponents_lock_count = self.gb_opponents_lock_count;
        input.gb_first_invalid_lock = self.gb_first_invalid_lock;
        input.has_last_own_lock = self.has_last_own_lock;
        input.last_own_lock_id = self.last_own_lock_id;
        input.has_last_opp_lock = self.has_last_opp_lock;
        input.last_opp_lock_id = self.last_opp_lock_id;
        input.sync_enabled = 1;
        input.sync_lock_id = sync.lock_id;
        input.sync_last_action = sync.last_action.code();
        input.sync_last_attack = sync.last_attack;
        input.sync_has_opp_lock = flag(sync.opponent_lock_id.is_some());
        input.sync_opp_lock_id = sync.opponent_lock_id.unwrap_or(0);
        input.sync_opp_clear_lines = sync.opponent_last_clear_lines.unwrap_or(0);
        input.sync_opp_btb = sync.opponent_last_native_btb.unwrap_or(0);
        input.sync_opp_combo = sync.opponent_last_native_combo.unwrap_or(0);
        input.sync_now_ms = now_ms;
        input.next_carry = flag(self.options.next_carry);
        if self.options.next_carry {
            input.next_carry_m = self.next.m;
            input.next_carry_trust_end = self.next.trust_end;
            input.next_carry_bag_remains = self.next.bag_remains;
        } else {
            input.next_carry_m = [MINO_NONE; game::contract::NEXT_SIZE];
            input.next_carry_trust_end = 0;
            input.next_carry_bag_remains = 6;
        }
        input.next_carry_pad = 0;
        input
    }

    /// Carry every `h_search` output field forward (`RustHoikoEngine.search`).
    fn carry(&mut self, out: &HSearchOutput, elapsed_ms: f64) {
        self.weight_index = out.weight_index;
        if self.options.adapt {
            self.apply_set_next_option(elapsed_ms, out);
        } else {
            self.max_beam_size = out.max_beam_size;
            self.beam_size_limit = out.beam_size_limit;
            self.timer_limit_ms = out.timer_limit_ms;
        }
        self.use_offset_off = out.use_offset_off;
        self.ofs_can_wait = out.ofs_can_wait_garbage;
        self.ofs_center4 = out.ofs_center4_height;
        self.ofs_atk = out.ofs_atk;
        self.ofs_pc_chance = out.ofs_pc_chance;
        self.ofs_near_offset = out.ofs_near_offset;
        self.gb_opponents_atk = out.gb_opponents_atk;
        self.gb_cool_time = out.gb_cool_time;
        self.gb_remaining_time = out.gb_remaining_time;
        self.gb_opponents_lock_count = out.gb_opponents_lock_count;
        self.gb_first_invalid_lock = out.gb_first_invalid_lock;
        self.has_last_own_lock = out.has_last_own_lock;
        self.last_own_lock_id = out.last_own_lock_id;
        self.has_last_opp_lock = out.has_last_opp_lock;
        self.last_opp_lock_id = out.last_opp_lock_id;
        self.searches_done += 1;
        self.prev_used_hold = out.use_hold == 1;
        self.frame_ms += frame_step_ms(self.options.frames_per_think);
    }

    /// `RustHoikoEngine.applySetNextOption` (binary `SetNextOption`, IL 15892)
    /// driven by the REAL search time — identical arithmetic to
    /// `hoiko_core::set_next_option`, minus the `safe` 0.8 factor the host path
    /// does not apply.
    fn apply_set_next_option(&mut self, elapsed_ms: f64, out: &HSearchOutput) {
        let limit_at_start = self.timer_limit_ms;
        let over_time = elapsed_ms - f64::from(limit_at_start);
        if over_time > 0.0 {
            self.max_beam_size += (out.depth - 14) * 10;
        } else if over_time < -33.0 && limit_at_start < 336 {
            self.max_beam_size += ((over_time + 16.0) * 0.06).trunc() as i32 * -10;
        }
        self.max_beam_size = self.max_beam_size.clamp(50, 500);
        let timer_limit = get_delay(out.move_delay, out.first_act) - 5;
        self.timer_limit_ms = timer_limit;
        let mut beam = ((self.max_beam_size * timer_limit) as f64 / 112.0).trunc() as i32;
        beam = beam.min(self.max_beam_size * 3);
        self.beam_size_limit = beam;
    }

    /// `RustHoikoEngine.search` + `RustHoikoFighter.searchSnapshot`.
    pub fn search_snapshot(&mut self, snapshot: &GameSnapshot) -> Option<AiMove> {
        if snapshot.active.is_none() || snapshot.game_over {
            return None;
        }
        let request = raw_request_from_snapshot(snapshot, &self.raw_options())?;
        if self.options.next_carry {
            self.advance_next(&request);
        }
        let sync = sync_from_snapshot(snapshot);
        let input = self.build_input(&request, &sync, snapshot.pending_garbage);
        let mut out = empty_output();
        let started = (self.clock)();
        let rc = run_search_ffi(&input, &mut out);
        let elapsed_ms = (self.clock)() - started;
        if rc != 1 || out.ok != 1 {
            return None;
        }
        self.carry(&out, elapsed_ms);
        self.last_debug = Some(HoikoDebug {
            score: out.score,
            depth: out.depth,
            node: out.node,
            think_ms: elapsed_ms,
        });
        move_from_out(snapshot, &out)
    }
}

impl AiFighter for HoikoFighter {
    fn find_best_move(&mut self, snapshot: &GameSnapshot) -> Option<AiMove> {
        self.search_snapshot(snapshot)
    }

    fn reset(&mut self) {
        self.reset_match_state();
    }
}

/// `RustHoikoFighter.findBestMove` minus the engine plumbing: first move ->
/// `AiMove` with the `garbageWait` gate flag.
fn move_from_out(snapshot: &GameSnapshot, out: &HSearchOutput) -> Option<AiMove> {
    let rotation = ((out.first_r_raw % 4) + 4) % 4;
    let garbage_wait = out.garbage_wait == 1;
    if out.use_hold == 1 {
        return Some(AiMove {
            target_x: out.x,
            target_rotation: rotation,
            use_hold: true,
            garbage_wait: Some(garbage_wait),
            execution: None,
        });
    }
    let mut mv = make_place_at_move(
        snapshot,
        out.x,
        rotation,
        ROWS as i32 - 1 - out.y,
        out.last_srs,
    )?;
    mv.garbage_wait = Some(garbage_wait);
    Some(mv)
}

fn flag(value: bool) -> i32 {
    if value { 1 } else { 0 }
}

/// Zeroed `HSearchInput` with `MINO_NONE` queue slots (the TS writer's default
/// fill). `HSearchInput` is a plain `#[repr(C)]` struct; every field is
/// overwritten by [`HoikoFighter::build_input`] before the call.
fn empty_input() -> HSearchInput {
    HSearchInput {
        nexus: [0.0; MAX_WEIGHTS],
        weight: [[0; 50]; MAX_WEIGHTS],
        column: [[0; 10]; MAX_WEIGHTS],
        combo_table: [[0; 5]; MAX_WEIGHTS],
        weight_count: 0,
        board: [0; 32],
        current: MINO_NONE,
        next: [MINO_NONE; 28],
        hold: MINO_NONE,
        combo: 0,
        btb: 0,
        is_even_board: 0,
        use_s4w: 0,
        use_pcstack: 0,
        view_next: 0,
        allow_hold: 0,
        multi_evaluation: 0,
        opponent_is_pc_board: 0,
        opponent_is_powerful_board: 0,
        opponents_combo: 0,
        weight_index: 0,
        min_depth: 0,
        depth_limit: 0,
        beam_size_limit: 0,
        max_beam_size: 0,
        timer_limit_ms: 0,
        time_limit_ms: 0,
        now_ms: 0,
        adapt: 0,
        offset_enabled: 0,
        pending_garbage: 0,
        use_offset_off: 0,
        ofs_can_wait_garbage: 0,
        ofs_center4_height: 0,
        ofs_atk: 0,
        ofs_pc_chance: 0,
        ofs_near_offset: 0,
        gb_opponents_atk: 0,
        gb_cool_time: 0,
        gb_remaining_time: 0,
        gb_opponents_lock_count: 0,
        gb_first_invalid_lock: 0,
        has_last_own_lock: 0,
        last_own_lock_id: 0,
        has_last_opp_lock: 0,
        last_opp_lock_id: 0,
        sync_enabled: 0,
        sync_lock_id: 0,
        sync_last_action: 0,
        sync_last_attack: 0,
        sync_has_opp_lock: 0,
        sync_opp_lock_id: 0,
        sync_opp_clear_lines: 0,
        sync_opp_btb: 0,
        sync_opp_combo: 0,
        sync_now_ms: 0,
        next_carry: 0,
        next_carry_m: [MINO_NONE; 28],
        next_carry_trust_end: 0,
        next_carry_bag_remains: 0,
        next_carry_pad: 0,
    }
}

/// Zeroed `HSearchOutput`; `run_search_ffi` resets the payload fields itself.
fn empty_output() -> HSearchOutput {
    HSearchOutput {
        over_time: 0.0,
        ok: 0,
        x: 0,
        rotation: 0,
        y: 0,
        last_srs: 0,
        use_hold: 0,
        first_r_raw: 0,
        first_m: 0,
        first_act: 0,
        move_delay: 0,
        plan_acts: [0; hoiko_core::ffi::MAX_PLAN_ACTS],
        plan_len: 0,
        score: 0,
        depth: 0,
        node: 0,
        garbage_wait: 0,
        max_beam_size: 0,
        beam_size_limit: 0,
        timer_limit_ms: 0,
        weight_index: 0,
        use_offset_off: 0,
        ofs_can_wait_garbage: 0,
        ofs_center4_height: 0,
        ofs_atk: 0,
        ofs_pc_chance: 0,
        ofs_near_offset: 0,
        gb_opponents_atk: 0,
        gb_cool_time: 0,
        gb_remaining_time: 0,
        gb_opponents_lock_count: 0,
        gb_first_invalid_lock: 0,
        has_last_own_lock: 0,
        last_own_lock_id: 0,
        has_last_opp_lock: 0,
        last_opp_lock_id: 0,
    }
}
