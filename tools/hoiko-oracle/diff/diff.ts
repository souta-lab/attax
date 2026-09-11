import { writeFileSync } from "fs";
import { POSITIONS, type Position } from "./positions.js";
import {
  defaultSearchState,
  searchNative,
  expandNode,
} from "../../../src/ai/native/index.js";
import { getDelay } from "../../../src/ai/native/search.js";
import type { PieceKind } from "../../../src/core/pieces.js";
import type { NativeSearchOptions } from "../../../src/ai/native/index.js";

const ORACLE_INPUT = "../run/oracle_input.txt";
const ORACLE_SCRIPT = "../run_oracle.sh";

const KIND: Record<number, PieceKind> = {
  0: "I", 1: "J", 2: "L", 3: "O", 4: "T", 5: "S", 6: "Z",
};

export interface OracleResult {
  readonly ok: boolean;
  readonly x: number;
  readonly y: number;
  readonly rot: number;
  readonly m: number;
  readonly depth: number;
  readonly beam: number;
  readonly getDelay: number | null;
  readonly rootMoveDelay: number | null;
  readonly rootAct: number | null;
  readonly raw: string;
}

function parseOracle(text: string): OracleResult {
  const fm = text.match(/firstMove @\+?456:\s*x=(-?\d+)\s+y=(-?\d+)\s+rot=(-?\d+)\s+m=(-?\d+)/);
  const depth = text.match(/depth\s+@\+?444\s*=\s*(-?\d+)/);
  const beam = text.match(/beamLimit\s+@\+?452\s*=\s*(-?\d+)/);
  const delay = text.match(/GetDelay\s*=\s*(-?\d+)/);
  const rootMd = text.match(/moveDelay @400\s*=\s*(-?\d+)/);
  const rootAct = text.match(/act\s+@416\s*=\s*(-?\d+)/);
  if (!fm || !depth || !beam) {
    return { ok: false, x: 0, y: 0, rot: 0, m: 0, depth: 0, beam: 0, getDelay: null, rootMoveDelay: null, rootAct: null, raw: text };
  }
  return {
    ok: true,
    x: Number(fm[1]), y: Number(fm[2]), rot: Number(fm[3]), m: Number(fm[4]),
    depth: Number(depth[1]), beam: Number(beam[1]),
    getDelay: delay ? Number(delay[1]) : null,
    rootMoveDelay: rootMd ? Number(rootMd[1]) : null,
    rootAct: rootAct ? Number(rootAct[1]) : null,
    raw: text,
  };
}

export function runOracle(p: Position, startTimer: boolean): OracleResult {
  const boardHex = p.board.map((v) => "0x" + (v >>> 0).toString(16)).join(",");
  const nextCsv = p.next.join(",");
  const timerLine = startTimer ? "timer=1\n" : "";
  const input = `# ${p.name}: ${p.note}\nboard=${boardHex}\nnext=${nextCsv}\n${timerLine}`;
  writeFileSync(ORACLE_INPUT, input);
  const proc = Bun.spawnSync(["bash", ORACLE_SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120000,
    env: { ...process.env, WINEPREFIX: "../prefix", WINEDEBUG: "-all" },
  });
  const text = proc.stdout.toString() + "\n" + proc.stderr.toString();
  return parseOracle(text);
}

export interface TsResult {
  readonly x: number;
  readonly rot: number;
  readonly m: number;
  readonly hold: boolean;
  readonly depth: number;
  readonly score: number;
  readonly firstAct: number;
  readonly moveDelay: number;
  readonly childMoveDelay: number;
  readonly childAct: number;
}

export function runTs(p: Position, depth14: boolean): TsResult | null {
  const current = KIND[p.next[0] ?? 0] ?? "I";
  const queue = p.next.slice(1).map((v) => KIND[v] ?? "I");
  const input = { board: p.board, current, queue, hold: null, combo: 0, btb: 0 };
  const st = defaultSearchState();
  st.minDepth = 10;
  const options: NativeSearchOptions = {
    searchState: st,
    timeLimitMs: depth14 ? Number.POSITIVE_INFINITY : 0,
    adapt: false,
    feedQueue: false,
  };
  const run = searchNative(input, options);
  if (run === null) return null;
  const o = run.outcome;
  const kids = expandNode(run.root, true);
  const rot = ((o.firstR % 4) + 4) % 4;
  const sameMove = (k: { holdUsed: boolean; placedR: number; placedX: number; game: { commands: { moveDelay: number } } }) =>
    k.holdUsed === o.firstHold && k.placedR === rot && k.placedX === o.firstX;
  const match =
    kids.find((k) => sameMove(k) && k.game.commands.moveDelay === o.moveDelay) ??
    kids.find(sameMove);
  return {
    x: o.firstX,
    rot: ((o.firstR % 4) + 4) % 4,
    m: o.firstM,
    hold: o.firstHold,
    depth: o.depth,
    score: o.score,
    firstAct: o.firstAct,
    moveDelay: o.moveDelay,
    childMoveDelay: match?.game.commands.moveDelay ?? -1,
    childAct: match?.act ?? -1,
  };
}

function fmt(o: OracleResult): string {
  if (!o.ok) return "ORACLE-FAIL";
  return `x=${o.x} rot=${o.rot} m=${o.m} depth=${o.depth} beam=${o.beam} delay=${o.getDelay}`;
}

function fmtTs(t: TsResult | null): string {
  if (t === null) return "TS-NULL";
  return `x=${t.x} rot=${t.rot} m=${t.m} depth=${t.depth} score=${t.score} firstMoveDelay=${t.moveDelay} childMD=${t.childMoveDelay} childAct=${t.childAct} hold=${t.hold}`;
}

const args = process.argv.slice(2);
const startTimer = args.includes("--timer");
const only = args.filter((a) => !a.startsWith("--"));
const list = only.length > 0 ? POSITIONS.filter((p) => only.includes(p.name)) : POSITIONS;

let mismatches = 0;
for (const p of list) {
  const o = runOracle(p, startTimer);
  const t = runTs(p, startTimer);
  const moveMatch = o.ok && t !== null && o.x === t.x && o.rot === t.rot && o.m === t.m;
  const childDelay = t === null ? -1 : getDelay(t.childMoveDelay, t.childAct as 0);
  const outcomeDelay = t === null ? -1 : getDelay(t.moveDelay, t.firstAct as 0);
  const delayMatch = o.getDelay === childDelay && o.getDelay === outcomeDelay;
  if (!moveMatch) mismatches += 1;
  console.log(
    `${moveMatch ? "MATCH  " : "MISMATCH"} ${p.name.padEnd(14)} | oracle ${fmt(o)} rootMd=${o.rootMoveDelay} rootAct=${o.rootAct} | ts ${fmtTs(t)} childGetDelay=${childDelay} outcomeGetDelay=${outcomeDelay} ${delayMatch ? "OK" : "NO"}`,
  );
  console.log("  oracle raw firstMove: " + (o.raw.match(/firstMove @\+?456:[^\n]*/) ?? ["<none>"])[0]);
}
console.log(`\n${list.length - mismatches}/${list.length} first-move match${startTimer ? " (timer started => depth 14)" : " (depth 10)"}`);
process.exit(mismatches === 0 ? 0 : 1);
