/**
 * Recorded-board check of a candidate search config against the frozen competition
 * search (width 96, guideline, nothing else). No games are played.
 *
 * Rebuilds Attax's pre-move state from rematch replays (board = previous recorded
 * after-board, which already includes garbage inserted at that lock; queue, hold and
 * b2b from the records), then runs the competition search twice: urgency 0 (must
 * reproduce the recorded move — a fidelity check on the reconstruction) and the candidate.
 * The referee's exact 7-bag remainder after the visible queue is rebuilt from the piece
 * sequence (bags start at piece 0; each bag is asserted to be a permutation).
 * Reports how often the move changes and, for the planned line, total attack, the burst
 * (max attack over any 3 consecutive locks, counting the 2 real locks before the root)
 * and the peak height.
 *
 * Usage: bun check-recorded.ts CANDIDATE_JSON FROM_TURN STEP REPLAY:GAME_INDEX...
 *   CANDIDATE_JSON: {"speculate":true} | {"width":128} | both.
 *   e.g. bun check-recorded.ts '{"speculate":true}' 0 10 runs/field40-no-diversity/2407.jsonl:0
 *   (the suffix selects the game inside the two-game replay file: 0 = first, 1 = second).
 */
import { readFileSync } from "node:fs";
import { columnHeights } from "../../src/ai/bot/features.js";
import { lockPlacement } from "../../src/ai/bot/movegen.js";
import { search } from "../../src/ai/bot/search.js";
import { DEFAULT_WEIGHTS } from "../../src/ai/bot/weights.js";
import { cellsFor, type PieceKind } from "../../src/core/pieces.js";

const CC: Record<PieceKind, [number, number][]> = {
  I: [
    [-1, 0],
    [0, 0],
    [1, 0],
    [2, 0],
  ],
  O: [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ],
  T: [
    [-1, 0],
    [0, 0],
    [1, 0],
    [0, 1],
  ],
  L: [
    [-1, 0],
    [0, 0],
    [1, 0],
    [1, 1],
  ],
  J: [
    [-1, 0],
    [0, 0],
    [1, 0],
    [-1, 1],
  ],
  S: [
    [-1, 0],
    [0, 0],
    [0, 1],
    [1, 1],
  ],
  Z: [
    [-1, 1],
    [0, 1],
    [0, 0],
    [1, 0],
  ],
};
const rot = (o: string, [x, y]: [number, number]): [number, number] =>
  o === "north" ? [x, y] : o === "east" ? [y, -x] : o === "south" ? [-x, -y] : [-y, x];
const key = (cells: [number, number][]) =>
  cells
    .map(([x, y]) => `${x},${y}`)
    .sort()
    .join(";");

interface Move {
  type: string;
  agent: string;
  turn: number;
  board: number[];
  active: PieceKind;
  hold_before: PieceKind | null;
  next_before: PieceKind[];
  move: {
    location: { type: PieceKind; orientation: string; x: number; y: number };
    spin: string;
  } | null;
  outcome: { lines: number; attack: number } | null;
  hold_used: boolean;
}

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

const [candidateArg, fromArg, stepArg, ...games] = process.argv.slice(2);
const candidate: { speculate?: boolean; width?: number } = JSON.parse(candidateArg as string);
const KINDS: PieceKind[] = ["I", "O", "T", "S", "Z", "J", "L"];
const from = Number(fromArg);
const step = Number(stepArg);
const zero = () => ({
  boards: 0,
  reproduced: 0,
  changed: 0,
  atk0: 0,
  atk1: 0,
  peak0: 0,
  peak1: 0,
  burst0: 0,
  burst1: 0,
});
const total = zero();
for (const spec of games) {
  const [file, index] = spec.split(":");
  let game = -1;
  const moves: Move[] = [];
  for (const line of readFileSync(file as string, "utf8")
    .trim()
    .split("\n")) {
    const r = JSON.parse(line);
    if (r.type === "start") game += 1;
    if (r.type === "move" && r.agent === "attax" && game === Number(index)) moves.push(r);
  }
  // Global piece sequence: first queue, then one new piece per lock (two when an empty
  // hold consumes the next preview). revealed[i] = pieces revealed before move i.
  const first = moves[0] as Move;
  const sequence: PieceKind[] = [first.active, ...first.next_before];
  const revealed: number[] = [sequence.length];
  for (let i = 1; i < moves.length; i += 1) {
    const before = moves[i - 1] as Move;
    const added = before.hold_used && before.hold_before === null ? 2 : 1;
    sequence.push(...(moves[i] as Move).next_before.slice(-added));
    revealed.push(sequence.length);
  }
  for (let b = 0; b + 7 <= sequence.length; b += 7)
    if (new Set(sequence.slice(b, b + 7)).size !== 7)
      throw new Error(`${spec}: bag ${b / 7} is not a permutation`);
  const remainingBag = (n: number) => {
    const start = Math.floor(n / 7) * 7;
    if (n === start) return KINDS;
    const seen = new Set(sequence.slice(start, n));
    return KINDS.filter((k) => !seen.has(k));
  };
  let b2b = false;
  const stats = zero();
  for (let i = 1; i < moves.length; i += 1) {
    const prev = moves[i - 1] as Move;
    const m = moves[i] as Move;
    if (prev.outcome && prev.outcome.lines > 0 && prev.move)
      b2b = prev.outcome.lines === 4 || prev.move.spin !== "none";
    if (m.turn < from || (m.turn - from) % step !== 0 || m.move === null) continue;
    const board = toBoard(prev.board);
    const input = {
      board,
      active: { kind: m.active, rotation: 0, x: 3, y: 19 },
      hold: m.hold_before,
      canHold: true,
      preview: m.next_before,
      b2b,
      combo: -1,
      pending: 0,
      recentAttack: [moves[i - 2]?.outcome?.attack ?? 0, prev.outcome?.attack ?? 0],
    };
    const r0 = search(input, { weights: DEFAULT_WEIGHTS, width: 96, guideline: true });
    const r1 = search(
      {
        ...input,
        speculativePieces: candidate.speculate ? remainingBag(revealed[i] as number) : [],
      },
      {
        weights: DEFAULT_WEIGHTS,
        width: candidate.width ?? 96,
        guideline: true,
      },
    );
    if (!r0 || !r1) continue;
    const cellsOf = (p: { kind: PieceKind; rotation: number; x: number; y: number }) =>
      key(
        cellsFor(p.kind, p.rotation).map(
          (c: { x: number; y: number }) => [p.x + c.x, 39 - (p.y + c.y)] as [number, number],
        ),
      );
    const loc = m.move.location;
    const recorded = key(
      CC[loc.type]
        .map((c) => rot(loc.orientation, c))
        .map(([x, y]) => [x + loc.x, y + loc.y] as [number, number]),
    );
    const lineStats = (line: typeof r0.line) => {
      let b = board;
      let peak = 0;
      for (const s of line) {
        b = lockPlacement(b, s.placement).board;
        peak = Math.max(peak, ...columnHeights(b));
      }
      const seq = [...input.recentAttack, ...line.map((s) => s.attack)];
      let burst = 0;
      for (let j = 2; j < seq.length; j += 1)
        burst = Math.max(
          burst,
          (seq[j] as number) + (seq[j - 1] as number) + (seq[j - 2] as number),
        );
      return { attack: line.reduce((a, s) => a + s.attack, 0), peak, burst };
    };
    const s0 = lineStats(r0.line);
    const s1 = lineStats(r1.line);
    stats.boards += 1;
    if (cellsOf(r0.best.placement) === recorded) stats.reproduced += 1;
    if (cellsOf(r0.best.placement) !== cellsOf(r1.best.placement)) stats.changed += 1;
    stats.atk0 += s0.attack;
    stats.atk1 += s1.attack;
    stats.peak0 += s0.peak;
    stats.peak1 += s1.peak;
    stats.burst0 += s0.burst;
    stats.burst1 += s1.burst;
  }
  console.log(spec, JSON.stringify(stats));
  for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += stats[k];
}
console.log(
  "total",
  JSON.stringify(total),
  `planned attack/board b0=${(total.atk0 / total.boards).toFixed(2)} b=${(total.atk1 / total.boards).toFixed(2)}`,
  `planned peak b0=${(total.peak0 / total.boards).toFixed(2)} b=${(total.peak1 / total.boards).toFixed(2)}`,
  `planned burst3 b0=${(total.burst0 / total.boards).toFixed(2)} b=${(total.burst1 / total.boards).toFixed(2)}`,
);
