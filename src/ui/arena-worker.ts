/**
 * Web worker that runs the live arena off the main thread. Both AIs take ~50-150 ms per
 * decision; running them here keeps the page rendering smoothly while they think.
 *
 * In:  { type: "start", seed, botSide, speed } | { type: "speed", speed } | { type: "pause", paused }
 * Out: { type: "ready" } once Hoiko's wasm is loaded (commands sent earlier would be lost:
 *      the module's top-level await delays installing the handler), then
 *      { type: "frame", frame } several times per second and once more when the game ends.
 */
import { createBot } from "../ai/bot/fighter.js";
import { createHoiko } from "../ai/hoiko/browser.js";
import { resolveFaithfulHoikoOptions } from "../ai/hoiko/faithful.js";
import { BRAND } from "../brand.js";
import { type Arena, createArena, type Side, TICK_MS } from "../sim/arena.js";

export type ArenaCommand =
  | {
      readonly type: "start";
      readonly seed: number;
      readonly botSide: Side;
      readonly speed: number;
    }
  | { readonly type: "speed"; readonly speed: number }
  | { readonly type: "pause"; readonly paused: boolean };

/** Speed 0 means "as fast as the CPU allows". */
const SLICE_MS = 40;
const MAX_BACKLOG_MS = 400;

let arena: Arena | null = null;
let speed = 1;
let paused = false;
let simulated = 0;
let target = 0;
let lastWall = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

// Deterministic Hoiko (no wall-clock beam adaptation) so live games reproduce the benchmark.
const hoikoOptions = resolveFaithfulHoikoOptions({ HOIKO_ADAPT: "0" });

function post(): void {
  if (arena !== null) postMessage({ type: "frame", frame: arena.frame() });
}

function pump(): void {
  timer = null;
  if (arena === null || paused) return;
  const now = performance.now();
  const sliceEnd = now + SLICE_MS;
  let alive = true;
  if (speed === 0) {
    while (alive && performance.now() < sliceEnd) {
      alive = arena.step(1);
      simulated += TICK_MS;
    }
    target = simulated;
  } else {
    target = Math.min(target + (now - lastWall) * speed, simulated + MAX_BACKLOG_MS);
    while (alive && simulated < target && performance.now() < sliceEnd) {
      alive = arena.step(1);
      simulated += TICK_MS;
    }
  }
  lastWall = now;
  post();
  if (alive) timer = setTimeout(pump, 8);
}

function schedule(): void {
  if (timer !== null) clearTimeout(timer);
  lastWall = performance.now();
  target = simulated;
  timer = setTimeout(pump, 0);
}

self.onmessage = (event: MessageEvent<ArenaCommand>) => {
  const command = event.data;
  if (command.type === "start") {
    arena = createArena(
      createBot({ name: BRAND.botName }),
      createHoiko(hoikoOptions),
      command.seed,
      command.botSide,
    );
    speed = command.speed;
    paused = false;
    simulated = 0;
    post();
    schedule();
  } else if (command.type === "speed") {
    speed = command.speed;
    schedule();
  } else {
    paused = command.paused;
    if (!paused) schedule();
  }
};

postMessage({ type: "ready" });
