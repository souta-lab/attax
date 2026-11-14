/**
 * Next-queue carry differential.
 *
 * The versus game mutates its persistent `NextMino` once per turn through
 * `RootNode.SetPPTData` (`NextMino.ShiftNext` + `NextMino.Compare(0, live)` +
 * `SetNewCurrent`, IL 7045). The stub key `shiftnext=N` replays exactly that
 * per-turn mutation N times after `RootNode.Init`, so this tool measures two
 * things:
 *
 *  1. whether the carried bag/trust state changes the exe's chosen move
 *     (13/13 probe positions are shift-sensitive), and
 *  2. whether the TS state machine (`src/ai/hoiko-next.ts`) reproduces the
 *     binary's per-shift `m[0..9]`, `trustEnd` and `bagRemains` exactly.
 *
 *   bun nextcarry.ts                # all positions x shifts 0..7 (Wine + TS check)
 *   bun nextcarry.ts --ts-only      # TS check against the recorded report.json
 *   bun nextcarry.ts --shifts=0,1
 *
 * Evidence: evidence/hoiko-inputs/nextcarry/.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { NextState } from "../../../src/ai/hoiko/next.js";
import { runExe } from "./exe.js";
import { POSITIONS, type Position } from "./positions.js";

const ORACLE_RUN = process.env.HOIKO_ORACLE_RUN ?? "/tmp/opencode/oracle/run";
const EVIDENCE = new URL("../../../evidence/hoiko-inputs/nextcarry/", import.meta.url);
mkdirSync(EVIDENCE, { recursive: true });

const shiftArg = process.argv.find((a) => a.startsWith("--shifts="));
const SHIFTS = shiftArg
  ? shiftArg
      .slice("--shifts=".length)
      .split(",")
      .map((v) => Number.parseInt(v, 10))
  : [0, 1, 2, 3, 4, 5, 6, 7];
const TS_ONLY = process.argv.includes("--ts-only");

const BAG = [6, 5, 4, 3, 1, 2, 0];
function queueWithTAt(offset: number): number[] {
  const q: number[] = [];
  for (let i = 0; i < 27; i += 1) q.push(BAG[(i + 3) % 7] ?? 0);
  q[offset] = 4;
  return q;
}

function extraPositions(): Position[] {
  return [2, 3, 4, 5].map((offset) => ({
    name: `t-offset${offset}`,
    board: [],
    next: queueWithTAt(offset),
    note: `T at queue offset ${offset}`,
  }));
}

interface ExeDecision {
  readonly x: number;
  readonly rot: number;
  readonly m: number;
  readonly depth: number;
  readonly trustEnd: number;
  readonly remains: number;
  readonly move0: number[];
}

function parseDecision(text: string): ExeDecision | null {
  const fm = text.match(/firstMove @\+?456:\s*x=(-?\d+)\s+y=(-?\d+)\s+rot=(-?\d+)\s+m=(-?\d+)/);
  const nd = text.match(/NEXTDUMP shift=\d+ m=([-\d,]+) trustEnd=(-?\d+) remains=(-?\d+)/);
  if (fm === null || nd === null) return null;
  return {
    x: Number(fm[1]),
    rot: Number(fm[3]),
    m: Number(fm[4]),
    depth: Number(text.match(/depth\s+@\+?444\s*=\s*(-?\d+)/)?.[1] ?? -1),
    trustEnd: Number(nd[2]),
    remains: Number(nd[3]),
    move0: (nd[1] ?? "").split(",").map(Number),
  };
}

function runCase(p: Position, shift: number): ExeDecision | null {
  const board = [...p.board];
  while (board.length < 32) board.push(0);
  const input = [
    `# nextcarry ${p.name} shift=${shift}`,
    `board=${board.map((v) => `0x${(v >>> 0).toString(16)}`).join(",")}`,
    `next=${p.next.join(",")}`,
    `shiftnext=${shift}`,
    "nextdump=2",
    "",
  ].join("\n");
  const run = runExe(input);
  writeFileSync(new URL(`${p.name}-shift${shift}.log`, EVIDENCE), run.text);
  return run.ok ? parseDecision(run.text) : null;
}

/**
 * TS equivalent of the stub replay: `NextMino.Init(padded)` then N times
 * `ShiftNext; Compare(0, padded)` (the per-turn `SetPPTData` pair). Returns the
 * fields the stub dumps: full `m[28]`, `trustEnd`, `bagRemains`.
 */
function tsState(
  next: readonly number[],
  shift: number,
  viewNext = 2,
): { readonly m: number[]; readonly trustEnd: number; readonly remains: number } {
  const padded: number[] = [];
  for (let i = 0; i < 28; i += 1) padded.push(next[i % next.length] ?? 0);
  const nn = new NextState(viewNext);
  nn.init(padded);
  for (let s = 0; s < shift; s += 1) {
    nn.shiftNext();
    nn.compare(0, padded);
  }
  return { m: [...nn.m], trustEnd: nn.trustEnd, remains: nn.bagRemains };
}

interface Row {
  readonly position: string;
  readonly sensitive: boolean;
  readonly decisions: Record<string, number[]>;
  readonly states: Record<string, string[]>;
  readonly tsMatch: boolean;
  readonly tsMismatches: string[];
}

function compareTs(p: Position, shift: number, exe: ExeDecision): string[] {
  const ts = tsState(p.next, shift);
  const mismatches: string[] = [];
  const depth = exe.move0.length;
  const exeM = exe.move0.join(",");
  const tsM = ts.m.slice(0, depth).join(",");
  if (tsM !== exeM) mismatches.push(`m: exe=${exeM} ts=${tsM}`);
  if (ts.trustEnd !== exe.trustEnd) {
    mismatches.push(`trustEnd: exe=${exe.trustEnd} ts=${ts.trustEnd}`);
  }
  if (ts.remains !== exe.remains) {
    mismatches.push(`remains: exe=${exe.remains} ts=${ts.remains}`);
  }
  return mismatches;
}

const positions = [...POSITIONS, ...extraPositions()];

if (TS_ONLY) {
  const reportPath = new URL("report.json", EVIDENCE);
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as { rows: Row[] };
  let bad = 0;
  for (const row of report.rows) {
    const p = positions.find((x) => x.name === row.position);
    if (p === undefined) throw new Error(`report position ${row.position} not in positions.ts`);
    for (const [shiftText, state] of Object.entries(row.states)) {
      const shift = Number.parseInt(shiftText, 10);
      const m = (state[2] ?? "").replace("m=", "").split(",").map(Number);
      const exe: ExeDecision = {
        x: 0,
        rot: 0,
        m: 0,
        depth: -1,
        trustEnd: Number((state[0] ?? "").replace("trustEnd=", "")),
        remains: Number((state[1] ?? "").replace("remains=", "")),
        move0: m,
      };
      const mismatches = compareTs(p, shift, exe);
      if (mismatches.length > 0) {
        bad += 1;
        console.log(`TS-MISMATCH ${row.position} shift=${shift}: ${mismatches.join("; ")}`);
      }
    }
  }
  console.log(bad === 0 ? "TS NextState matches all recorded exe states" : `${bad} TS mismatches`);
  process.exit(bad === 0 ? 0 : 1);
}

let sensitive = 0;
const rows: Row[] = [];

for (const p of positions) {
  const decisions = new Map<string, number[]>();
  const states = new Map<number, string[]>();
  let tsMatch = true;
  const tsMismatches: string[] = [];
  for (const shift of SHIFTS) {
    const d = runCase(p, shift);
    if (d === null) throw new Error(`no decision for ${p.name} shift=${shift} (see ${ORACLE_RUN})`);
    const key = `${d.x}/${d.rot}/${d.m}`;
    const list = decisions.get(key) ?? [];
    list.push(shift);
    decisions.set(key, list);
    states.set(shift, [`trustEnd=${d.trustEnd}`, `remains=${d.remains}`, `m=${d.move0.join(",")}`]);
    const mismatches = compareTs(p, shift, d);
    if (mismatches.length > 0) {
      tsMatch = false;
      tsMismatches.push(`shift=${shift} ${mismatches.join("; ")}`);
    }
  }
  const isSensitive = decisions.size > 1;
  if (isSensitive) sensitive += 1;
  const summary = [...decisions.entries()]
    .map(([key, shifts]) => `(${key})@${shifts.join(",")}`)
    .join(" ");
  console.log(`${isSensitive ? "SENSITIVE" : "stable   "} ${p.name.padEnd(14)} ${summary}`);
  if (!tsMatch) console.log(`  TS-MISMATCH: ${tsMismatches.join(" | ")}`);
  rows.push({
    position: p.name,
    sensitive: isSensitive,
    decisions: Object.fromEntries(decisions),
    states: Object.fromEntries(states),
    tsMatch,
    tsMismatches,
  });
}

const tsMatched = rows.filter((row) => row.tsMatch).length;
console.log(`\n${sensitive}/${positions.length} positions shift-sensitive`);
console.log(`TS NextState matches exe: ${tsMatched}/${positions.length} positions`);
writeFileSync(
  new URL("report.json", EVIDENCE),
  `${JSON.stringify({ shifts: SHIFTS, sensitive, total: positions.length, tsMatched, rows }, null, 2)}\n`,
);
process.exit(tsMatched === positions.length ? 0 : 1);
