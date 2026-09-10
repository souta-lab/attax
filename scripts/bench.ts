import { beamBestMove } from "../src/ai/beam.js";
import { searchBestMove } from "../src/ai/search.js";
import { createEngine } from "../src/core/engine.js";
import type { PieceKind } from "../src/core/pieces.js";

export interface BenchResult {
  readonly label: string;
  readonly seeds: number;
  readonly avgPieces: number;
  readonly avgLines: number;
  readonly avgMsPerMove: number;
  readonly deaths: number;
}

function lcg(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function toBits(grid: readonly (readonly number[])[]): Uint16Array {
  const b = new Uint16Array(20);
  for (let y = 0; y < 20; y += 1) {
    const src = grid[19 - y];
    let bits = 0;
    for (let x = 0; x < 10; x += 1) {
      if ((src?.[x] ?? 0) !== 0) bits |= 1 << x;
    }
    b[y] = bits;
  }
  return b;
}

export type AgentKind = "2ply" | "beam16" | "beam32";

export interface AgentWeights {
  readonly search?: import("../src/ai/weights.js").Weights | undefined;
}

let activeWeights: import("../src/ai/weights.js").Weights | null = null;

export function setBenchWeights(w: import("../src/ai/weights.js").Weights | null): void {
  activeWeights = w;
}

export function runGame(
  seed: number,
  agent: AgentKind,
  maxSteps: number,
): {
  pieces: number;
  lines: number;
  ms: number;
  dead: boolean;
} {
  const core = createEngine({ random: lcg(seed) });
  const port = core as unknown as {
    hardDropAt(r: number, x: number): boolean;
  };
  const t0 = performance.now();
  let n = 0;
  for (let i = 0; i < maxSteps; i += 1) {
    const snap = core.getSnapshot();
    if (snap.gameOver || snap.active === null) {
      return { pieces: n, lines: snap.lines, ms: performance.now() - t0, dead: true };
    }
    const thinkStart = performance.now();
    void thinkStart;
    if (agent === "2ply") {
      const mv = searchBestMove({
        board: { cols: 10, rows: 20, grid: snap.board.grid },
        active: { kind: snap.active.kind, rotation: snap.active.rotation, posX: snap.active.posX },
        next: snap.next,
      });
      if (mv === null) {
        core.hardDrop();
        n += 1;
        continue;
      }
      if (!port.hardDropAt(mv.targetRotation, mv.targetX)) core.hardDrop();
      n += 1;
    } else {
      const board = toBits(snap.board.grid);
      const cur = snap.active.kind as PieceKind;
      const queue = snap.next.slice(0, 5) as PieceKind[];
      const width = agent === "beam32" ? 32 : 16;
      const mv = beamBestMove(board, cur, queue, snap.hold, snap.canHold, false, -1, {
        width,
        depth: 6,
        topK: 16,
        ...(activeWeights === null ? {} : { weights: activeWeights }),
      });
      if (mv === null) {
        core.hardDrop();
        n += 1;
        continue;
      }
      if (mv.useHold) core.hold();
      if (!port.hardDropAt(mv.rotation, mv.x)) core.hardDrop();
      n += 1;
    }
  }
  const end = core.getSnapshot();
  return { pieces: n, lines: end.lines, ms: performance.now() - t0, dead: end.gameOver };
}

export function runBench(
  label: string,
  agent: AgentKind,
  seeds: readonly number[],
  maxSteps: number,
): BenchResult {
  let totP = 0;
  let totL = 0;
  let totMs = 0;
  let deaths = 0;
  for (const seed of seeds) {
    const r = runGame(seed, agent, maxSteps);
    totP += r.pieces;
    totL += r.lines;
    totMs += r.ms;
    if (r.dead) deaths += 1;
  }
  return {
    label,
    seeds: seeds.length,
    avgPieces: totP / seeds.length,
    avgLines: totL / seeds.length,
    avgMsPerMove: totMs / Math.max(1, totP),
    deaths,
  };
}

const seeds = process.argv
  .slice(2)
  .map((v) => Number(v))
  .filter((v) => Number.isFinite(v));
const useSeeds = seeds.length > 0 ? seeds : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const results = [
  runBench("2ply", "2ply", useSeeds, 2000),
  runBench("beam16", "beam16", useSeeds, 2000),
  runBench("beam32", "beam32", useSeeds, 2000),
];
for (const r of results) {
  console.log(
    `${r.label}: seeds=${r.seeds} avgPieces=${r.avgPieces.toFixed(0)} avgLines=${r.avgLines.toFixed(1)} ms/move=${r.avgMsPerMove.toFixed(2)} deaths=${r.deaths}`,
  );
}
