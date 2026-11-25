/**
 * TBP (Tetris Bot Protocol) adapter for Attax (GPU engine).
 *
 * Speaks TBP on stdin/stdout so intetrigence's `external-arena` referee can host Attax.
 * State is tracked from TBP messages only (start / play / new_piece); every decision is
 * made by the Vulkan GPU engine (`gpu/vkrunner_s26 serve`) with no CPU fallback.
 * The adapter only translates coordinates:
 *
 *   TBP board: 40 rows, row 0 = bottom.  Attax board: 20 rows (default) or 40 rows, row 0 = top.
 *   TBP placement: piece centre + orientation (Cold Clear convention) + spin label.
 *
 * Attax's chosen placement is converted by matching the four occupied cells against every
 * TBP orientation of the same piece. Because the referee accepts the first suggestion that
 * is in its own move list (which also fixes the spin label), the adapter lists Attax's
 * choice with Attax's spin label first, then the same cells with the other spin labels,
 * then Attax's ranked alternative first moves. Every decision is logged (ATTAX_TBP_LOG).
 *
 * Host contract: the adapter tracks the piece queue from `start` and `new_piece`
 * messages only. A host must keep the queue non-empty whenever it sends `suggest`:
 * send `new_piece` as pieces are consumed (the usual TBP cadence), or resync with a
 * fresh `start`. Attax decides on the current piece plus up to PREVIEW preview pieces
 * (five by default; see ATTAX_TBP_PREVIEW below), so
 * longer queues are welcome but never required. If the queue does run dry, the adapter
 * answers `suggest` with an empty suggestion and stays alive — it never throws and
 * never exits on a host message; normal operation resumes on the next `start` or
 * `new_piece`. (A host that only resyncs via `start` when garbage rises will drain the
 * queue in ~20 quiet turns; that pattern killed this adapter before 2026-11-15.)
 *
 * Env: ATTAX_TBP_LOG (optional JSONL decision log path),
 *      ATTAX_TBP_ROWS (visible board rows in the snapshot: 40 default since W7, or 20),
 *      ATTAX_TBP_PROFILE ("s2" selects the S2 rules profile; default "guideline"),
 *      ATTAX_TBP_PREVIEW (preview pieces fed to the search: default
 *      BOT_DEFAULTS.preview = 5, i.e. a 6-piece horizon; an integer 0..13
 *      overrides it, up to the decision record's 13 preview slots = a
 *      14-piece horizon. Only pieces the host actually sent are used —
 *      a shorter host queue simply yields a shorter horizon).
 *      ATTAX_TBP_BAG_FILL ("1" pads a short host queue up to PREVIEW with
 *      a deterministic 7-bag continuation — the current bag's remaining
 *      pieces in canonical order, then whole bags; see bag-tracker.ts.
 *      Modelled from `start`/`new_piece` traffic only, the same public
 *      information Hoiko's NextState replica uses. Default off: the
 *      preview is then exactly the host-sent pieces, bit-identical).
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { cellsFor } from "../src/core/pieces.js";
import { BOT_DEFAULTS } from "../tools/s2-lab/defaults.js";
import { encodeDecisionRecordBytes, parseServeBlock } from "../tools/s2-lab/gpu-codec.js";
import { PINNED_TABLES_SHA256 } from "../tools/s2-lab/gpu-player.js";
import type { SearchInput } from "../tools/s2-lab/state.js";
import { BagTracker } from "./bag-tracker.js";

const LOG = process.env.ATTAX_TBP_LOG;

// Visible board rows in the bot's snapshot. 40 (the W7 default, landed
// 2026-11-25) exposes the full TBP board: with 20 the engine played blind
// whenever its stack grew past row 19. ATTAX_TBP_ROWS=20 restores the old
// published guideline view (cells above TBP row 19 not represented). In
// 40-row mode the spawn origin follows the S2 spawn (see
// buildSearchInput()), not the 20-row top edge.
const FIELD_ROWS = process.env.ATTAX_TBP_ROWS === "20" ? 20 : 40;
const S2_PROFILE = process.env.ATTAX_TBP_PROFILE === "s2";

// Search horizon, in preview pieces after the current one. The shipped
// default (BOT_DEFAULTS.preview = 5) gives a 6-piece horizon; Hoiko's
// horizon is 14 pieces (attax-hoiko-night conclusion, lanechat #8403 /
// #8485). The decision record already carries 13 preview slots
// (gpu-codec.ts: seq_len = 1 + preview, preview > 13 is rejected), so
// ATTAX_TBP_PREVIEW can raise the horizon to 14 pieces with no wire or
// engine change. Unset, non-integer, or out-of-range values keep the
// shipped default, so an unset env is bit-identical to before.
const MAX_PREVIEW = 13;
function resolvePreview(): number {
  const raw = process.env.ATTAX_TBP_PREVIEW;
  if (raw === undefined) return BOT_DEFAULTS.preview;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_PREVIEW) return BOT_DEFAULTS.preview;
  return n;
}
const PREVIEW = resolvePreview();

// Deterministic 7-bag continuation (see bag-tracker.ts). Only "1" enables
// it; anything else leaves the tracker untouched and the preview exactly
// the host-sent pieces.
const BAG_FILL = process.env.ATTAX_TBP_BAG_FILL === "1";
const bagTracker = new BagTracker();
let started = false;
let stopSeen = false;

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

// ---- Cold Clear / TBP piece geometry (engine/src/data.rs), y up --------------------------
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
const key = (cells: [number, number][]) =>
  cells
    .map(([x, y]) => `${x},${y}`)
    .sort()
    .join(";");

/** All TBP locations whose cells equal `cells` (absolute, TBP coords). */
function tbpLocations(kind: Kind, cells: [number, number][]): Loc[] {
  const target = key(cells);
  const anchor = [...cells].sort((a, b) => a[1] - b[1] || a[0] - b[0])[0];
  if (!anchor) return [];
  const out: Loc[] = [];
  for (const o of ORIENTS) {
    const offs = CC_CELLS[kind].map((c) => rotateCell(o, c));
    const a = [...offs].sort((p, q) => p[1] - q[1] || p[0] - q[0])[0];
    if (!a) continue;
    const cx = anchor[0] - a[0];
    const cy = anchor[1] - a[1];
    if (key(offs.map(([x, y]) => [x + cx, y + cy])) === target) {
      out.push({ type: kind, orientation: o, x: cx, y: cy });
    }
  }
  return out;
}

/** Attax placement (kind, rotation, x, top-row y) -> absolute TBP cells. */
function attaxCellsToTbp(kind: Kind, rotation: number, x: number, y: number): [number, number][] {
  return cellsFor(kind, rotation).map((c: { x: number; y: number }) => [
    x + c.x,
    FIELD_ROWS - 1 - (y + c.y),
  ]);
}

// ---- GPU serve client --------------------------------------------------------------------
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const GPU_DIR = path.join(REPO_ROOT, "gpu");
const PERSISTENT_DIR = path.join(REPO_ROOT, "persistent");

const SERVE_ENV = {
  S22_PASSA: "off",
  S23_SOA: "1",
  S26_PFUSE: "on",
  S26_LFUSE: "on",
  S26_FILL: "on",
  ATTAX_GPU_PROFILE: S2_PROFILE ? "s2" : "guideline",
} as const;

interface Waiter {
  resolve: (block: Uint8Array) => void;
  reject: (err: Error) => void;
}

class TbpGpuServer {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<void> | null = null;
  private stderrTail = "";
  private stdoutBuf = Buffer.alloc(0);
  private waiters: Waiter[] = [];
  private failure: Error | null = null;
  private tail: Promise<void> = Promise.resolve();

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.doStart();
    return this.starting;
  }

  private doStart(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const useVkrunner =
        process.env.ATTAX_GPU_BACKEND === "vkrunner" ||
        (process.env.ATTAX_GPU_RUNNER !== undefined &&
          path.basename(process.env.ATTAX_GPU_RUNNER).startsWith("vkrunner"));
      const runner =
        process.env.ATTAX_GPU_RUNNER ??
        (useVkrunner ? path.join(GPU_DIR, "vkrunner_s26") : path.join(PERSISTENT_DIR, "pfserve"));
      const tables = process.env.ATTAX_GPU_TABLES ?? path.join(GPU_DIR, "tables.bin");
      const shaders = useVkrunner
        ? [
            path.join(GPU_DIR, "shaders", "bpmg_b1.spv"),
            path.join(GPU_DIR, "shaders", "expand_s25_noba.spv"),
          ]
        : [path.join(GPU_DIR, "shaders", "pfl_r15_serve.spv")];
      if (!existsSync(runner)) {
        reject(
          new Error(`GPU engine binary not found at ${runner} — build with: bash gpu/build.sh`),
        );
        return;
      }
      for (const spv of shaders) {
        if (!existsSync(spv)) {
          reject(new Error(`GPU engine shader missing at ${spv}`));
          return;
        }
      }
      if (!existsSync(tables)) {
        reject(new Error(`GPU evaluation tables not found at ${tables}`));
        return;
      }
      const sha = createHash("sha256").update(readFileSync(tables)).digest("hex");
      if (sha !== PINNED_TABLES_SHA256) {
        reject(
          new Error(`GPU evaluation tables lineage mismatch: ${sha} != ${PINNED_TABLES_SHA256}`),
        );
        return;
      }

      const args = ["serve", ...shaders, tables];
      if (process.env.ATTAX_GPU_DEVICE) args.push(process.env.ATTAX_GPU_DEVICE);
      const proc = spawn(runner, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...SERVE_ENV },
      });
      this.proc = proc;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const err = new Error(`GPU engine did not report a device within 60s:\n${this.stderrTail}`);
        this.fail(err);
        reject(err);
      }, 60_000);
      proc.stderr.on("data", (chunk: Buffer) => {
        this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-4096);
        if (!settled) {
          const m = /selected:\s*(.+)/.exec(this.stderrTail);
          if (m) {
            settled = true;
            clearTimeout(timer);
            const dev = m[1].replace(/\s*\(timestampPeriod.*$/, "").trim();
            const lower = dev.toLowerCase();
            if (
              lower.includes("llvmpipe") ||
              lower.includes("lavapipe") ||
              lower.includes("swiftshader")
            ) {
              const err = new Error(`GPU engine: software Vulkan device refused ("${dev}")`);
              this.fail(err);
              reject(err);
              return;
            }
            resolve();
          }
        }
      });
      proc.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
      const onDead = (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
        this.fail(err);
      };
      proc.on("error", (e) => onDead(new Error(`GPU engine process error: ${e.message}`)));
      proc.on("exit", (code, signal) =>
        onDead(
          new Error(`GPU engine exited (code ${code}, signal ${signal}):\n${this.stderrTail}`),
        ),
      );
    });
  }

  private fail(err: Error): void {
    if (!this.failure) this.failure = err;
    for (const w of this.waiters.splice(0)) w.reject(this.failure);
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuf = Buffer.concat([this.stdoutBuf, chunk]);
    for (;;) {
      if (this.stdoutBuf.length < 8) return;
      const status = this.stdoutBuf.readUInt32LE(0);
      const blockBytes = this.stdoutBuf.readUInt32LE(4);
      if (this.stdoutBuf.length < 8 + blockBytes) return;
      const block = Buffer.from(this.stdoutBuf.subarray(8, 8 + blockBytes));
      this.stdoutBuf = this.stdoutBuf.subarray(8 + blockBytes);
      const waiter = this.waiters.shift();
      if (!waiter) {
        this.fail(new Error("GPU engine sent a response with no pending request"));
        return;
      }
      if (block.length < 4 || block.readUInt32LE(0) !== status) {
        waiter.reject(new Error(`GPU serve protocol desync: ${status}`));
        continue;
      }
      waiter.resolve(block);
    }
  }

  request(record: Uint8Array): Promise<Uint8Array> {
    const run = async (): Promise<Uint8Array> => {
      if (this.failure) throw this.failure;
      await this.start();
      if (this.failure) throw this.failure;
      const proc = this.proc;
      if (!proc) throw new Error("GPU engine process is not running");
      return new Promise<Uint8Array>((resolve, reject) => {
        this.waiters.push({ resolve, reject });
        proc.stdin.write(record, (err) => {
          if (err) reject(new Error(`GPU engine stdin write failed: ${err.message}`));
        });
      });
    };
    const result = this.tail.then(run, run);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  close(): void {
    this.proc?.stdin.end();
    this.proc = null;
  }
}

const gpuServer = new TbpGpuServer();

// ---- tracked game state (TBP coordinates) ------------------------------------------------
let rows: boolean[][] = []; // rows[y][x], y = 0 bottom, 40 rows
let queue: Kind[] = [];
let hold: Kind | null = null;
let combo = 0; // TBP/intetrigence convention: consecutive clears, 0 = none
let b2b = false;

function setBoard(board: (string | null)[][]) {
  rows = Array.from({ length: 40 }, (_, y) =>
    Array.from({ length: 10 }, (_, x) => (board[y]?.[x] ?? null) !== null),
  );
}

/** Queue head consumption, mirrored into the bag tracker when enabled. */
function shiftQueue(): Kind | undefined {
  const head = queue.shift();
  if (head !== undefined && BAG_FILL) bagTracker.noteConsumed();
  return head;
}

function applyPlay(mv: TbpMove) {
  const kind = mv.location.type;
  const current = shiftQueue();
  if (kind !== current) {
    const prevHold = hold;
    hold = current ?? null;
    if (prevHold === null) shiftQueue();
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
  if (lines > 0) {
    combo += 1;
    b2b = lines === 4 || mv.spin !== "none";
  } else {
    combo = 0;
  }
}

// ---- decision --------------------------------------------------------------------------
function buildSearchInput(): SearchInput | null {
  const kind = queue[0];
  if (!kind) return null; // queue ran dry: caller answers with an empty suggestion
  const board = new Uint16Array(FIELD_ROWS);
  for (let r = 0; r < FIELD_ROWS; r++) {
    const tbpRow = rows[FIELD_ROWS - 1 - r];
    let bits = 0;
    if (tbpRow) {
      for (let x = 0; x < 10; x++) if (tbpRow[x]) bits |= 1 << x;
    }
    board[r] = bits;
  }
  const shape = cellsFor(kind, 0) as { x: number; y: number }[];
  const minY = Math.min(0, ...shape.map((c) => c.y));
  const maxY = Math.max(...shape.map((c) => c.y));
  // 40-row mode: the S2 spawn puts the piece's lowest cell at TBP row 21,
  // which is grid row FIELD_ROWS - 22, so the origin sits maxY above it.
  const posY = FIELD_ROWS > 20 ? FIELD_ROWS - 22 - maxY : -minY;
  // With BAG_FILL, pad a short host queue up to PREVIEW from the 7-bag
  // model so the search horizon reaches 1 + PREVIEW pieces (seq_len 14
  // at PREVIEW = 13). Off, or when the host already sent enough pieces,
  // the preview is exactly the host-sent slice.
  let preview = queue.slice(1, 1 + PREVIEW);
  if (BAG_FILL && preview.length < PREVIEW) {
    const extended = [...queue, ...bagTracker.continuation(PREVIEW + 1 - queue.length)];
    preview = extended.slice(1, 1 + PREVIEW);
  }
  return {
    board,
    active: {
      kind,
      rotation: 0,
      x: 3,
      y: posY,
    },
    hold,
    canHold: true,
    preview,
    b2b,
    b2bChain: b2b ? 1 : 0,
    combo: combo - 1, // Attax: -1 = no chain, 0 = first clear
    pending: 0, // TBP carries no incoming-garbage information
    dueThisLock: 0,
    frame: 0,
    speculativePieces: [],
  };
}

function movesFor(kind: Kind, rotation: number, x: number, y: number, spin: Spin): TbpMove[] {
  const locs = tbpLocations(kind, attaxCellsToTbp(kind, rotation, x, y));
  const spins: Spin[] = [spin, ...(["none", "mini", "full"] as Spin[]).filter((s) => s !== spin)];
  const out: TbpMove[] = [];
  for (const s of spins) for (const location of locs) out.push({ location, spin: s });
  return out;
}

function sendEmptySuggestion(extra: string) {
  send({
    type: "suggestion",
    moves: [],
    move_info: { nodes: 0, nps: 0, extra },
  });
}

async function suggest() {
  const t0 = performance.now();
  const input = buildSearchInput();
  if (input === null) {
    if (LOG) {
      appendFileSync(
        LOG,
        `${JSON.stringify({ ms: 0, nodes: 0, depth: 0, primary: null, first: null, emptyQueue: true })}\n`,
      );
    }
    sendEmptySuggestion("attax: empty queue");
    return;
  }
  const record = encodeDecisionRecordBytes(input);
  const block = await gpuServer.request(record);
  const parsed = parseServeBlock(block);
  const ms = performance.now() - t0;
  const moves: TbpMove[] = [];
  let primary: unknown = null;
  if (parsed.best !== null) {
    const p = parsed.best.placement;
    primary = {
      kind: p.kind,
      rotation: p.rotation,
      x: p.x,
      y: p.y,
      tspin: p.tspin,
      hold: parsed.best.usedHold,
    };
    moves.push(...movesFor(p.kind, p.rotation, p.x, p.y, p.tspin));
    for (const c of parsed.candidates.slice(1)) {
      const q = c.placement;
      moves.push(...movesFor(q.kind, q.rotation, q.x, q.y, q.tspin));
    }
  }
  const nodes = Number(parsed.nodes);
  const above = rows.slice(20).some((r) => r.some(Boolean));
  if (LOG) {
    appendFileSync(
      LOG,
      `${JSON.stringify({ ms: +ms.toFixed(2), nodes, depth: parsed.depth, primary, first: moves[0] ?? null, cellsAboveRow20: above })}\n`,
    );
  }
  send({
    type: "suggestion",
    moves,
    move_info: { nodes, nps: 0, extra: `attax ${ms.toFixed(1)}ms` },
  });
}

function send(msg: unknown) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

send({
  type: "info",
  name: "Attax",
  version: "overhaul/full",
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
    console.error(`attax-tbp: ignoring unparseable line: ${err}`);
    continue;
  }
  try {
    switch (msg.type) {
      case "rules":
        await gpuServer.start();
        send({ type: "ready" });
        break;
      case "start":
        setBoard(msg.board as (string | null)[][]);
        queue = [...(msg.queue as Kind[])];
        hold = (msg.hold as Kind | null) ?? null;
        combo = (msg.combo as number) ?? 0;
        b2b = !!msg.back_to_back;
        if (BAG_FILL) {
          // A start preceded by stop is the referee's garbage resync and
          // must keep the bag phase; a fresh-looking start with no stop
          // before it begins a new match (hoiko-tbp.ts pattern).
          const freshStart =
            (msg.board as (string | null)[][]).every((row) =>
              (row ?? []).every((c) => c === null || c === undefined),
            ) &&
            hold === null &&
            combo === 0 &&
            !b2b;
          if (!started || (freshStart && !stopSeen)) bagTracker.startFresh(queue);
          else bagTracker.startResync(queue);
          started = true;
          stopSeen = false;
        }
        break;
      case "play":
        applyPlay(msg.move as TbpMove);
        break;
      case "new_piece":
        queue.push(msg.piece as Kind);
        if (BAG_FILL) bagTracker.noteNewPiece(msg.piece as Kind);
        break;
      case "suggest":
        await suggest();
        break;
      case "stop":
        if (BAG_FILL) stopSeen = true;
        break;
      case "quit":
        gpuServer.close();
        process.exit(0);
    }
  } catch (err) {
    console.error(`attax-tbp: error handling "${msg.type}": ${err}`);
    if (msg.type === "suggest") sendEmptySuggestion("attax: decision failed");
  }
}
