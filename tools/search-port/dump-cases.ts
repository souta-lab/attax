/**
 * Dump recorded-board search cases for the Rust/TS agreement harness (`rust/attax-search-cli`).
 *
 * Rebuilds Attax's pre-move state from rematch replays exactly as
 * `tools/cc2-rematch/check-recorded.ts` does (board = previous recorded after-board, queue,
 * hold and b2b from the records, the referee's exact 7-bag remainder for the chance ply),
 * runs the TS search with the frozen competition options and writes one JSONL case per
 * decision: the input, the options, the TS weights object, the TS result and its time.
 *
 * Usage: bun tools/search-port/dump-cases.ts OUT.jsonl [--step N] [--speculate 0|1|both]
 *          [--width W] [--weights FILE] REPLAY.jsonl...
 *   Every game inside each replay file is used (agent "attax").
 *   e.g. bun tools/search-port/dump-cases.ts /tmp/cases.jsonl --step 1 \
 *          tools/cc2-rematch/runs/field40-no-diversity/2407.jsonl
 */
import { readFileSync, writeFileSync } from "node:fs";
import { type SearchInput, type SearchResult, search } from "../../src/ai/bot/search.js";
import { DEFAULT_WEIGHTS, type Weights } from "../../src/ai/bot/weights.js";
import type { PieceKind } from "../../src/core/pieces.js";

interface Move {
  type: string;
  agent: string;
  turn: number;
  board: number[];
  active: PieceKind;
  hold_before: PieceKind | null;
  next_before: PieceKind[];
  move: { spin: string } | null;
  outcome: { lines: number; attack: number } | null;
  hold_used: boolean;
}

const KINDS: PieceKind[] = ["I", "O", "T", "S", "Z", "J", "L"];

function toBoard(columns: number[]): Uint16Array {
  const board = new Uint16Array(40);
  for (let x = 0; x < 10; x += 1) {
    const col = columns[x] as number;
    for (let y = 0; y < 40; y += 1) {
      if (Math.floor(col / 2 ** y) % 2 === 1) board[39 - y] = (board[39 - y] as number) | (1 << x);
    }
  }
  return board;
}

const args = process.argv.slice(2);
const out = args.shift();
if (out === undefined) throw new Error("usage: dump-cases.ts OUT.jsonl [options] REPLAY...");
let step = 1;
let speculateModes: boolean[] = [false];
let width = 96;
let weights: Weights = DEFAULT_WEIGHTS;
const files: string[] = [];
while (args.length > 0) {
  const a = args.shift() as string;
  if (a === "--step") step = Number(args.shift());
  else if (a === "--width") width = Number(args.shift());
  else if (a === "--weights") weights = JSON.parse(readFileSync(args.shift() as string, "utf8"));
  else if (a === "--speculate") {
    const v = args.shift();
    speculateModes = v === "both" ? [false, true] : [v === "1"];
  } else files.push(a);
}

const options = { width, diverse: false, exposure: 0, guideline: true };
const lines: string[] = [];
let warmed = false;

const plain = (r: SearchResult | null) =>
  r === null
    ? null
    : {
        best: r.best,
        line: r.line,
        value: r.value,
        candidates: r.candidates,
        nodes: r.nodes,
        depth: r.depth,
      };

for (const file of files) {
  const games: Move[][] = [];
  for (const line of readFileSync(file, "utf8").trim().split("\n")) {
    const r = JSON.parse(line);
    if (r.type === "start") games.push([]);
    if (r.type === "move" && r.agent === "attax") games[games.length - 1]?.push(r);
  }
  games.forEach((moves, gameIndex) => {
    if (moves.length === 0) return;
    const first = moves[0] as Move;
    const sequence: PieceKind[] = [first.active, ...first.next_before];
    const revealed: number[] = [sequence.length];
    for (let i = 1; i < moves.length; i += 1) {
      const before = moves[i - 1] as Move;
      const added = before.hold_used && before.hold_before === null ? 2 : 1;
      sequence.push(...(moves[i] as Move).next_before.slice(-added));
      revealed.push(sequence.length);
    }
    const remainingBag = (n: number): PieceKind[] => {
      const start = Math.floor(n / 7) * 7;
      if (n === start) return KINDS;
      const seen = new Set(sequence.slice(start, n));
      return KINDS.filter((k) => !seen.has(k));
    };
    let b2b = false;
    for (let i = 1; i < moves.length; i += 1) {
      const prev = moves[i - 1] as Move;
      const m = moves[i] as Move;
      if (prev.outcome && prev.outcome.lines > 0 && prev.move)
        b2b = prev.outcome.lines === 4 || prev.move.spin !== "none";
      if (m.turn % step !== 0 || m.move === null) continue;
      for (const speculate of speculateModes) {
        const input: SearchInput = {
          board: toBoard(prev.board),
          active: { kind: m.active, rotation: 0, x: 3, y: 19 },
          hold: m.hold_before,
          canHold: true,
          preview: m.next_before,
          b2b,
          combo: -1,
          pending: 0,
          speculativePieces: speculate ? remainingBag(revealed[i] as number) : [],
        };
        if (!warmed) {
          for (let k = 0; k < 20; k += 1) search(input, { weights, ...options });
          warmed = true;
        }
        const t0 = performance.now();
        const result = search(input, { weights, ...options });
        const tsMs = performance.now() - t0;
        lines.push(
          JSON.stringify({
            id: `${file.split("/").slice(-2).join("/")}:${gameIndex}:t${m.turn}${speculate ? ":spec" : ""}`,
            input: { ...input, board: [...input.board] },
            options,
            weights,
            expect: plain(result),
            tsMs: +tsMs.toFixed(3),
          }),
        );
      }
    }
  });
  console.error(`${file}: ${lines.length} cases so far`);
}
writeFileSync(out, `${lines.join("\n")}\n`);
console.error(`wrote ${lines.length} cases to ${out}`);
