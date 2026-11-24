/**
 * TBP (Tetris Bot Protocol) adapter for Hoiko (Rust/WASM replica).
 *
 * Speaks TBP on stdin/stdout so intetrigence's `external-arena` referee can host
 * the Hoiko replica (`src/ai/hoiko` RustHoikoEngine over `rust/hoiko-core`).
 * State is tracked from TBP messages only (start / play / new_piece); every
 * decision is one `RustHoikoEngine.search` on a RawSearchRequest built from
 * that state. The adapter only translates between the protocol and the engine:
 *
 *   TBP board: 40 rows, row 0 = bottom, cells null | "G".
 *   Hoiko native board: up to 32 bottom-up rows, column c = bit (9-c).
 *   Engine placement (x, rotation, y) -> snapshot cells via `cellsFor`, with
 *   topRow = 19 - y (the versus harness's oracle-verified conversion), then
 *   matched against every TBP orientation of the same piece (Cold Clear
 *   convention), exactly like `tbp/attax-tbp.ts`. The referee accepts the first
 *   suggestion that is in its own move list, so the engine's spin label (from
 *   its ClearAct) is listed first, then the other spin labels.
 *
 * Configuration: Souta's Hoiko GUI settings of 2026-11-24 (the "strongest"
 * preset), mapped through the shipping binary's `config.dll` keys
 * (tools/hoiko-oracle/REFERENCE.md §1, SPEC_Search.md §2.1):
 *
 *   Opt1  player=2        -> playerNo [0,3]: outer-app seat assignment in
 *                            PPT2; no consumer in Search/Evaluate, so no
 *                            engine parameter exists. Not applicable to TBP.
 *   Opt1  next=12         -> viewNext [2,12] = 12 (engine viewNext).
 *   Opt1  speed=100       -> speed: drives only the outer game poll in the
 *                            binary (SPEC_Search.md §25/§545: no search
 *                            effect). The TBP host drives the pace. N/A.
 *   Opt1  thread=2        -> threadCount [1,2] = 2. hoiko-core is a
 *                            single-threaded deterministic port, but the
 *                            binary derives beamSizeLimit =
 *                            min(1500, threadCount*beamSize*3) = 300 from it;
 *                            that derived value is the engine parameter.
 *   Opt1  pad接続 ON      -> gamepad connection of the original app. N/A.
 *   Opt2  hold ON         -> useHold = true (engine allowHold).
 *   Opt2  自動選択 ON     -> autoSelect / autoCharSelect: PPT2 character
 *                            screen automation; no Search/Evaluate consumer.
 *                            N/A.
 *   Opt2  相殺外し ON     -> useOffsetOff = true (engine offset option).
 *   Opt2  TD open OFF     -> useTDOpeners = false. The binary gate is
 *                            viewNext>=5 && useHold && useTDOpeners, so
 *                            TemplateAI/OpSearch stays off; the core search
 *                            has no TD-opener path, matching OFF.
 *   Opt2  PC stack OFF    -> usePCstack = false.
 *   Opt2  S4W OFF         -> useS4W = false.
 *   Opt2  TD loop OFF     -> loopTemplate = false (TemplateAI config; the
 *                            core search has no template loop, matching OFF).
 *   Opt3 (not shown)      -> playStyle=0 (Vs, weight list [we, wo, wd, wr]),
 *                            beamSize=50 (maxBeamSize), minDepth=10,
 *                            depthLimit=14, takeOverTime=5: the shipping
 *                            defaults, kept.
 *
 * Protocol information limits (inherent to TBP, same as the Attax adapter):
 *   - No opponent state is ever sent, so the versus statics the binary fills
 *     from ObserveOpponent (opponent board / combo) stay at their zero
 *     values; multiEvaluation is set (versus) but its opponent branches are
 *     inert without that data.
 *   - No incoming-garbage notice exists; the referee resyncs with stop+start
 *     after a garbage rise. Pending garbage is therefore always 0 and the
 *     offset driver's garbage-wait answer cannot be honoured by the protocol
 *     (a suggestion must be returned); it is logged, not acted on. Offset
 *     state never feeds the search itself, so move choice is unaffected.
 *   - The referee reveals only the current piece + 5 previews (queue is kept
 *     at 6), while viewNext=12 makes the engine pin 12 queue entries. Entries
 *     past the revealed window are filled with the engine's own NextMino bag
 *     model via an adapter-side replica of its NextState, so the trusted
 *     window is exactly the host-revealed pieces and the rest is Hoiko's own
 *     prediction — the same role the bag model plays past viewNext in the
 *     binary. A resync start replaces board/queue/hold/combo state but keeps
 *     the engine's carried search state, mirroring the referee client's
 *     intent ("preserves the opponent's search state").
 *
 * Env: HOIKO_TBP_LOG (optional JSONL decision log path),
 *      HOIKO_TBP_ADAPT ("0" pins the beam for reproducible runs; default on,
 *      the shipping SetNextOption behaviour),
 *      HOIKO_TBP_BEAM (beamSizeLimit override; default 300 from thread=2),
 *      HOIKO_TBP_VIEW_NEXT (viewNext override; default 12).
 */
import { appendFileSync, readFileSync } from "node:fs";
import { type RawSearchRequest, RustHoikoEngine, type SyncFields } from "../src/ai/hoiko/engine.ts";
import { kindToMino, MINO_NONE, type MinoType } from "../src/ai/hoiko/mino-codes.ts";
import { NextState } from "../src/ai/hoiko/next.ts";
import { nativePopCount, nativeStackHeight } from "../src/ai/hoiko/opponent.ts";
import { attackForClear, type TspinAttackKind } from "../src/core/garbage.ts";
import { cellsFor } from "../src/core/pieces.ts";
import type { LockAction } from "../src/core/types.ts";

const LOG = process.env.HOIKO_TBP_LOG;

// ---- configuration (Souta's 2026-11-24 Hoiko settings; see header) ----------------------
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer, got ${raw}`);
  return value;
}
const VIEW_NEXT = Math.min(12, Math.max(2, envInt("HOIKO_TBP_VIEW_NEXT", 12)));
const BEAM_SIZE_LIMIT = envInt("HOIKO_TBP_BEAM", 300); // min(1500, threadCount 2 * beamSize 50 * 3)
const ADAPT = process.env.HOIKO_TBP_ADAPT !== "0";
const USE_HOLD = true;

const wasmBytes = readFileSync(new URL("../src/ai/hoiko/hoiko_core.wasm", import.meta.url));
const wasmInstance = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes), {});
const engine = new RustHoikoEngine(wasmInstance, {
  weightPreset: "we", // playStyle 0 (Vs): weight list [we, wo, wd, wr]
  beamSizeLimit: BEAM_SIZE_LIMIT,
  maxBeamSize: 50, // beamSize default (Opt3 not shown)
  adapt: ADAPT,
  depthLimit: 14,
  viewNext: VIEW_NEXT,
  useS4W: false,
  usePCstack: false,
  versus: true,
  nextCarry: true,
  evenMode: "auto",
  offset: true, // useOffsetOff ON
});

// ---- TBP geometry (Cold Clear convention, shared with tbp/attax-tbp.ts) -----------------
type Kind = "I" | "O" | "T" | "S" | "Z" | "J" | "L";
type Spin = "none" | "mini" | "full";
interface Loc {
  type: Kind;
  orientation: "north" | "east" | "south" | "west";
  x: number;
  y: number;
}
interface TbpMove {
  location: Loc;
  spin: Spin;
}

const CC_CELLS: Record<Kind, [number, number][]> = {
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
const ORIENTS = ["north", "east", "south", "west"] as const;
function rotateCell(o: (typeof ORIENTS)[number], [x, y]: [number, number]): [number, number] {
  switch (o) {
    case "north":
      return [x, y];
    case "east":
      return [y, -x];
    case "south":
      return [-x, -y];
    case "west":
      return [-y, x];
  }
}
const cellKey = (cells: [number, number][]) =>
  cells
    .map(([x, y]) => `${x},${y}`)
    .sort()
    .join(";");

/** All TBP locations whose cells equal `cells` (absolute, TBP coords). */
function tbpLocations(kind: Kind, cells: [number, number][]): Loc[] {
  const target = cellKey(cells);
  const anchor = [...cells].sort((a, b) => a[1] - b[1] || a[0] - b[0])[0];
  if (!anchor) return [];
  const out: Loc[] = [];
  for (const o of ORIENTS) {
    const offs = CC_CELLS[kind].map((c) => rotateCell(o, c));
    const a = [...offs].sort((p, q) => p[1] - q[1] || p[0] - q[0])[0];
    if (!a) continue;
    const cx = anchor[0] - a[0];
    const cy = anchor[1] - a[1];
    if (cellKey(offs.map(([x, y]) => [x + cx, y + cy])) === target) {
      out.push({ type: kind, orientation: o, x: cx, y: cy });
    }
  }
  return out;
}

const KIND_BY_MINO: Readonly<Record<number, Kind>> = {
  0: "I",
  1: "J",
  2: "L",
  3: "O",
  4: "T",
  5: "S",
  6: "Z",
};

/** Engine ClearAct -> TBP spin label (T-spin mini is act 8, TSM). */
function spinForAct(act: number): Spin {
  if (act === 8) return "mini";
  if (act === 5 || act === 6 || act === 7) return "full";
  return "none";
}

// ---- tracked game state (TBP coordinates) ------------------------------------------------
let rows: boolean[][] = []; // rows[y][x], y = 0 bottom, 40 rows
let queue: Kind[] = [];
let holdKind: Kind | null = null;
let started = false;
let stopSeen = false;
// Hoiko-native lock bookkeeping (Others.Totaling conventions).
let nativeCombo = 0;
let nativeBtb = 0;
let chainClears = 0; // referee-style consecutive-clear count, for attack computation
let lockId = 0;
let lastAction: LockAction = "None";
let lastAttack = 0;
// Adapter-side replica of the engine's NextState, used only to fill the
// unrevealed part of the viewNext window with the engine's own bag model.
let replica = new NextState(VIEW_NEXT);
let replicaSearches = 0;
let replicaPrevUsedHold = false;

function setBoard(board: (string | null)[][]) {
  rows = Array.from({ length: 40 }, (_, y) =>
    Array.from({ length: 10 }, (_, x) => (board[y]?.[x] ?? null) !== null),
  );
}

function boardIsEmpty(board: (string | null)[][]): boolean {
  return board.every((row) => (row ?? []).every((c) => c === null || c === undefined));
}

/** Native rows for the engine: bottom-up, column c = bit (9-c), up to 32 rows. */
function nativeRows(): number[] {
  const out: number[] = [];
  for (let y = 0; y < 32; y += 1) {
    let bits = 0;
    const row = rows[y];
    if (row) for (let x = 0; x < 10; x += 1) if (row[x]) bits |= 1 << (9 - x);
    out.push(bits);
  }
  return out;
}

function isEvenBoard(native: readonly number[]): boolean {
  return nativePopCount(native, nativeStackHeight(native)) % 2 === 0;
}

// ---- state transitions -------------------------------------------------------------------
function resetMatch() {
  engine.resetMatchState();
  replica = new NextState(VIEW_NEXT);
  replicaSearches = 0;
  replicaPrevUsedHold = false;
  lockId = 0;
  lastAction = "None";
  lastAttack = 0;
}

function onStart(msg: {
  board: (string | null)[][];
  queue: Kind[];
  hold?: Kind | null;
  combo?: number;
  back_to_back?: boolean;
}) {
  const fresh =
    boardIsEmpty(msg.board) &&
    (msg.hold ?? null) === null &&
    (msg.combo ?? 0) === 0 &&
    !msg.back_to_back;
  // A start preceded by stop is the referee's garbage resync: it must keep the
  // engine's carried search state. A fresh-looking start with no stop before
  // it begins a new match (the binary re-runs Init per match).
  if (!started || (fresh && !stopSeen)) resetMatch();
  setBoard(msg.board);
  queue = [...msg.queue];
  holdKind = msg.hold ?? null;
  nativeCombo = msg.combo ?? 0;
  nativeBtb = msg.back_to_back ? 1 : 0;
  chainClears = msg.combo ?? 0;
  lastAction = "None";
  lastAttack = 0;
  started = true;
  stopSeen = false;
}

function applyPlay(mv: TbpMove) {
  const kind = mv.location.type;
  const current = queue.shift();
  if (kind !== current) {
    const prevHold = holdKind;
    holdKind = current ?? null;
    if (prevHold === null) queue.shift();
  }
  const offs = CC_CELLS[kind].map((c) => rotateCell(mv.location.orientation, c));
  for (const [dx, dy] of offs) {
    const r = rows[mv.location.y + dy];
    if (r) r[mv.location.x + dx] = true;
  }
  const kept = rows.filter((r) => !r.every(Boolean));
  const lines = 40 - kept.length;
  while (kept.length < 40) kept.push(Array(10).fill(false));
  rows = kept;

  const pc = lines > 0 && rows.every((r) => !r.some(Boolean));
  const tspin: TspinAttackKind = kind === "T" ? mv.spin : "none";
  // Attack of this lock, from the pre-lock state (feeds only the offset
  // driver's bookkeeping via sync; it cannot change any suggestion).
  lastAttack = attackForClear({
    lines,
    tspinLines: tspin !== "none" ? lines : 0,
    combo: chainClears,
    b2bActive: nativeBtb > 0,
    perfectClear: pc,
    tspinKind: tspin,
  });
  // Native Others.Totaling transitions, mirrored from the played move.
  if (lines === 0) {
    nativeCombo = nativeCombo > 0 ? -nativeCombo : 0;
    chainClears = 0;
    lastAction = "None";
  } else {
    if (nativeCombo < 0) nativeCombo = 0;
    if (pc) {
      nativeBtb = lines >= 4 ? nativeBtb + 1 : 0;
      lastAction = "Pc";
    } else if (lines >= 4) {
      nativeBtb += 1;
      lastAction = "Quad";
    } else if (tspin === "full") {
      nativeBtb += 1;
      lastAction = lines === 1 ? "Tss" : lines === 2 ? "Tsd" : "Tst";
    } else if (tspin === "mini") {
      nativeBtb += 1;
      lastAction = "Tsm";
    } else {
      nativeBtb = 0;
      lastAction = lines === 1 ? "Single" : lines === 2 ? "Double" : "Triple";
    }
    nativeCombo += 1;
    chainClears += 1;
  }
  lockId += 1;
}

// ---- decision ------------------------------------------------------------------------------
/** The engine's bag sequence (NextMino fill): Z,S,T,O,J,L,I repeating. */
const BAG_FILL: readonly MinoType[] = [6, 5, 4, 3, 1, 2, 0];

/**
 * Build the live queue (mino codes) the engine will pin: the host-revealed
 * pieces first, then the replica NextState's own model values up to viewNext.
 * Applies the same per-search transition the engine applies internally
 * (init on the first search, ShiftNext per consumed piece plus one extra
 * after a hold, then Compare) so the replica never drifts from the engine.
 */
function buildLive(known: MinoType[]): MinoType[] {
  const live: MinoType[] = [...known];
  if (replicaSearches === 0) {
    while (live.length < VIEW_NEXT) live.push(BAG_FILL[live.length % BAG_FILL.length] as MinoType);
    replica.init(live);
  } else {
    replica.shiftNext();
    if (replicaPrevUsedHold) replica.shiftNext();
    while (live.length < VIEW_NEXT) {
      live.push(replica.at(live.length) as MinoType);
    }
    replica.compare(0, live);
  }
  replicaSearches += 1;
  return live;
}

function sendEmptySuggestion(extra: string) {
  send({ type: "suggestion", moves: [], move_info: { nodes: 0, nps: 0, extra } });
}

function suggest() {
  const t0 = performance.now();
  const current = queue[0];
  if (!current) {
    if (LOG) {
      appendFileSync(
        LOG,
        `${JSON.stringify({ ms: 0, nodes: 0, depth: 0, primary: null, first: null, emptyQueue: true })}\n`,
      );
    }
    sendEmptySuggestion("hoiko: empty queue");
    return;
  }
  const known = queue.map((k) => kindToMino(k));
  const live = buildLive(known);
  const native = nativeRows();
  const req: RawSearchRequest = {
    board: native,
    current: live[0] as MinoType,
    next: live.slice(1),
    hold: holdKind === null ? MINO_NONE : kindToMino(holdKind),
    combo: nativeCombo,
    btb: nativeBtb,
    isEven: isEvenBoard(native),
    useS4W: false,
    usePCstack: false,
    viewNext: VIEW_NEXT,
    allowHold: USE_HOLD,
    depth: engine.depthLimit,
    multiEvaluation: true,
    opponentIsPCBoard: false,
    opponentIsPowerfulBoard: false,
    opponentsCombo: 0,
  };
  const sync: SyncFields = {
    lockId,
    lastAction,
    lastAttack,
    opponentLockId: undefined,
    opponentLastClearLines: undefined,
    opponentLastNativeBtb: undefined,
    opponentLastNativeCombo: undefined,
  };
  const out = engine.search(req, sync, 0);
  replicaPrevUsedHold = out.useHold === 1;
  const ms = performance.now() - t0;

  const kind = KIND_BY_MINO[out.firstM] ?? current;
  const rotation = ((out.firstRRaw % 4) + 4) % 4;
  const topRow = 19 - out.y; // versus board is 20 rows; see moveFromOut in engine.ts
  const cells = cellsFor(kind, rotation).map(
    (c: { x: number; y: number }) => [out.x + c.x, 19 - (topRow + c.y)] as [number, number],
  );
  const spin = spinForAct(out.firstAct);
  const locs = tbpLocations(kind, cells);
  const spins: Spin[] = [spin, ...(["none", "mini", "full"] as Spin[]).filter((s) => s !== spin)];
  const moves: TbpMove[] = [];
  for (const s of spins) for (const location of locs) moves.push({ location, spin: s });

  const primary = {
    kind,
    rotation,
    x: out.x,
    y: out.y,
    act: out.firstAct,
    hold: out.useHold === 1,
    score: out.score,
  };
  if (LOG) {
    appendFileSync(
      LOG,
      `${JSON.stringify({ ms: +ms.toFixed(2), nodes: out.node, depth: out.depth, primary, first: moves[0] ?? null, knownQueue: known.length, garbageWait: out.garbageWait === 1 })}\n`,
    );
  }
  send({
    type: "suggestion",
    moves,
    move_info: { nodes: out.node, nps: 0, extra: `hoiko ${ms.toFixed(1)}ms depth ${out.depth}` },
  });
}

function send(msg: unknown) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

send({
  type: "info",
  name: "Hoiko",
  version: "rust-wasm/config-2026-11-24",
  author: "attax",
  features: [],
});

for await (const line of console) {
  const text = line.trim();
  if (text === "") continue;
  let msg: { type?: string; [k: string]: unknown };
  try {
    msg = JSON.parse(text);
  } catch (err) {
    console.error(`hoiko-tbp: ignoring unparseable line: ${err}`);
    continue;
  }
  try {
    switch (msg.type) {
      case "rules":
        send({ type: "ready" });
        break;
      case "start":
        onStart(
          msg as {
            board: (string | null)[][];
            queue: Kind[];
            hold?: Kind | null;
            combo?: number;
            back_to_back?: boolean;
          },
        );
        break;
      case "play":
        applyPlay(msg.move as TbpMove);
        break;
      case "new_piece":
        queue.push(msg.piece as Kind);
        break;
      case "suggest":
        suggest();
        break;
      case "stop":
        stopSeen = true;
        break;
      case "quit":
        process.exit(0);
    }
  } catch (err) {
    console.error(`hoiko-tbp: error handling "${msg.type}": ${err}`);
    if (msg.type === "suggest") sendEmptySuggestion("hoiko: decision failed");
  }
}
