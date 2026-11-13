/**
 * The bot executes moves with `placeMinoAt`, which only checks that the cells are free. So
 * the move generator itself must be proven honest: every placement it offers has to be
 * reachable with real engine inputs, every spin it claims has to be awarded by the engine,
 * and it must not miss placements the engine can reach.
 *
 * The reference here drives the real engine: a breadth-first search over input sequences
 * where each state is reproduced by replaying the game history on a fresh engine.
 */
import { describe, expect, test } from "bun:test";
import { snapshotBoard } from "../src/ai/bot/fighter.js";
import { generatePlacements, lockPlacement, type Placement } from "../src/ai/bot/movegen.js";
import { createEngine } from "../src/core/engine.js";
import type { CorePort } from "../src/core/types.js";
import { seededRandom } from "../src/versus/controller.js";

type Input = "left" | "right" | "down" | "cw" | "ccw";
const INPUTS: readonly Input[] = ["left", "right", "down", "cw", "ccw"];

interface History {
  readonly seed: number;
  readonly moves: readonly Placement[];
}

function replay(history: History): CorePort {
  const engine = createEngine({ random: seededRandom(history.seed) });
  for (const m of history.moves) engine.placeMinoAt?.(m.rotation, m.x, m.y, m.lastSrs);
  return engine;
}

function apply(engine: CorePort, input: Input): void {
  if (input === "left") engine.moveLeft();
  else if (input === "right") engine.moveRight();
  else if (input === "down") engine.softDrop();
  else if (input === "cw") engine.rotateCW();
  else engine.rotateCCW();
}

interface Reached {
  /** Some input path to the state. */
  path: Input[];
  /** Input paths to the state whose final input is a rotation. */
  spinPaths: Input[][];
  resting: boolean;
}

/** Every (rotation, x, y) the active piece can occupy, found by driving the engine. */
function engineReachable(history: History): Map<string, Reached> {
  const states = new Map<string, Reached>();
  const start = replay(history).getSnapshot().active;
  if (start === null) return states;
  const key = (a: { rotation: number; posX: number; posY: number }): string =>
    `${a.rotation},${a.posX},${a.posY}`;
  const lockId = replay(history).getSnapshot().lockId;
  states.set(key(start), { path: [], spinPaths: [], resting: false });
  const queue: string[] = [key(start)];
  while (queue.length > 0) {
    const current = states.get(queue.shift() as string) as Reached;
    for (const input of INPUTS) {
      const engine = replay(history);
      for (const step of current.path) apply(engine, step);
      const before = engine.getSnapshot().active;
      apply(engine, input);
      const after = engine.getSnapshot();
      if (after.lockId !== lockId || after.active === null || before === null) {
        // Soft drop on the ground locks: the previous state is a resting state.
        if (input === "down") current.resting = true;
        continue;
      }
      if (key(after.active) === key(before)) continue;
      const k = key(after.active);
      const path = [...current.path, input];
      const isSpin = input === "cw" || input === "ccw";
      const known = states.get(k);
      if (known === undefined) {
        states.set(k, { path, spinPaths: isSpin ? [path] : [], resting: false });
        queue.push(k);
      } else if (isSpin) {
        known.spinPaths.push(path);
      }
    }
  }
  return states;
}

/** Positions sampled from bot-free random play so boards have overhangs and slots. */
function* positions(seed: number, count: number): Generator<History> {
  const rand = seededRandom(seed * 7919);
  const moves: Placement[] = [];
  for (let i = 0; i < count; i += 1) {
    const history = { seed, moves: [...moves] };
    yield history;
    const engine = replay(history);
    const snap = engine.getSnapshot();
    if (snap.active === null || snap.gameOver) return;
    const options = generatePlacements(snapshotBoard(snap), snap.active.kind, {
      rotation: snap.active.rotation,
      x: snap.active.posX,
      y: snap.active.posY,
    });
    // Prefer low placements so the stack stays playable for many pieces.
    options.sort((a, b) => b.y - a.y);
    const pick = options[Math.floor(rand() * Math.min(options.length, 6))];
    if (pick === undefined) return;
    moves.push(pick);
  }
}

describe("bot move generator vs the real engine", () => {
  test("every placement is reachable, every spin is awarded, nothing is missed", () => {
    let checked = 0;
    let spins = 0;
    for (const seed of [3, 11, 29]) {
      for (const history of positions(seed, 28)) {
        const engine = replay(history);
        const snap = engine.getSnapshot();
        const active = snap.active;
        if (active === null || snap.gameOver) break;
        const board = snapshotBoard(snap);
        const ours = generatePlacements(board, active.kind, {
          rotation: active.rotation,
          x: active.posX,
          y: active.posY,
        });
        const reach = engineReachable(history);

        for (const p of ours) {
          const state = reach.get(`${p.rotation},${p.x},${p.y}`);
          expect(state?.resting).toBe(true);
          if (state === undefined) continue;
          // Lock it the way a player would (via a rotation if the bot claims a spin) and
          // check the engine awards exactly what the bot predicted.
          const predicted = lockPlacement(board, p);
          const paths = p.lastSrs > 0 ? state.spinPaths : [state.path];
          expect(paths.length).toBeGreaterThan(0);
          const outcomes = paths.map((path) => {
            const played = replay(history);
            for (const step of path) apply(played, step);
            played.softDrop();
            const t = played.getLastLockTransition();
            return `${t?.linesCleared}:${t?.action}`;
          });
          expect(outcomes).toContain(`${predicted.linesCleared}:${expectedAction(p, predicted)}`);
          if (p.tspin !== "none") spins += 1;
          checked += 1;
        }

        // Completeness: every engine resting state is covered by some bot placement.
        const ourCells = new Set(ours.map((p) => cellsKey(p)));
        for (const [k, state] of reach) {
          if (!state.resting) continue;
          const [rotation, x, y] = k.split(",").map(Number) as [number, number, number];
          const candidate: Placement = { kind: active.kind, rotation, x, y, lastSrs: 0, tspin: "none" };
          if (cellsKey(candidate) === null) continue; // locks above the field: engine top-out
          expect(ourCells.has(cellsKey(candidate))).toBe(true);
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
    expect(spins).toBeGreaterThan(0);
  }, 120_000);
});

function cellsKey(p: Placement): string | null {
  const board = new Uint16Array(20);
  const out = lockPlacement(board, p);
  if (out.board.every((row) => row === 0)) return null;
  return out.board.join(",");
}

function expectedAction(p: Placement, out: ReturnType<typeof lockPlacement>): string {
  const lines = out.linesCleared;
  if (lines === 0) return "None";
  if (out.perfectClear) return "Pc";
  if (lines === 4) return "Quad";
  if (p.tspin === "mini") return "Tsm";
  if (p.tspin === "full") return lines === 1 ? "Tss" : lines === 2 ? "Tsd" : "Tst";
  return lines === 1 ? "Single" : lines === 2 ? "Double" : "Triple";
}
