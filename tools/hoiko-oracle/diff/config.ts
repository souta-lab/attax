/**
 * Config-option differential: enable a shipping-config option in BOTH the exe
 * (ScpDriverStub RVA override keys) and the Rust replica, then diff every
 * evaluated child (state + all eval terms) and the chosen search move.
 *
 *   bun config.ts --pcstack [--n=16] [--search] [--viewnext=2]
 *   bun config.ts --s4w      [--n=16] [--search]
 *   bun config.ts --tdopeners [--viewnext=5] [--search]
 *
 * Evidence: evidence/hoiko-config/<option>/ (raw exe/replica logs + report.json).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRustHoiko, type RustHoikoFighter } from "../../hoiko-rust/loader.js";
import type { GameSnapshot, PieceKind } from "../../../src/ui/types.js";

const ORACLE_ROOT = Bun.env.HOIKO_ORACLE_ROOT ?? "/tmp/opencode/oracle";
const ORACLE_RUN = Bun.env.HOIKO_ORACLE_RUN ?? `${ORACLE_ROOT}/run`;
const ORACLE_PREFIX = Bun.env.HOIKO_ORACLE_PREFIX ?? `${ORACLE_ROOT}/prefix`;
const ORACLE_SCRIPT = new URL("../run_oracle.sh", import.meta.url).pathname;
const REPLICA_BIN = new URL("../../../rust/target/release/examples/eval_dump", import.meta.url)
  .pathname;

const args = Bun.argv.slice(2);
const argValue = (flag: string): string | undefined =>
  args.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1);
const OPTION: "pcstack" | "s4w" | "tdopeners" = args.includes("--s4w")
  ? "s4w"
  : args.includes("--tdopeners")
    ? "tdopeners"
    : "pcstack";
const N = Number.parseInt(argValue("--n") ?? "16", 10);
const SEARCH = args.includes("--search");
const VIEW_NEXT = Number.parseInt(argValue("--viewnext") ?? "2", 10);
const ORACLE_KEYS: Readonly<Record<typeof OPTION, string>> = {
  pcstack: "usepcstack",
  s4w: "uses4w",
  tdopeners: "usetdopeners",
};
const REPLICA_ENV: Readonly<Record<typeof OPTION, string>> = {
  pcstack: "HOIKO_USE_PCSTACK",
  s4w: "HOIKO_USE_S4W",
  tdopeners: "HOIKO_USE_TDOPENERS",
};
const EVIDENCE = new URL(`../../../evidence/hoiko-config/${OPTION}/`, import.meta.url);

if (!existsSync(REPLICA_BIN)) {
  throw new Error(`replica probe missing: ${REPLICA_BIN}\nrun: cargo build --release --example eval_dump --manifest-path rust/Cargo.toml`);
}
if (VIEW_NEXT !== 2 || OPTION === "tdopeners") {
  if (VIEW_NEXT < 5) throw new Error(`viewNext=${VIEW_NEXT} < 5 disables ConfigAI.UseTDOpeners()`);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Position {
  readonly name: string;
  readonly board: readonly number[];
  readonly next: readonly number[];
  readonly hold: number;
  readonly combo: number;
  readonly btb: number;
}

const BAG = [6, 5, 4, 3, 1, 2, 0];

function queue27(shift: number): number[] {
  return Array.from({ length: 27 }, (_, i) => BAG[(i + shift) % 7] ?? 7);
}

function corpus(): Position[] {
  const out: Position[] = [];
  const queue = (shift: number): number[] => queue27(shift);
  const full = (shift: number, cur: number): number[] => [cur, ...queue27(shift)];
  out.push({ name: "empty", board: [0], next: full(0, BAG[0] ?? 0), hold: 7, combo: 0, btb: 0 });
  out.push({
    name: "stub-default",
    board: [0x1ff, 0x001, 0x001],
    next: full(0, BAG[0] ?? 0),
    hold: 7,
    combo: 0,
    btb: 0,
  });
  for (let k = 0; k < N; k += 1) {
    const rng = mulberry32(0xc0ffee + k * 7919);
    const h = k % 8;
    const board: number[] = [];
    for (let y = 0; y < h; y += 1) {
      let row = Math.floor(rng() * 1024);
      if (y === h - 1 && row === 0) row = 1 << Math.floor(rng() * 10);
      board.push(row);
    }
    if (h === 0) board.push(0);
    const cur = BAG[k % 7] ?? 0;
    out.push({
      name: `rand-${k}-h${h}`,
      board,
      next: [cur, ...queue(k)],
      hold: k % 3 === 0 ? (BAG[(k + 2) % 7] ?? 7) : 7,
      combo: k % 4,
      btb: k % 3,
    });
  }
  const s4w = (name: string, rows: number[], combo = 0): Position => ({
    name,
    board: rows,
    next: full(0, BAG[0] ?? 0),
    hold: 7,
    combo,
    btb: 0,
  });
  out.push(s4w("s4w-h5", [0x1ff, ...Array.from({ length: 5 }, () => 0x3f)]));
  out.push(s4w("s4w-h8", [0x1ff, ...Array.from({ length: 8 }, () => 0x3f)]));
  out.push(s4w("s4w-h12", [0x1ff, ...Array.from({ length: 12 }, () => 0x3f)]));
  out.push(s4w("s4w-combo4", [0x1ff, ...Array.from({ length: 4 }, () => 0x3f)], 4));
  return out;
}

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
  const logPath = `${ORACLE_RUN}/config_${OPTION}_${tag}.log`;
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

function inputLines(p: Position, extra: readonly string[]): string {
  const board = [...p.board];
  while (board.length < 32) board.push(0);
  return [
    `# config differential ${OPTION} ${p.name}`,
    `board=${board.map((v) => `0x${(v >>> 0).toString(16)}`).join(",")}`,
    `next=${p.next.join(",")}`,
    `hold=${p.hold}`,
    `combo=${p.combo}`,
    `b2b=${p.btb}`,
    ...extra,
    "",
  ].join("\n");
}

function replicaEvalStdin(p: Position): string {
  const queue = p.next.slice(1);
  return [
    "eval_bfs",
    String(p.board.length),
    ...p.board.map(String),
    String(p.next[0] ?? 0),
    String(queue.length),
    ...queue.map(String),
    String(p.hold),
    String(p.combo),
    String(p.btb),
    String(VIEW_NEXT),
    "1",
    "",
  ].join(" ");
}

function runReplicaEval(p: Position): string {
  const proc = Bun.spawnSync([REPLICA_BIN], {
    stdin: new TextEncoder().encode(replicaEvalStdin(p)),
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv({ [REPLICA_ENV[OPTION]]: "1" }),
  });
  if (proc.exitCode !== 0) throw new Error(`replica eval failed: ${proc.stderr.toString()}`);
  return proc.stdout.toString();
}

const KIND: Record<number, PieceKind> = { 0: "I", 1: "J", 2: "L", 3: "O", 4: "T", 5: "S", 6: "Z" };

function snapshotFrom(p: Position): GameSnapshot {
  const rows = 24;
  const grid: number[][] = Array.from({ length: rows }, () => Array.from({ length: 10 }, () => 0));
  for (let y = 0; y < p.board.length && y < rows; y += 1) {
    const native = p.board[y] ?? 0;
    const row = grid[rows - 1 - y];
    if (row === undefined) continue;
    for (let c = 0; c < 10; c += 1) if ((native & (1 << (9 - c))) !== 0) row[c] = 1;
  }
  const next = p.next.slice(1, 13).map((v) => KIND[v] ?? "I");
  return {
    board: { cols: 10, rows, grid },
    active: { kind: KIND[p.next[0] ?? 0] ?? "I", rotation: 0, cells: [], posX: 3, posY: 0 },
    ghostY: null,
    hold: p.hold === 7 ? null : (KIND[p.hold] ?? null),
    canHold: true,
    next,
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
    pendingGarbage: 0,
    lastAttack: 0,
    lastBlocked: 0,
  };
}

const CLEAR_DELAY: Readonly<Record<number, number>> = {
  0: 0, 1: 36, 5: 36, 8: 36, 2: 41, 3: 41, 6: 41, 7: 41, 4: 46, 9: 1,
};
const getDelay = (moveDelay: number, act: number): number =>
  (CLEAR_DELAY[act] ?? 0) * 16 + moveDelay;

interface SearchResult {
  readonly x: number;
  readonly rot: number;
  readonly m: number;
  readonly depth: number;
  readonly delay: number;
  readonly nodes: number;
}

function runExeSearch(p: Position): SearchResult {
  const text = runExe(
    inputLines(p, [
      `viewnext=${VIEW_NEXT}`,
      ...(OPTION === "pcstack" ? ["usepcstack=1"] : []),
      ...(OPTION === "s4w" ? ["uses4w=1"] : []),
      ...(OPTION === "tdopeners" ? ["usetdopeners=1"] : []),
    ]),
    `search-${p.name}`,
  );
  const fm = text.match(/firstMove @\+?456:\s*x=(-?\d+)\s+y=(-?\d+)\s+rot=(-?\d+)\s+m=(-?\d+)/);
  const depth = text.match(/depth\s+@\+?444\s*=\s*(-?\d+)/);
  const delay = text.match(/GetDelay\s*=\s*(-?\d+)/);
  const nodes = text.match(/nodeCount\s+@\+?440\s*=\s*(-?\d+)/);
  if (fm === null) throw new Error(`no firstMove in exe search for ${p.name}`);
  return {
    x: Number(fm[1]),
    rot: Number(fm[3]),
    m: Number(fm[4]),
    depth: depth === null ? -1 : Number(depth[1]),
    delay: delay === null ? -1 : Number(delay[1]),
    nodes: nodes === null ? -1 : Number(nodes[1]),
  };
}

function runReplicaSearch(fighter: RustHoikoFighter, p: Position): SearchResult | null {
  const res = fighter.searchSnapshot(snapshotFrom(p));
  if (res === null) return null;
  const o = res.out;
  return {
    x: o.x,
    rot: ((o.firstRRaw % 4) + 4) % 4,
    m: o.firstM,
    depth: o.depth,
    delay: getDelay(o.moveDelay, o.firstAct),
    nodes: o.node,
  };
}

const FIELDS = [
  "x", "y", "rot", "m", "act", "delay", "combo", "btb", "stack", "nextBase", "trustEnd", "win",
  "minH", "height", "well", "wellCol", "wellDepth", "updown", "under", "ground", "res", "tsd",
  "tst", "pc", "cont", "action", "board", "fscore", "score",
] as const;
type Field = (typeof FIELDS)[number];

interface NodeDump {
  readonly values: Readonly<Record<Field, number>>;
  readonly rows: string;
}

interface Container {
  readonly label: string;
  readonly nodes: NodeDump[];
}

const NODE_RE = new RegExp(
  `^E(?:B)?\\s+(\\d+)\\s+(\\d+)\\s+hold=\\d+\\s+x=(-?\\d+)\\s+y=(-?\\d+)\\s+rot=(-?\\d+)\\s+m=(-?\\d+)\\s+act=(-?\\d+)\\s+delay=(-?\\d+)\\s+combo=(-?\\d+)\\s+btb=(-?\\d+)\\s+stack=(-?\\d+)\\s+nextBase=(-?\\d+)\\s+trustEnd=(-?\\d+)\\s+win=(-?\\d+).*?minH=(-?\\d+)\\s+height=(-?\\d+)\\s+well=(-?\\d+)\\s+wellCol=(-?\\d+)\\s+wellDepth=(-?\\d+)\\s+updown=(-?\\d+)\\s+under=(-?\\d+)\\s+ground=(-?\\d+)\\s+res=(-?\\d+)\\s+tsd=(-?\\d+)\\s+tst=(-?\\d+)\\s+pc=(-?\\d+)\\s+cont=(-?\\d+)\\s+action=(-?\\d+)\\s+board=(-?\\d+)\\s+fscore=(-?\\d+)\\s+score=(-?\\d+)\\s+rows=(.*)$`,
);
const GEN_RE = /^GEN (\d+) /;
const B_RE = /^B (\d+) /;

function parseDump(text: string): Container[] {
  const byLabel = new Map<string, Container>();
  const ensure = (label: string): Container => {
    let c = byLabel.get(label);
    if (c === undefined) {
      c = { label, nodes: [] };
      byLabel.set(label, c);
    }
    return c;
  };
  for (const line of text.split(/\r?\n/)) {
    const gm = line.match(GEN_RE);
    if (gm !== null) {
      ensure(`GEN ${gm[1]}`).nodes.length = 0;
      continue;
    }
    const bm = line.match(B_RE);
    if (bm !== null) {
      ensure(`B ${bm[1]}`).nodes.length = 0;
      continue;
    }
    const m = line.match(NODE_RE);
    if (m === null) continue;
    const label = line.startsWith("EB") ? `B ${m[1]}` : "GEN 0";
    const values: Record<string, number> = {};
    for (let i = 0; i < FIELDS.length; i += 1) values[FIELDS[i] as string] = Number(m[i + 3]);
    ensure(label).nodes.push({ values: values as Record<Field, number>, rows: m[m.length - 1] ?? "" });
  }
  return [...byLabel.values()];
}

interface NodeDiff {
  readonly container: string;
  readonly idx: number;
  readonly diffs: readonly string[];
}

function diffDumps(exe: Container[], rep: Container[]): { diffs: NodeDiff[]; pcNonzero: number; resNonzero: number } {
  const diffs: NodeDiff[] = [];
  let pcNonzero = 0;
  let resNonzero = 0;
  for (const ec of exe) {
    const rc = rep.find((c) => c.label === ec.label);
    if (rc === undefined) {
      diffs.push({ container: ec.label, idx: -2, diffs: ["container missing in replica"] });
      continue;
    }
    if (ec.nodes.length !== rc.nodes.length) {
      diffs.push({
        container: ec.label,
        idx: -1,
        diffs: [`count: exe=${ec.nodes.length} rep=${rc.nodes.length}`],
      });
    }
    const limit = Math.min(ec.nodes.length, rc.nodes.length);
    for (let i = 0; i < limit; i += 1) {
      const en = ec.nodes[i];
      const rn = rc.nodes[i];
      if (en === undefined || rn === undefined) break;
      if (en.values.pc !== 0) pcNonzero += 1;
      if (en.values.res !== 0) resNonzero += 1;
      const d: string[] = [];
      for (const f of FIELDS) {
        if (en.values[f] !== rn.values[f]) d.push(`${f}: exe=${en.values[f]} rep=${rn.values[f]}`);
      }
      if (en.rows !== rn.rows) d.push("rows differ");
      if (d.length > 0) diffs.push({ container: ec.label, idx: i, diffs: d });
    }
  }
  return { diffs, pcNonzero, resNonzero };
}

function optionArgs(): string[] {
  return [
    `viewnext=${VIEW_NEXT}`,
    ...(OPTION === "pcstack" ? ["usepcstack=1"] : []),
    ...(OPTION === "s4w" ? ["uses4w=1"] : []),
    ...(OPTION === "tdopeners" ? ["usetdopeners=1"] : []),
  ];
}

mkdirSync(EVIDENCE, { recursive: true });
const list = corpus();
const fighter =
  !SEARCH
    ? null
    : createRustHoiko({
        weightPreset: "we",
        depthLimit: 10,
        offset: false,
        adapt: false,
        usePCstack: OPTION === "pcstack",
        useS4W: OPTION === "s4w",
      });

interface CaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly exeNodes: number;
  readonly repNodes: number;
  readonly pcNonzero: number;
  readonly resNonzero: number;
  readonly diffs: readonly NodeDiff[];
  readonly search?: {
    readonly exe: SearchResult;
    readonly rep: SearchResult | null;
    readonly ok: boolean;
  };
}

const results: CaseResult[] = [];
for (const p of list) {
  const offText = runExe(inputLines(p, ["eval=2", `viewnext=${VIEW_NEXT}`]), `eval-${p.name}-off`);
  const onText = runExe(inputLines(p, ["eval=2", ...optionArgs()]), `eval-${p.name}-on`);
  const repText = runReplicaEval(p);
  writeFileSync(new URL(`${p.name}-exe-off.log`, EVIDENCE), offText);
  writeFileSync(new URL(`${p.name}-exe-on.log`, EVIDENCE), onText);
  writeFileSync(new URL(`${p.name}-replica.txt`, EVIDENCE), repText);
  const on = parseDump(onText);
  const off = parseDump(offText);
  const rep = parseDump(repText);
  const { diffs, pcNonzero, resNonzero } = diffDumps(on, rep);
  const exeNodes = on.reduce((n, c) => n + c.nodes.length, 0);
  const repNodes = rep.reduce((n, c) => n + c.nodes.length, 0);
  const offDiff = diffDumps(off, rep).diffs.length;
  let search:
    | { exe: SearchResult; rep: SearchResult | null; ok: boolean }
    | undefined;
  if (SEARCH && fighter !== null) {
    const exe = runExeSearch(p);
    const r = runReplicaSearch(fighter, p);
    search = {
      exe,
      rep: r,
      ok: r !== null && exe.x === r.x && exe.rot === r.rot && exe.m === r.m && exe.depth === r.depth && exe.delay === r.delay,
    };
  }
  const ok = diffs.length === 0 && (search === undefined || search.ok);
  results.push({ name: p.name, ok, exeNodes, repNodes, pcNonzero, resNonzero, diffs, search });
  const changed = diffDumps(on, off).diffs.length;
  console.log(
    `${ok ? "OK  " : "FAIL"} ${p.name.padEnd(16)} nodes=${exeNodes}/${repNodes} diffs=${diffs.length} optionChangedNodes=${changed} pc!=0:${pcNonzero} search=${search === undefined ? "-" : search.ok ? "OK" : "FAIL"}`,
  );
  if (diffs.length > 0) {
    for (const d of diffs.slice(0, 3)) console.log(`     ${d.container}[${d.idx}]: ${d.diffs.join("; ")}`);
  }
}

const passed = results.filter((r) => r.ok).length;
const totalChanged = results.reduce((n, r) => n + r.pcNonzero, 0);
const report = {
  option: OPTION,
  viewNext: VIEW_NEXT,
  searchMode: SEARCH,
  cases: results,
  passed,
  total: results.length,
  totalPcNonzero: totalChanged,
  timestamp: new Date().toISOString(),
};
writeFileSync(new URL("report.json", EVIDENCE), `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${passed}/${results.length} cases match (option=${OPTION}, viewNext=${VIEW_NEXT}, search=${SEARCH})`);
process.exit(passed === results.length ? 0 : 1);
