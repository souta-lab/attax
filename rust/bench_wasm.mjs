// WASM bench for the Hoiko engine — mirrors `examples/bench_search.rs`:
// depth-14 empty board, 71 624 nodes/move, no beam adaptation, deterministic
// clock (time_limit_ms = i32::MAX), one `h_search` per move.
//
// Usage: bun rust/bench_wasm.mjs [reps]     (HOIKO_WASM=<path> to override)
//
// The HSearchInput layout is written in exact declaration order (see
// hoiko-core/src/ffi/layout.rs); only weight[0] is populated (weight_count = 1),
// which is exactly what the native bench passes.

const REPS = Number(process.argv[2] ?? 30);
const WASM_PATH = process.env.HOIKO_WASM ?? "../src/ai/hoiko/hoiko_core.wasm";
const MINO_NONE = 7;
const MAX_WEIGHTS = 4;

const WEIGHT = [
  -15, -30, -100, -4, -25, -10, -15, -50, -120, -70, 10, 10, 5, 0, 30, 1000, 2, 30, 5, 5, 35, -30,
  15, 15, 35, 10, -100, 60, 20, -3, 10, 10, -100, -100, -350, -300, -250, 200, 50, 300, 500, 50,
  1500, 50, 0, 250, 50, 0, 0, 0,
];
const COLUMN = [-50, -70, -10, 0, 0, 0, 0, -10, -70, -50];
const COMBO = [180, 360, 540, 900, 1080];
const NEXUS = 0.5;

const bytes = await Bun.file(new URL(WASM_PATH, import.meta.url)).arrayBuffer();
const { instance } = await WebAssembly.instantiate(bytes, {});
const ex = instance.exports;

const inSize = ex.h_search_input_size();
const outSize = ex.h_search_output_size();
const inPtr = ex.h_alloc(inSize);
const outPtr = ex.h_alloc(outSize);

function writeInput() {
  const dv = new DataView(ex.memory.buffer, inPtr, inSize);
  let p = 0;
  const f64 = (v) => {
    dv.setFloat64(p, v, true);
    p += 8;
  };
  const i32 = (v) => {
    dv.setInt32(p, v, true);
    p += 4;
  };
  const i32s = (vs) => {
    for (const v of vs) i32(v);
  };
  for (let k = 0; k < MAX_WEIGHTS; k += 1) f64(k === 0 ? NEXUS : 0);
  for (let k = 0; k < MAX_WEIGHTS; k += 1) i32s(k === 0 ? WEIGHT : new Array(50).fill(0));
  for (let k = 0; k < MAX_WEIGHTS; k += 1) i32s(k === 0 ? COLUMN : new Array(10).fill(0));
  for (let k = 0; k < MAX_WEIGHTS; k += 1) i32s(k === 0 ? COMBO : new Array(5).fill(0));
  i32(1); // weight_count
  i32s(new Array(32).fill(0)); // board
  i32(0); // current = I
  const next = new Array(28).fill(MINO_NONE);
  const queue = [3, 4, 5, 6, 1, 2, 0, 3, 4, 5, 6, 1, 2];
  for (let i = 0; i < queue.length; i += 1) next[i] = queue[i] ?? MINO_NONE;
  i32s(next);
  i32(MINO_NONE); // hold
  i32(0); // combo
  i32(0); // btb
  i32(1); // is_even_board
  i32(0); // use_s4w
  i32(0); // use_pcstack
  i32(2); // view_next
  i32(1); // allow_hold
  i32(0); // multi_evaluation
  i32(0); // opponent_is_pc_board
  i32(0); // opponent_is_powerful_board
  i32(0); // opponents_combo
  i32(0); // weight_index
  i32(10); // min_depth
  i32(14); // depth_limit
  i32(150); // beam_size_limit
  i32(50); // max_beam_size
  i32(1000); // timer_limit_ms
  i32(0x7fffffff); // time_limit_ms (deterministic: the engine never stops on time)
  i32(0); // now_ms
  i32(0); // adapt
  i32(1); // offset_enabled
  i32(0); // pending_garbage
  i32(1); // use_offset_off
  i32(0); // ofs_can_wait_garbage
  i32(0); // ofs_center4_height
  i32(0); // ofs_atk
  i32(0); // ofs_pc_chance
  i32(0); // ofs_near_offset
  i32(0); // gb_opponents_atk
  i32(0); // gb_cool_time
  i32(0); // gb_remaining_time
  i32(0); // gb_opponents_lock_count
  i32(0); // gb_first_invalid_lock
  i32(0); // has_last_own_lock
  i32(0); // last_own_lock_id
  i32(0); // has_last_opp_lock
  i32(0); // last_opp_lock_id
  i32(0); // sync_enabled
  i32(0); // sync_lock_id
  i32(0); // sync_last_action
  i32(0); // sync_last_attack
  i32(0); // sync_has_opp_lock
  i32(0); // sync_opp_lock_id
  i32(0); // sync_opp_clear_lines
  i32(0); // sync_opp_btb
  i32(0); // sync_opp_combo
  i32(0); // sync_now_ms
  i32(0); // next_carry
  i32s(new Array(28).fill(MINO_NONE));
  i32(0); // next_carry_trust_end
  i32(6); // next_carry_bag_remains
  i32(0); // next_carry_pad
  if (p !== inSize) throw new Error(`input layout ${p} != ${inSize}`);
}
writeInput();

// HSearchOutput: f64 over_time at 0, then ok,x,rotation,y,last_srs,use_hold,
// first_r_raw,first_m,first_act,move_delay, plan_acts[16], plan_len, score,
// depth, node, garbage_wait, ...
// byte offsets: ok=8 ... node=124 -> word index (124-8)/4 = 29.
const OK = 0;
const NODE = 29;
// The engine allocates while searching, which can grow (and detach) memory, so
// recreate the output view after every call (see rust/README.md).
const outView = () => new DataView(ex.memory.buffer, outPtr, outSize);
const rd = (v, i32Index) => v.getInt32(8 + i32Index * 4, true);

let ms = 0;
let nodes = 0;
const times = [];
for (let r = 0; r < 5; r += 1) ex.h_search(inPtr, outPtr);
for (let r = 0; r < REPS; r += 1) {
  const t0 = performance.now();
  const rc = ex.h_search(inPtr, outPtr);
  const dt = performance.now() - t0;
  const v = outView();
  if (rc !== 1 || rd(v, OK) !== 1) throw new Error(`h_search failed rc=${rc} ok=${rd(v, OK)}`);
  ms += dt;
  times.push(dt);
  nodes += rd(v, NODE);
}
times.sort((a, b) => a - b);
const trim = times.slice(Math.floor(REPS * 0.1), Math.ceil(REPS * 0.9));
const trimmedMean = trim.reduce((s, t) => s + t, 0) / trim.length;
console.log(
  `WASM: ${(ms / REPS).toFixed(1)}ms/move (median ${times[times.length >> 1].toFixed(1)}, ` +
    `trim-mean ${trimmedMean.toFixed(1)}), ` +
    `${(nodes / REPS).toFixed(0)} nodes/move, ${(((nodes / ms) * 1000) / 1000).toFixed(0)}k nodes/s, depth14`,
);
