/**
 * `isEvenBoard` per-turn contract probe.
 *
 * The binary writes `EvaluateAI.isEvenBoard` in exactly two places:
 * `EvaluateAI.ReadConfig` (true, IL 11042) and `EvaluateAI.EvenOrOdd` (board
 * parity, IL 13658). `EvenOrOdd` is only called from `SearchAI.QuickSearch`
 * (IL 15603), and the normal per-turn path in the game is
 * `RootNode.SetPPTData` + `SearchAI.Search` (`PPTMain.Update` 5054-5062,
 * `PPT2Main.Update` 3630-3638, `TetrizMain.Update` 21972-21980); `QuickSearch`
 * runs only on the `NextTurn` resync path (`!RootNode.IsSameAs(root, mimic)`,
 * IL 2682-2684). So without an override the exe's own static value is the real
 * normal-path input.
 *
 * This tool queries the exe four ways on the same position — untouched (`real`),
 * `iseven=1`, `iseven=0`, `evenodd=1` (the resync `EvenOrOdd`) — and the
 * Rust/WASM adapter in all three `evenMode`s, to show which mode the exe's real
 * value matches.
 *
 *   bun iseven.ts
 *
 * Evidence: evidence/hoiko-inputs/iseven/.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import type { BoardView, GameSnapshot, PieceKind } from "../../../src/core/types.js";
import { createHoiko, type RustHoikoFighter } from "../../hoiko-node.js";
import { runExe } from "./exe.js";

const EVIDENCE = new URL("../../../evidence/hoiko-inputs/iseven/", import.meta.url);
mkdirSync(EVIDENCE, { recursive: true });

const BAG = [6, 5, 4, 3, 1, 2, 0];
const KIND: Record<number, PieceKind> = { 0: "I", 1: "J", 2: "L", 3: "O", 4: "T", 5: "S", 6: "Z" };

interface Position {
  readonly name: string;
  readonly board: readonly number[];
  readonly current: number;
  readonly queue: readonly number[];
  readonly popcount: number;
}

function popcount(rows: readonly number[]): number {
  let total = 0;
  for (const row of rows) {
    let bits = row;
    while (bits !== 0) {
      bits &= bits - 1;
      total += 1;
    }
  }
  return total;
}

function queue27(shift: number): number[] {
  return Array.from({ length: 27 }, (_, i) => BAG[(i + shift) % 7] ?? 7);
}

function makePosition(name: string, board: readonly number[], current = BAG[0] ?? 0): Position {
  return { name, board, current, queue: queue27(0), popcount: popcount(board) };
}

const POSITIONS: Position[] = [
  makePosition("empty", []),
  makePosition("floor", [0x3ff]),
  makePosition("low-odd", [0x3ff, 0x001]),
  makePosition("low-even", [0x3ff, 0x3ff]),
  makePosition("mid-odd", [0x3ff, 0x3ff, 0x001]),
  makePosition("stack-odd", [0x3ff, 0x3ff, 0x3ff, 0x001, 0x001, 0x001]),
  makePosition("well-odd", [0x3fd, 0x3fd, 0x3fd]),
  makePosition("odd-3bit", [0x038]),
  // Discriminating case: current piece I, odd board. The exe's real static
  // (true) selects row 0 / m=O; parity (`iseven=0`/`evenodd=1`) selects row 1
  // and places I instead.
  makePosition("odd-3bit-I", [0x038], 0),
];

function gridFrom(rows: readonly number[], height: number): BoardView {
  const grid: number[][] = Array.from({ length: height }, () =>
    Array.from({ length: 10 }, () => 0),
  );
  for (let y = 0; y < rows.length && y < height; y += 1) {
    const native = rows[y] ?? 0;
    const row = grid[height - 1 - y];
    if (row === undefined) continue;
    for (let c = 0; c < 10; c += 1) if ((native & (1 << (9 - c))) !== 0) row[c] = 1;
  }
  return { cols: 10, rows: height, grid };
}

function snapshotFrom(p: Position): GameSnapshot {
  const rows = 24;
  return {
    board: gridFrom(p.board, rows),
    active: { kind: KIND[p.current] ?? "I", rotation: 0, cells: [], posX: 3, posY: 0 },
    ghostY: null,
    hold: null,
    canHold: true,
    next: p.queue.slice(0, 12).map((v) => KIND[v] ?? "I"),
    score: 0,
    lines: 0,
    level: 1,
    gameOver: false,
    combo: 0,
    b2b: false,
    nativeCombo: 0,
    nativeBtb: 0,
    lockId: 0,
    lastAction: "None",
    lastRawAttack: 0,
    pendingGarbage: 0,
    lastAttack: 0,
    lastBlocked: 0,
    opponentCombo: 0,
    opponentBtb: 0,
    opponentLockId: 0,
    // Odd-popcount opponent board => `opponentIsPCBoard=false`, matching the
    // probe's neutral `opppc=0` (an empty board is a "PC board" to the binary).
    opponentBoard: gridFrom([0x001], rows),
  };
}

function exeInput(p: Position, mode: "real" | "true" | "false" | "parity"): string {
  const board = [...p.board];
  while (board.length < 32) board.push(0);
  return [
    `# iseven ${p.name} mode=${mode}`,
    `board=${board.map((v) => `0x${(v >>> 0).toString(16)}`).join(",")}`,
    `next=${[p.current, ...p.queue].join(",")}`,
    "depthlimit=10",
    "weightindex=0",
    "multieval=1",
    "oppcombo=0",
    // Neutral opponent flags so the probe isolates `isEvenBoard`; with
    // `opppc=1` the isEvenBoard=true branch also selects row 1 on low stacks.
    "opppc=0",
    "opppowerful=0",
    ...(mode === "true" ? ["iseven=1"] : []),
    ...(mode === "false" ? ["iseven=0"] : []),
    ...(mode === "parity" ? ["evenodd=1"] : []),
    "",
  ].join("\n");
}

interface Decision {
  readonly x: number;
  readonly rot: number;
  readonly m: number;
  readonly weightIndex: number;
}

function parseDecision(text: string): Decision | null {
  const fm = text.match(/firstMove @\+?456:\s*x=(-?\d+)\s+y=(-?\d+)\s+rot=(-?\d+)\s+m=(-?\d+)/);
  if (fm === null) return null;
  const wi = text.match(/weightIndex=(-?\d+)/);
  return {
    x: Number(fm[1]),
    rot: Number(fm[3]),
    m: Number(fm[4]),
    weightIndex: wi === null ? -1 : Number(wi[1]),
  };
}

function replicaDecision(p: Position, evenMode: "auto" | "true" | "false"): Decision {
  const fighter: RustHoikoFighter = createHoiko({
    versus: true,
    adapt: false,
    depthLimit: 10,
    evenMode,
  });
  const res = fighter.searchSnapshot(snapshotFrom(p));
  if (res === null) throw new Error(`replica null for ${p.name}`);
  return {
    x: res.out.x,
    rot: ((res.out.firstRRaw % 4) + 4) % 4,
    m: res.out.firstM,
    weightIndex: res.out.weightIndex,
  };
}

const key = (d: Decision): string => `${d.x}/${d.rot}/${d.m}`;
const rows: Record<string, unknown>[] = [];
let realMatchesTrue = 0;
let parityMatchesAuto = 0;

for (const p of POSITIONS) {
  const decisions: Record<string, Decision | null> = {};
  for (const mode of ["real", "true", "false", "parity"] as const) {
    const run = runExe(exeInput(p, mode));
    writeFileSync(new URL(`${p.name}-${mode}.log`, EVIDENCE), run.text);
    decisions[mode] = run.ok ? parseDecision(run.text) : null;
  }
  const replica = {
    auto: replicaDecision(p, "auto"),
    true: replicaDecision(p, "true"),
    false: replicaDecision(p, "false"),
  };
  const real = decisions.real;
  const parity = decisions.parity;
  const realTrue = real !== null && decisions.true !== null && key(real) === key(decisions.true);
  const parityAuto = parity !== null && key(parity) === key(replica.auto);
  const realReplicaTrue = real !== null && key(real) === key(replica.true);
  const parityReplicaAuto = key(parity ?? replica.auto) === key(replica.auto);
  const row = (d: Decision | null | undefined, field: "weightIndex" | "m"): string =>
    d === null || d === undefined
      ? "?"
      : field === "weightIndex"
        ? String(d.weightIndex)
        : `${d.x}/${d.rot}/${d.m}`;
  if (realTrue) realMatchesTrue += 1;
  if (parityAuto) parityMatchesAuto += 1;
  console.log(
    `pop=${p.popcount % 2 === 0 ? "even" : "odd "} ${p.name.padEnd(9)} ` +
      `real=${row(real, "m")}(r${row(real, "weightIndex")}) true=${row(decisions.true, "m")}(r${row(decisions.true, "weightIndex")}) ` +
      `false=${row(decisions.false, "m")}(r${row(decisions.false, "weightIndex")}) parity=${row(parity, "m")}(r${row(parity, "weightIndex")}) | ` +
      `repTrue=${row(replica.true, "m")}(r${row(replica.true, "weightIndex")}) repAuto=${row(replica.auto, "m")}(r${row(replica.auto, "weightIndex")}) | ` +
      `real==true:${realTrue} real==repTrue:${realReplicaTrue} parity==repAuto:${parityReplicaAuto}`,
  );
  rows.push({
    position: p.name,
    popcount: p.popcount,
    parityEven: p.popcount % 2 === 0,
    exe: decisions,
    replica,
    realEqualsIsEven1: realTrue,
    realEqualsReplicaTrue: realReplicaTrue,
    parityEqualsReplicaAuto: parityAuto,
  });
}

writeFileSync(
  new URL("report.json", EVIDENCE),
  `${JSON.stringify(
    {
      positions: POSITIONS.length,
      realMatchesTrue,
      parityMatchesAuto,
      rows,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `\nreal == iseven=1: ${realMatchesTrue}/${POSITIONS.length}; evenodd == replica auto: ${parityMatchesAuto}/${POSITIONS.length}`,
);
process.exit(
  realMatchesTrue === POSITIONS.length && parityMatchesAuto === POSITIONS.length ? 0 : 1,
);
