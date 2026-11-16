/**
 * Chunk 3b golden battery: fixed S2 + guideline search cases used to prove
 * behaviour identity across the single-core port.
 *
 * `capture-s2-golden.ts` ran these cases against the PRE-PORT searches
 * (the since-deleted tools/s2-lab/search.ts for S2, src/ai/bot/search.ts for
 * guideline) and recorded full results in s2-golden.json. After the port, the
 * parity test (tools/s2-lab/shared-parity.test.ts) replays the same cases
 * against the shared src search and requires exact equality.
 *
 * The S2 inputs use the lab input shape (tools/s2-lab/s2-input.ts: numeric
 * exact chain in `b2b`); map them with `toSharedInput` before searching.
 */
import { spawnPosition } from "../../src/ai/bot/movegen.js";
import type { SearchInput as SrcSearchInput } from "../../src/ai/bot/state.js";
import { DEFAULT_WEIGHTS, type Weights } from "../../src/ai/bot/weights.js";
import type { PieceKind } from "../../src/core/pieces.js";
import type {
  SearchInput as S2SearchInput,
  SearchOptions as S2SearchOptions,
} from "../s2-lab/s2-input.js";
import { DEFAULT_SOLVENCY_PARAMS } from "../s2-lab/solvency.js";
import { DEFAULT_STOCK_PARAMS } from "../s2-lab/stock.js";

const ALL_KINDS: readonly PieceKind[] = ["I", "O", "T", "S", "Z", "J", "L"];

/** Build a 40-row board from bottom-up row strings ('.' empty, '#' filled, 'G' garbage). */
export function mkBoard(bottomRows: readonly string[]): {
  board: Uint16Array;
  garbageRows: number[];
} {
  const board = new Uint16Array(40);
  const garbageRows = Array<number>(40).fill(0);
  bottomRows.forEach((rowStr, i) => {
    const idx = 39 - i;
    let bits = 0;
    for (let x = 0; x < 10; x += 1) {
      const ch = rowStr[x] as string;
      if (ch === "#" || ch === "G") bits |= 1 << x;
      if (ch === "G") garbageRows[idx] = 1;
    }
    board[idx] = bits;
  });
  return { board, garbageRows };
}

const MID_STACK = [
  "#########.",
  "#########.",
  "####.#####",
  "#########.",
  "###.######",
  "#########.",
  ".#########",
  "#####.####",
];

function s2Input(
  partial: Partial<S2SearchInput> & { board: S2SearchInput["board"] },
): S2SearchInput {
  return {
    active: { kind: "T", ...spawnPosition("T", 40) },
    hold: "J",
    canHold: true,
    preview: ["S", "Z", "O", "L", "I"],
    b2b: 0,
    combo: -1,
    pending: 0,
    dueThisLock: 0,
    ...partial,
  };
}

export interface S2Case {
  readonly name: string;
  readonly input: S2SearchInput;
  readonly options: S2SearchOptions;
}

export function s2Battery(weights: Weights = DEFAULT_WEIGHTS): S2Case[] {
  const mid = mkBoard(MID_STACK);
  const base = s2Input({ board: mid.board });
  const cases: S2Case[] = [
    { name: "plain", input: base, options: { weights, width: 48 } },
    {
      name: "stock-on",
      input: base,
      options: { weights, width: 48, stock: DEFAULT_STOCK_PARAMS },
    },
    {
      name: "solvency-on",
      input: s2Input({ board: mid.board, pending: 7, dueThisLock: 7 }),
      options: { weights, width: 48, solvency: DEFAULT_SOLVENCY_PARAMS },
    },
    {
      name: "veto-on",
      input: s2Input({ board: mid.board, pending: 7, dueThisLock: 7 }),
      options: { weights, width: 48, rootVeto: true },
    },
    {
      name: "pending-frame",
      input: s2Input({
        board: mkBoard(["GGGGGGGGG.", "GGGGGGGGG.", "####.#####", "#########.", "###.######"])
          .board,
        garbageRows: mkBoard(["GGGGGGGGG.", "GGGGGGGGG.", "####.#####", "#########.", "###.######"])
          .garbageRows,
        active: { kind: "I", ...spawnPosition("I", 40) },
        preview: ["I", "O", "T"],
        b2b: 3,
        combo: 2,
        pending: 6,
        dueThisLock: 4,
        frame: 14550,
      }),
      options: { weights, width: 48 },
    },
    {
      name: "speculative",
      input: s2Input({ board: mid.board, preview: [], speculativePieces: ALL_KINDS }),
      options: { weights, width: 48 },
    },
    {
      name: "near-death",
      input: s2Input({
        board: mkBoard([
          ...Array.from({ length: 18 }, (_, i) => (i % 3 === 0 ? "####.#####" : "#########.")),
          "###....###",
          "###....###",
          "##......##",
          "##......##",
        ]).board,
        pending: 3,
        dueThisLock: 3,
      }),
      options: { weights, width: 48 },
    },
    {
      name: "all-fatal",
      input: s2Input({
        board: mkBoard([
          ...Array.from({ length: 20 }, () => "##.####.##"),
          "###....###",
          "###....###",
          "##......##",
          "##......##",
        ]).board,
        pending: 8,
        dueThisLock: 8,
      }),
      options: { weights, width: 48 },
    },
    {
      name: "hold-empty",
      input: s2Input({
        board: mid.board,
        active: { kind: "O", ...spawnPosition("O", 40) },
        hold: null,
        preview: ["I", "T", "S"],
      }),
      options: { weights, width: 48 },
    },
    {
      name: "accept-root",
      input: s2Input({
        board: mid.board,
        acceptRoot: (placement, usedHold) => usedHold || placement.x >= 2,
      }),
      options: { weights, width: 48 },
    },
    { name: "diverse", input: base, options: { weights, width: 48, diverse: true } },
    {
      name: "surge",
      input: s2Input({
        board: mkBoard(["###....###", "####..####", "#########.", "#########."]).board,
        b2b: 6,
        combo: 0,
      }),
      options: { weights, width: 48, stock: DEFAULT_STOCK_PARAMS },
    },
    {
      name: "exposure",
      input: s2Input({
        board: mkBoard(
          Array.from({ length: 14 }, (_, i) => (i % 3 === 0 ? "####.#####" : "#########.")),
        ).board,
      }),
      options: { weights, width: 48, exposure: 0.25 },
    },
  ];
  return cases;
}

export interface GuidelineCase {
  readonly name: string;
  readonly input: SrcSearchInput;
  readonly options: {
    weights: Weights;
    width: number;
    diverse?: boolean;
    guideline?: boolean;
  };
}

export function guidelineBattery(weights: Weights = DEFAULT_WEIGHTS): GuidelineCase[] {
  const rows20 = new Uint16Array(20);
  const spec = mkBoard(MID_STACK).board;
  for (let i = 0; i < 8; i += 1) rows20[19 - i] = spec[39 - i] as number;
  const base: SrcSearchInput = {
    board: rows20,
    active: { kind: "T", ...spawnPosition("T", 20) },
    hold: "J",
    canHold: true,
    preview: ["S", "Z", "O", "L", "I"],
    b2b: false,
    combo: -1,
    pending: 0,
  };
  return [
    { name: "g-plain", input: base, options: { weights, width: 48 } },
    {
      name: "g-speculative",
      input: { ...base, preview: ["S"], speculativePieces: ALL_KINDS },
      options: { weights, width: 48 },
    },
    {
      name: "g-rig-40",
      input: { ...base, board: spec, active: { kind: "T", ...spawnPosition("T", 40) } },
      options: { weights, width: 48, guideline: true },
    },
    { name: "g-diverse", input: base, options: { weights, width: 48, diverse: true } },
  ];
}
