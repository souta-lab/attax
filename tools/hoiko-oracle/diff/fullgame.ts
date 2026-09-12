/**
 * End-to-end differential: drive the shipping Hoiko.exe (Wine oracle) through a
 * full game and compare its chosen move at EVERY turn against the Rust/WASM
 * replica on the identical snapshot.
 *
 *   bun fullgame.ts [--cap=200] [--seed=1] [--name=seed1-cap200]
 *
 * Design A: one external `wine Hoiko.exe` invocation per move (~1 s each). Each
 * invocation is a fresh process, so the exe runs exactly the verified regime of
 * `diff.ts` (beamSizeLimit 150, timer started -> depth 14). The local game is
 * driven by `src/core/engine.ts` with a fixed seeded piece sequence; the same
 * board/next/hold/combo/b2b snapshot is fed to the exe and to
 * `createRustHoiko(...).searchSnapshot`.
 *
 * Primary verdict: `(x, rotation, m)` per turn, replica pinned to the exe's
 * fresh-process regime (`adapt:false`, beam 150, depth 14). A persistent
 * `adapt:true` (faithful app config) replica is queried on the same snapshot as
 * secondary evidence and recorded, but does not gate the verdict.
 *
 * Artifacts: evidence/hoiko-fullgame/<name>.jsonl, summary-<name>.jsonl,
 * divergence-turn<N>.log (on the first divergent move) and REPORT.md.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { FAITHFUL_HOIKO } from "../../../src/ai/hoiko-faithful.js";
import type { RustHoikoFighter, RustOut } from "../../../src/ai/hoiko-rust-core.js";
import { kindToMino, MINO_NONE } from "../../../src/ai/mino-codes.js";
import { createEngine } from "../../../src/core/engine.js";
import type { CorePort, GameSnapshot } from "../../../src/ui/types.js";
import { ROWS } from "../../../src/ui/types.js";
import { seededRandom } from "../../../src/versus/controller.js";
import { createRustHoiko } from "../../hoiko-rust/loader.js";
import {
  type ExeResult,
  exeHoldUsed,
  nativeRowsOf,
  parseExe,
  rGetDelay,
  rowsEqual,
  runExe,
} from "./exe.js";

const EVIDENCE_DIR = new URL("../../../evidence/hoiko-fullgame/", import.meta.url);

const args = Bun.argv.slice(2);
function argValue(flag: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  return hit === undefined ? undefined : hit.slice(flag.length + 1);
}

const cap = Number.parseInt(argValue("--cap") ?? "200", 10);
const seed = Number.parseInt(argValue("--seed") ?? "1", 10);
if (!Number.isInteger(cap) || cap < 1)
  throw new Error(`--cap must be a positive integer, got ${cap}`);
if (!Number.isInteger(seed)) throw new Error(`--seed must be an integer, got ${seed}`);
const name = argValue("--name") ?? `seed${seed}-cap${cap}`;

interface ApplyResult {
  readonly ok: boolean;
  readonly error: string | null;
  readonly holdUsed: boolean;
  readonly boardMatch: boolean;
  readonly holdMatch: boolean;
  readonly fallPredictMatch: boolean;
  readonly exeFall: number;
  readonly engineFall: number;
  readonly engineCombo: number;
  readonly engineBtb: number;
}

function applyExeMove(core: CorePort, snap: GameSnapshot, exe: ExeResult): ApplyResult {
  const holdUsed = exeHoldUsed(snap, exe);
  if (holdUsed) core.hold();
  const afterHold = core.getSnapshot();
  if (holdUsed && afterHold.active !== null && kindToMino(afterHold.active.kind) !== exe.m) {
    return {
      ok: false,
      error: `hold swap left active=${afterHold.active.kind}, exe placed mino=${exe.m}`,
      holdUsed,
      boardMatch: false,
      holdMatch: false,
      fallPredictMatch: false,
      exeFall: exe.postFallM,
      engineFall: afterHold.active === null ? MINO_NONE : kindToMino(afterHold.active.kind),
      engineCombo: afterHold.nativeCombo,
      engineBtb: afterHold.nativeBtb,
    };
  }
  const rot = ((exe.rot % 4) + 4) % 4;
  const topRow = ROWS - 1 - exe.y;
  const placed = core.placeMinoAt?.(rot, exe.x, topRow, exe.srs) ?? false;
  if (!placed) {
    return {
      ok: false,
      error: `placeMinoAt(rot=${rot}, x=${exe.x}, topRow=${topRow}, srs=${exe.srs}) rejected`,
      holdUsed,
      boardMatch: false,
      holdMatch: false,
      fallPredictMatch: false,
      exeFall: exe.postFallM,
      engineFall: MINO_NONE,
      engineCombo: 0,
      engineBtb: 0,
    };
  }
  const post = core.getSnapshot();
  const postRows = nativeRowsOf(post);
  const postHoldMino = post.hold === null ? MINO_NONE : kindToMino(post.hold);
  const postActiveMino = post.active === null ? MINO_NONE : kindToMino(post.active.kind);
  return {
    ok: true,
    error: null,
    holdUsed,
    boardMatch: rowsEqual(postRows, exe.postBoard.slice(0, postRows.length)),
    holdMatch: postHoldMino === exe.postHold,
    fallPredictMatch: postActiveMino === exe.postFallM,
    exeFall: exe.postFallM,
    engineFall: postActiveMino,
    engineCombo: post.nativeCombo,
    engineBtb: post.nativeBtb,
  };
}

interface RustDecision {
  readonly x: number;
  readonly rot: number;
  readonly m: number;
  readonly act: number;
  readonly moveDelay: number;
  readonly getDelay: number;
  readonly depth: number;
  readonly beam: number;
  readonly useHold: boolean;
  readonly score: number;
}

interface ExeDecision extends RustDecision {
  readonly y: number;
  readonly srs: number;
  readonly postHold: number;
  readonly postCombo: number;
  readonly postBtb: number;
  readonly postAct: number;
  readonly postFallM: number;
}

function rustDecision(res: { readonly out: RustOut } | null): RustDecision | null {
  if (res === null) return null;
  const out = res.out;
  return {
    x: out.x,
    rot: ((out.firstRRaw % 4) + 4) % 4,
    m: out.firstM,
    act: out.firstAct,
    moveDelay: out.moveDelay,
    getDelay: rGetDelay(out.moveDelay, out.firstAct),
    depth: out.depth,
    beam: out.beamSizeLimit,
    useHold: out.useHold === 1,
    score: out.score,
  };
}

function snapshotForDecision(snap: GameSnapshot, combo: number, btb: number): GameSnapshot {
  return { ...snap, nativeCombo: combo, nativeBtb: btb };
}

function queryPrimary(snap: GameSnapshot): RustDecision | null {
  const fighter: RustHoikoFighter = createRustHoiko({ ...FAITHFUL_HOIKO, adapt: false });
  return rustDecision(fighter.searchSnapshot(snap));
}

mkdirSync(EVIDENCE_DIR, { recursive: true });
const jsonlUrl = new URL(`${name}.jsonl`, EVIDENCE_DIR);
writeFileSync(jsonlUrl, "");

const core = createEngine({ random: seededRandom(seed) });
const secondary = createRustHoiko({ ...FAITHFUL_HOIKO });

let combo = 0;
let btb = 0;
let turn = 0;
let matched = 0;
let exeWallTotal = 0;
interface Divergence {
  readonly turn: number;
  readonly reason: string;
  readonly snapshot: unknown;
  readonly exe: ExeDecision | null;
  readonly rust: RustDecision | null;
  readonly exeRaw: string;
  readonly secondary: RustDecision | null;
}
let divergence: Divergence | null = null;
const stateMismatches: unknown[] = [];
const secondaryDiffs: unknown[] = [];
const actDiffs: unknown[] = [];

console.log(
  `fullgame: seed=${seed} cap=${cap} design=A (per-move wine) primary=adapt:false beam150 depth14`,
);

while (turn < cap) {
  const snap = core.getSnapshot();
  if (snap.gameOver || snap.active === null) break;

  const decisionSnap = snapshotForDecision(snap, combo, btb);
  const currentMino = kindToMino(snap.active.kind);
  const queueMinos = snap.next.map(kindToMino);
  const window = [currentMino, ...queueMinos].slice(0, 28);
  while (window.length < 28) window.push(MINO_NONE);
  const boardRows = nativeRowsOf(snap);
  while (boardRows.length < 32) boardRows.push(0);

  const input = [
    `# fullgame turn=${turn} seed=${seed}`,
    `board=${boardRows.map((v) => `0x${(v >>> 0).toString(16)}`).join(",")}`,
    `next=${window.join(",")}`,
    `hold=${snap.hold === null ? MINO_NONE : kindToMino(snap.hold)}`,
    `combo=${combo}`,
    `b2b=${btb}`,
    "timer=1",
    "",
  ].join("\n");

  const run = runExe(input);
  exeWallTotal += run.wallMs;
  const exe = parseExe(run.text, run.wallMs);
  if (!run.ok || exe === null) {
    divergence = {
      turn,
      reason: exe === null ? "oracle output unparsable" : "oracle run failed (no ORACLE_OK)",
      snapshot: { board: boardRows.slice(0, 20), current: currentMino, next: window, combo, btb },
      exe: null,
      rust: null,
      exeRaw: run.text,
      secondary: null,
    };
    writeFileSync(new URL(`failure-turn${turn}.log`, EVIDENCE_DIR), run.text);
    break;
  }

  const primary = queryPrimary(decisionSnap);
  const secondaryDecision = rustDecision(secondary.searchSnapshot(decisionSnap));

  const exeDecision: ExeDecision = {
    x: exe.x,
    y: exe.y,
    rot: ((exe.rot % 4) + 4) % 4,
    m: exe.m,
    srs: exe.srs,
    act: exe.act,
    moveDelay: exe.moveDelay,
    getDelay: exe.getDelay,
    depth: exe.depth,
    beam: exe.beam,
    useHold: exeHoldUsed(snap, exe),
    score: 0,
    postHold: exe.postHold,
    postCombo: exe.postCombo,
    postBtb: exe.postBtb,
    postAct: exe.postAct,
    postFallM: exe.postFallM,
  };

  const moveMatch =
    primary !== null &&
    exe.x === primary.x &&
    exeDecision.rot === primary.rot &&
    exe.m === primary.m;
  const actMatch = primary !== null && exe.act === primary.act;
  const delayMatch = primary !== null && exe.getDelay === primary.getDelay;

  const applied = applyExeMove(core, snap, exe);
  const record = {
    turn,
    piecesPlaced: turn,
    board: boardRows.slice(0, 20),
    current: currentMino,
    queue: window.slice(0, 8),
    hold: snap.hold === null ? MINO_NONE : kindToMino(snap.hold),
    comboIn: combo,
    btbIn: btb,
    exe: exeDecision,
    rust: primary,
    rustAdapt: secondaryDecision,
    match: { move: moveMatch, act: actMatch, moveDelay: delayMatch },
    state: {
      boardMatch: applied.boardMatch,
      holdMatch: applied.holdMatch,
      fallPredictMatch: applied.fallPredictMatch,
      exeFall: applied.exeFall,
      engineFall: applied.engineFall,
      holdUsed: applied.holdUsed,
      error: applied.error,
      engineCombo: applied.engineCombo,
      engineBtb: applied.engineBtb,
      exeCombo: exe.postCombo,
      exeBtb: exe.postBtb,
    },
    exeWallMs: Math.round(run.wallMs),
  };
  appendFileSync(jsonlUrl, `${JSON.stringify(record)}\n`);

  if (!moveMatch) {
    divergence = {
      turn,
      reason: "first move mismatch",
      snapshot: {
        board: boardRows.slice(0, 20),
        current: currentMino,
        queue: window.slice(0, 8),
        hold: snap.hold === null ? MINO_NONE : kindToMino(snap.hold),
        combo,
        btb,
      },
      exe: exeDecision,
      rust: primary,
      exeRaw: run.text,
      secondary: secondaryDecision,
    };
    writeFileSync(new URL(`divergence-turn${turn}.log`, EVIDENCE_DIR), run.text);
    console.log(
      `DIVERGENCE turn=${turn}: exe x=${exe.x} rot=${exeDecision.rot} m=${exe.m} act=${exe.act} | rust x=${primary?.x} rot=${primary?.rot} m=${primary?.m} act=${primary?.act}`,
    );
    break;
  }

  if (!actMatch) actDiffs.push({ turn, exeAct: exe.act, rustAct: primary?.act ?? null });
  if (secondaryDecision !== null) {
    const adaptMatch =
      secondaryDecision.x === exe.x &&
      secondaryDecision.rot === exeDecision.rot &&
      secondaryDecision.m === exe.m;
    if (!adaptMatch) {
      secondaryDiffs.push({
        turn,
        exe: { x: exe.x, rot: exeDecision.rot, m: exe.m },
        rustAdapt: secondaryDecision,
      });
    }
  }

  if (!applied.ok || !applied.boardMatch || !applied.holdMatch) {
    const mismatch = {
      turn,
      error: applied.error,
      holdUsed: applied.holdUsed,
      boardMatch: applied.boardMatch,
      holdMatch: applied.holdMatch,
      fallPredictMatch: applied.fallPredictMatch,
      engineCombo: applied.engineCombo,
      engineBtb: applied.engineBtb,
      exeCombo: exe.postCombo,
      exeBtb: exe.postBtb,
    };
    stateMismatches.push(mismatch);
    if (applied.error !== null) {
      console.log(`STATE ERROR turn=${turn}: ${applied.error}`);
      break;
    }
  }

  combo = exe.postCombo;
  btb = exe.postBtb;
  matched += 1;
  turn += 1;

  if (turn % 10 === 0) {
    console.log(`  ${turn} moves matched (exe ${Math.round(exeWallTotal / 1000)}s)`);
  }
}

const summary = {
  design: "A: per-move external wine invocation (fresh process per move)",
  name,
  seed,
  cap,
  piecesPlayed: turn,
  matchedMoves: matched,
  firstDivergence: divergence,
  primaryOptions: { ...FAITHFUL_HOIKO, adapt: false },
  secondaryOptions: { ...FAITHFUL_HOIKO },
  stateMismatchCount: stateMismatches.length,
  stateMismatches: stateMismatches.slice(0, 20),
  actMismatchCount: actDiffs.length,
  actMismatches: actDiffs.slice(0, 20),
  rustAdaptMoveMismatchCount: secondaryDiffs.length,
  rustAdaptMoveMismatches: secondaryDiffs.slice(0, 20),
  exeWallSeconds: Math.round(exeWallTotal / 1000),
  engine: "src/core/engine.ts seededRandom",
  exeInputProtocol: "board(32)+next(28,current first)+hold+combo+b2b+timer=1",
};
writeFileSync(new URL(`summary-${name}.jsonl`, EVIDENCE_DIR), `${JSON.stringify(summary)}\n`);

const verdict =
  divergence === null
    ? `N/${turn} moves matched: exe and rust (x,rot,m) agreed on all ${turn} pieces (no divergence, ${turn >= cap ? "cap reached" : "game over"})`
    : `FIRST DIVERGENCE at move ${divergence.turn} (1-based piece ${divergence.turn + 1}): ${divergence.reason}; ${matched}/${turn + 1} moves matched before stopping`;
console.log(verdict);
console.log(
  `secondary: actMismatches=${actDiffs.length} stateMismatches=${stateMismatches.length} rustAdaptMoveMismatches=${secondaryDiffs.length}`,
);

const report = [
  "# Full-game differential — shipping Hoiko.exe vs Rust/WASM replica",
  "",
  `Run: \`${name}\` (seed ${seed}, cap ${cap}, design A per-move wine invocation).`,
  "",
  "## Verdict",
  "",
  `**${verdict}**`,
  "",
  "## Setup",
  "",
  "- Exe: shipping `Hoiko.exe` under Wine, one fresh process per move via `tools/hoiko-oracle/run_oracle.sh`.",
  "- Exe inputs per move: `board` (32 bottom-up rows), `next` (28: current first), `hold`, `combo`, `b2b`, `timer=1`.",
  "- Exe regime: `beamSizeLimit=150`, depth 14 (timer started, search ~70 ms << 1000 ms limit).",
  "- Replica (primary verdict): `createRustHoiko({...FAITHFUL_HOIKO, adapt:false})` — beam 150, depth 14, queried on the identical snapshot.",
  "- Replica (secondary): faithful `adapt:true` app config, persistent across moves; recorded but not part of the verdict.",
  "- Local game: `src/core/engine.ts` with `seededRandom(seed)`; the exe's chosen move is applied via `placeMinoAt` (+ `hold()` when the exe's post-move hold slot shows a swap).",
  "",
  "## Results",
  "",
  `- Moves played: **${turn}**; verdict-matched: **${matched}**.`,
  `- First divergence: ${divergence === null ? "none" : `move ${divergence.turn} (${divergence.reason})`}.`,
  `- Engine-vs-exe state mismatches (board/hold after applying the exe move): **${stateMismatches.length}**.`,
  `- act mismatches (with matching move): **${actDiffs.length}**.`,
  `- faithful (adapt:true) replica move mismatches vs exe: **${secondaryDiffs.length}**.`,
  "",
  "Artifacts:",
  "",
  `- \`${name}.jsonl\` — per-move raw records (snapshot, exe, rust, rustAdapt, state).`,
  `- \`summary-${name}.jsonl\` — machine-readable summary (one JSON object).`,
  divergence === null
    ? ""
    : `- \`divergence-turn${divergence.turn}.log\` — full exe output for the divergent move.`,
  "",
].join("\n");
writeFileSync(new URL("REPORT.md", EVIDENCE_DIR), report);
console.log(`artifacts: evidence/hoiko-fullgame/${name}.jsonl`);
