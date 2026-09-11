/**
 * Two-search oracle check: after search 1, the binary's SetNextOption sets the
 * global beamSizeLimit from RootNode.GetDelay(root1) = (gen-1 moveDelay + clear*16).
 * The second search then reports that adapted beam at @452.
 *
 *   bun ./twosearch.ts [positionName ...]
 */

import { writeFileSync } from "fs";
import { POSITIONS, type Position } from "./positions.js";
import {
  defaultSearchState,
  searchNative,
  expandNode,
} from "../../../src/ai/native/index.js";
import { getDelay, type SearchState } from "../../../src/ai/native/search.js";
import type { PieceKind } from "../../../src/core/pieces.js";

const ORACLE_INPUT = "../run/oracle_input.txt";
const ORACLE_SCRIPT = "../run_oracle.sh";
const KIND: Record<number, PieceKind> = { 0: "I", 1: "J", 2: "L", 3: "O", 4: "T", 5: "S", 6: "Z" };

interface OracleTwo {
  readonly getDelay1: number;
  readonly beam2: number;
  readonly raw: string;
}

function runOracleTwo(p: Position): OracleTwo {
  const boardHex = p.board.map((v) => "0x" + (v >>> 0).toString(16)).join(",");
  writeFileSync(
    ORACLE_INPUT,
    `# ${p.name}: ${p.note}\nboard=${boardHex}\nnext=${p.next.join(",")}\ntwosearch=1\n`,
  );
  const proc = Bun.spawnSync(["bash", ORACLE_SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120000,
    env: { ...process.env, WINEPREFIX: "../prefix", WINEDEBUG: "-all" },
  });
  const raw = proc.stdout.toString() + "\n" + proc.stderr.toString();
  const md = raw.match(/GetDelay\s*=\s*(-?\d+)/);
  const b2 = raw.match(/search2 beamLimit @452\s*=\s*(-?\d+)/);
  return { getDelay1: md ? Number(md[1]) : -1, beam2: b2 ? Number(b2[1]) : -1, raw };
}

interface TsAdapt {
  readonly leafMoveDelay: number;
  readonly firstMoveDelay: number;
  readonly firstAct: number;
  readonly beamAfter: number;
  readonly timerAfter: number;
}

function runTsAdapt(p: Position): TsAdapt {
  const input = {
    board: p.board,
    current: KIND[p.next[0] ?? 0] ?? "I",
    queue: p.next.slice(1).map((v) => KIND[v] ?? "I"),
    hold: null,
    combo: 0,
    btb: 0,
  };
  const st: SearchState = defaultSearchState();
  st.minDepth = 10;
  const run = searchNative(input, { searchState: st, timeLimitMs: 0, adapt: true, feedQueue: false });
  const o = run!.outcome;
  const kids = expandNode(run!.root, true);
  const rot = ((o.firstR % 4) + 4) % 4;
  const sameMove = (k: { holdUsed: boolean; placedR: number; placedX: number; game: { commands: { moveDelay: number } } }) =>
    k.holdUsed === o.firstHold && k.placedR === rot && k.placedX === o.firstX;
  const match =
    kids.find((k) => sameMove(k) && k.game.commands.moveDelay === o.moveDelay) ??
    kids.find(sameMove);
  return {
    leafMoveDelay: o.moveDelay,
    firstMoveDelay: match?.game.commands.moveDelay ?? -1,
    firstAct: o.firstAct,
    beamAfter: st.beamSizeLimit,
    timerAfter: st.timerLimitMs,
  };
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const list = only.length > 0 ? POSITIONS.filter((p) => only.includes(p.name)) : POSITIONS;
for (const p of list) {
  const o = runOracleTwo(p);
  const t = runTsAdapt(p);
  const getDelayFromLeaf = getDelay(t.leafMoveDelay, t.firstAct as 0);
  const postFixMoveDelay = t.firstMoveDelay; // = first move's own moveDelay
  const postFixTimer = getDelay(postFixMoveDelay, t.firstAct as 0) - 5;
  const postFixBeamRaw = Math.trunc((50 * postFixTimer) / 112);
  const postFixBeam = Math.min(postFixBeamRaw, 150);
  console.log(
    `${p.name.padEnd(14)} | oracle GetDelay1=${o.getDelay1} beam2=${o.beam2} | ts leafGetDelay=${getDelayFromLeaf} beamAfter=${t.beamAfter} timerAfter=${t.timerAfter} | firstMoveDelay=${postFixMoveDelay} postFixGetDelay=${getDelay(postFixMoveDelay, t.firstAct as 0)} postFixBeam=${postFixBeam} match=${o.beam2 === postFixBeam ? "OK" : "NO"}`,
  );
}
