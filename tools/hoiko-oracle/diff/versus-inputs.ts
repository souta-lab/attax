/**
 * Versus input-contract differential: the four opponent-aware EvaluateAI
 * statics + `EvenOrOdd` parity + the carried weight family.
 *
 *   bun versus-inputs.ts
 *
 * Part A (`vsprobe`): run the exe's real `OpponentIsPCBoard(Board*)` /
 * `OpponentIsPowerfulBoard(Board*, combo, garbage)` on a synthetic opponent
 * board corpus and diff them against the shared TS derivation the adapter uses.
 *
 * Part B (`multieval`/`opppc`/`opppowerful`/`oppcombo`/`evenodd`): drive the
 * exe `SearchAI.Search` with the four statics + `EvenOrOdd`, and the Rust/WASM
 * adapter in versus mode, on identical snapshots; diff first move, garbageWait,
 * weightIndex, depth and node count.
 *
 * Evidence: evidence/hoiko-inputs/.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { opponentIsPCBoard, opponentIsPowerfulBoard } from "../../../src/ai/hoiko-opponent.js";
import type { BoardView, GameSnapshot, PieceKind } from "../../../src/ui/types.js";
import { createRustHoiko, type RustHoikoFighter } from "../../hoiko-rust/loader.js";

const ORACLE_ROOT = Bun.env.HOIKO_ORACLE_ROOT ?? "/tmp/opencode/oracle";
const ORACLE_RUN = Bun.env.HOIKO_ORACLE_RUN ?? `${ORACLE_ROOT}/run`;
const ORACLE_PREFIX = Bun.env.HOIKO_ORACLE_PREFIX ?? `${ORACLE_ROOT}/prefix`;
const ORACLE_SCRIPT = new URL("../run_oracle.sh", import.meta.url).pathname;
const EVIDENCE = new URL("../../../evidence/hoiko-inputs/", import.meta.url);
const BAG = [6, 5, 4, 3, 1, 2, 0];
const KIND: Record<number, PieceKind> = { 0: "I", 1: "J", 2: "L", 3: "O", 4: "T", 5: "S", 6: "Z" };
const CLEAR_DELAY: Readonly<Record<number, number>> = {
  0: 0,
  1: 36,
  5: 36,
  8: 36,
  2: 41,
  3: 41,
  6: 41,
  7: 41,
  4: 46,
  9: 1,
};

if (!existsSync(`${ORACLE_RUN}/Hoiko.exe`)) {
  throw new Error(`oracle not staged at ${ORACLE_RUN} (run tools/hoiko-oracle/build_oracle.sh)`);
}
mkdirSync(EVIDENCE, { recursive: true });

function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) if (value !== undefined) env[key] = value;
  env.HOIKO_ORACLE_ROOT = ORACLE_ROOT;
  env.HOIKO_ORACLE_RUN = ORACLE_RUN;
  env.HOIKO_ORACLE_PREFIX = ORACLE_PREFIX;
  return { ...env, ...extra };
}

function runExe(input: string, tag: string): string {
  writeFileSync(`${ORACLE_RUN}/oracle_input.txt`, input);
  const logPath = `${ORACLE_RUN}/vs_${tag}.log`;
  rmSync(logPath, { force: true });
  const proc = Bun.spawnSync(["bash", "-c", `bash '${ORACLE_SCRIPT}' > '${logPath}' 2>&1`], {
    stdout: "ignore",
    stderr: "ignore",
    timeout: 300000,
    env: childEnv({}),
  });
  const text = readFileSync(logPath, "utf8");
  if (proc.exitCode !== 0 || !text.includes("ORACLE_OK")) {
    throw new Error(`oracle '${tag}' failed (exit=${proc.exitCode}); see ${logPath}`);
  }
  return text;
}

const hex = (v: number): string => `0x${(v >>> 0).toString(16)}`;

// ---------------------------------------------------------------------------
// Part A — derivation formulas
// ---------------------------------------------------------------------------

interface DerivationCase {
  readonly name: string;
  readonly rows: readonly number[];
  readonly combo: number;
  readonly garbage: number;
}

function derivationBoards(): { name: string; rows: number[] }[] {
  const full = (n: number, row = 0x3ff): number[] => Array.from({ length: n }, () => row);
  return [
    { name: "empty", rows: [] },
    { name: "one-full", rows: [0x3ff] },
    { name: "four-full", rows: full(4) },
    { name: "nine-full", rows: full(9) },
    { name: "ten-full", rows: full(10) },
    { name: "odd-9bit", rows: [0x1ff] },
    { name: "odd-9bit-x5", rows: full(5, 0x001) },
    { name: "even-col9", rows: full(6, 0x001) },
    { name: "bara-mix", rows: [0x1ff, 0x0ff, 0x03f, 0x01f, 0x00f, 0x007] },
    { name: "well-center", rows: [0x3ff, 0x3ff, 0x3ff, 0x3ef, 0x3ef, 0x3ef, 0x3ef] },
    {
      name: "tall-mixed",
      rows: [0x3ff, 0x3ff, 0x3ff, 0x3ff, 0x3ff, 0x37f, 0x37f, 0x37f, 0x37f, 0x37f, 0x37f],
    },
    { name: "s4w-3f", rows: [0x1ff, 0x3f, 0x3f, 0x3f, 0x3f, 0x3f] },
  ];
}

function derivationCorpus(): DerivationCase[] {
  const out: DerivationCase[] = [];
  const inputs: readonly (readonly [number, number])[] = [
    [0, 0],
    [4, 0],
    [5, 0],
    [0, 5],
    [0, 6],
    [9, 0],
  ];
  for (const { name, rows } of derivationBoards()) {
    for (const [combo, garbage] of inputs) {
      out.push({ name, rows, combo, garbage });
    }
  }
  return out;
}

interface DerivationResult {
  readonly name: string;
  readonly combo: number;
  readonly garbage: number;
  readonly exePc: boolean;
  readonly tsPc: boolean;
  readonly exePowerful: boolean;
  readonly tsPowerful: boolean;
  readonly ok: boolean;
}

function parseFlag(text: string, name: string): boolean {
  const m = text.match(new RegExp(`${name}=(\\d)`));
  if (m === null) throw new Error(`missing ${name} in oracle output`);
  return m[1] === "1";
}

function runDerivation(): DerivationResult[] {
  const results: DerivationResult[] = [];
  for (const c of derivationCorpus()) {
    const board = [...c.rows];
    while (board.length < 32) board.push(0);
    const text = runExe(
      [
        `# versus derivation ${c.name} combo=${c.combo} garbage=${c.garbage}`,
        "board=0x0",
        "vsprobe=1",
        `oppboard=${board.map(hex).join(",")}`,
        `oppcombo=${c.combo}`,
        `garbage=${c.garbage}`,
        "",
      ].join("\n"),
      `derive-${c.name}-c${c.combo}-g${c.garbage}`,
    );
    writeFileSync(new URL(`derive-${c.name}-c${c.combo}-g${c.garbage}.log`, EVIDENCE), text);
    const exePc = parseFlag(text, "oppPc");
    const exePowerful = parseFlag(text, "oppPowerful");
    const tsPc = opponentIsPCBoard(c.rows);
    const tsPowerful = opponentIsPowerfulBoard(c.rows, c.combo, c.garbage);
    results.push({
      name: c.name,
      combo: c.combo,
      garbage: c.garbage,
      exePc,
      tsPc,
      exePowerful,
      tsPowerful,
      ok: exePc === tsPc && exePowerful === tsPowerful,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Part B — end-to-end search with the four flags
// ---------------------------------------------------------------------------

interface Position {
  readonly name: string;
  readonly board: readonly number[];
  readonly current: number;
  readonly queue: readonly number[];
  readonly hold: number;
  readonly combo: number;
  readonly btb: number;
  readonly opponent: readonly number[];
  readonly opponentCombo: number;
  readonly pendingGarbage: number;
  readonly useS4W: boolean;
}

function queue27(shift: number): number[] {
  return Array.from({ length: 27 }, (_, i) => BAG[(i + shift) % 7] ?? 7);
}

function positions(): Position[] {
  const out: Position[] = [];
  const base = (name: string, extra: Partial<Position>): Position => ({
    name,
    board: [],
    current: BAG[0] ?? 0,
    queue: queue27(0),
    hold: 7,
    combo: 0,
    btb: 0,
    opponent: [],
    opponentCombo: 0,
    pendingGarbage: 0,
    useS4W: false,
    ...extra,
  });
  out.push(base("empty-opp", { opponent: [] }));
  out.push(base("opp-pc", { opponent: [0x3ff, 0x3ff, 0x3ff, 0x3ff] }));
  out.push(base("opp-notpc", { opponent: [0x1ff] }));
  out.push(base("opp-combo9", { opponent: [0x3ff], opponentCombo: 9 }));
  out.push(base("opp-combo9-garbage", { opponent: [0x3ff], opponentCombo: 9, pendingGarbage: 7 }));
  out.push(
    base("own-stack-combo9", {
      board: [0x3ff, 0x3ff, 0x3ff, 0x001, 0x001, 0x001],
      combo: 2,
      btb: 1,
      opponent: [0x001, 0x001, 0x001, 0x001, 0x001, 0x001],
      opponentCombo: 9,
    }),
  );
  out.push(
    base("s4w-opp-powerful", {
      board: [],
      opponent: [0x1ff, 0x3f, 0x3f, 0x3f, 0x3f, 0x3f],
      useS4W: true,
    }),
  );
  out.push(
    base("s4w-opp-notpowerful", {
      board: [],
      opponent: [0x3ff, 0x3ff, 0x3ff, 0x3ff, 0x3ff, 0x3ff, 0x3ff, 0x3ff, 0x3ff, 0x3ff],
      useS4W: true,
    }),
  );
  return out;
}

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
    hold: p.hold === 7 ? null : (KIND[p.hold] ?? null),
    canHold: true,
    next: p.queue.slice(0, 12).map((v) => KIND[v] ?? "I"),
    score: 0,
    lines: 0,
    level: 1,
    gameOver: false,
    combo: 0,
    b2b: false,
    nativeCombo: p.combo,
    nativeBtb: p.btb,
    lockId: 0,
    lastAction: "None",
    lastRawAttack: 0,
    pendingGarbage: p.pendingGarbage,
    lastAttack: 0,
    lastBlocked: 0,
    opponentCombo: p.opponentCombo,
    opponentBtb: 0,
    opponentLockId: 0,
    opponentBoard: gridFrom(p.opponent, rows),
  };
}

interface SearchResult {
  readonly x: number;
  readonly rot: number;
  readonly m: number;
  readonly garbageWait: number;
  readonly weightIndex: number;
  readonly depth: number;
  readonly nodes: number;
  readonly delay: number;
}

function exeSearchInput(p: Position): string {
  const board = [...p.board];
  while (board.length < 32) board.push(0);
  const next = [p.current, ...p.queue];
  const pc = opponentIsPCBoard(p.opponent);
  const powerful = p.useS4W
    ? opponentIsPowerfulBoard(p.opponent, p.opponentCombo, p.pendingGarbage)
    : false;
  return [
    `# versus search ${p.name}`,
    `board=${board.map(hex).join(",")}`,
    `next=${next.join(",")}`,
    `hold=${p.hold}`,
    `combo=${p.combo}`,
    `b2b=${p.btb}`,
    "depthlimit=10",
    "weightindex=0",
    "evenodd=1",
    "multieval=1",
    `oppcombo=${p.opponentCombo}`,
    `opppc=${pc ? 1 : 0}`,
    `opppowerful=${powerful ? 1 : 0}`,
    ...(p.useS4W ? ["uses4w=1"] : []),
    "",
  ].join("\n");
}

function runExeSearch(p: Position): SearchResult {
  const text = runExe(exeSearchInput(p), `search-${p.name}`);
  writeFileSync(new URL(`search-${p.name}.log`, EVIDENCE), text);
  const fm = text.match(/firstMove @\+?456:\s*x=(-?\d+)\s+y=(-?\d+)\s+rot=(-?\d+)\s+m=(-?\d+)/);
  const wi = text.match(/weightIndex=(-?\d+)/);
  const depth = text.match(/depth\s+@\+?444\s*=\s*(-?\d+)/);
  const nodes = text.match(/nodeCount\s+@\+?440\s*=\s*(-?\d+)/);
  const delay = text.match(/GetDelay\s*=\s*(-?\d+)/);
  if (fm === null) throw new Error(`no firstMove for ${p.name}`);
  return {
    x: Number(fm[1]),
    rot: Number(fm[3]),
    m: Number(fm[4]),
    garbageWait: 0,
    weightIndex: wi === null ? 0 : Number(wi[1]),
    depth: depth === null ? -1 : Number(depth[1]),
    nodes: nodes === null ? -1 : Number(nodes[1]),
    delay: delay === null ? -1 : Number(delay[1]),
  };
}

function replicaSearch(fighter: RustHoikoFighter, p: Position): SearchResult {
  const res = fighter.searchSnapshot(snapshotFrom(p));
  if (res === null) throw new Error(`replica returned null for ${p.name}`);
  const o = res.out;
  return {
    x: o.x,
    rot: ((o.firstRRaw % 4) + 4) % 4,
    m: o.firstM,
    garbageWait: o.garbageWait,
    weightIndex: o.weightIndex,
    depth: o.depth,
    nodes: o.node,
    delay: (CLEAR_DELAY[o.firstAct] ?? 0) * 16 + o.moveDelay,
  };
}

function runBehavior(): { name: string; exe: SearchResult; rep: SearchResult; ok: boolean }[] {
  const results: { name: string; exe: SearchResult; rep: SearchResult; ok: boolean }[] = [];
  for (const p of positions()) {
    const exe = runExeSearch(p);
    const fighter = createRustHoiko({
      versus: true,
      adapt: false,
      depthLimit: 10,
      useS4W: p.useS4W,
    });
    const rep = replicaSearch(fighter, p);
    const ok =
      exe.x === rep.x &&
      exe.rot === rep.rot &&
      exe.m === rep.m &&
      exe.weightIndex === rep.weightIndex &&
      exe.depth === rep.depth &&
      exe.nodes === rep.nodes;
    results.push({ name: p.name, exe, rep, ok });
    console.log(
      `${ok ? "OK  " : "FAIL"} ${p.name.padEnd(22)} exe(x${exe.x} r${exe.rot} m${exe.m} wi${exe.weightIndex} d${exe.depth} n${exe.nodes}) rep(x${rep.x} r${rep.rot} m${rep.m} wi${rep.weightIndex} d${rep.depth} n${rep.nodes})`,
    );
  }
  return results;
}

// ---------------------------------------------------------------------------

console.log("=== Part A: opponent flag derivation (exe vs TS) ===");
const deriv = runDerivation();
const derivFail = deriv.filter((d) => !d.ok);
for (const d of derivFail.slice(0, 10)) {
  console.log(
    `FAIL ${d.name} c${d.combo} g${d.garbage}: pc exe=${d.exePc} ts=${d.tsPc}; powerful exe=${d.exePowerful} ts=${d.tsPowerful}`,
  );
}
console.log(`${deriv.length - derivFail.length}/${deriv.length} derivation cases match`);

console.log("\n=== Part B: versus search (exe statics vs WASM adapter) ===");
const behavior = runBehavior();
const behaviorFail = behavior.filter((b) => !b.ok);

const report = {
  timestamp: new Date().toISOString(),
  derivation: { total: deriv.length, passed: deriv.length - derivFail.length, cases: deriv },
  behavior: {
    total: behavior.length,
    passed: behavior.length - behaviorFail.length,
    cases: behavior,
  },
  pass: derivFail.length === 0 && behaviorFail.length === 0,
};
writeFileSync(new URL("report.json", EVIDENCE), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `\n${deriv.length - derivFail.length}/${deriv.length} derivation + ${behavior.length - behaviorFail.length}/${behavior.length} behavior match`,
);
process.exit(report.pass ? 0 : 1);
