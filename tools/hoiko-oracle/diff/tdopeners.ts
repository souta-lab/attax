/**
 * TemplateAI control-plane differential: the pure opener decision functions
 * (`TDOpenersCmp`, `OriginNextCmp`, `DecisionTemplate`, `DecisionLoopTemplate`)
 * on synthetic GamePacks, exe (`ScpDriverStub` `tmpl=1`) vs Rust
 * (`examples/tmpl_dump.rs`).
 *
 *   cargo build --release --example tmpl_dump --manifest-path rust/Cargo.toml
 *   bun tdopeners.ts
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const ORACLE_ROOT = Bun.env.HOIKO_ORACLE_ROOT ?? "/tmp/opencode/oracle";
const ORACLE_RUN = Bun.env.HOIKO_ORACLE_RUN ?? `${ORACLE_ROOT}/run`;
const ORACLE_PREFIX = Bun.env.HOIKO_ORACLE_PREFIX ?? `${ORACLE_ROOT}/prefix`;
const ORACLE_SCRIPT = new URL("../run_oracle.sh", import.meta.url).pathname;
const REPLICA_BIN = new URL("../../../rust/target/release/examples/tmpl_dump", import.meta.url)
  .pathname;
const EVIDENCE = new URL("../../../evidence/hoiko-config/tdopeners/", import.meta.url);

interface State {
  readonly name: string;
  readonly rows: readonly number[];
  readonly next: readonly number[];
  readonly hold: number;
  readonly lock: readonly [number, number, number, number];
  readonly fall: readonly [number, number, number, number];
  readonly useTd: boolean;
  readonly loopTemplate: boolean;
  readonly opType: number;
  readonly opDropCount: number;
  readonly prev: number;
  readonly remains: number;
}

const rowsOf = (spec: Record<number, number>): number[] => {
  const out = Array.from({ length: 32 }, () => 0);
  for (const [k, v] of Object.entries(spec)) out[Number(k)] = v;
  return out;
};

const PATTERN_STATES: State[] = [
  { name: "td-L-4", piece: 2, rows: { 0: 1007, 1: 1015, 2: 135, 3: 6 }, want: 4 },
  { name: "td-T-4", piece: 4, rows: { 0: 879, 1: 823, 2: 775, 3: 518 }, want: 4 },
  { name: "td-T-5", piece: 4, rows: { 0: 987, 1: 947, 2: 899, 3: 385 }, want: 5 },
  { name: "td-S-4", piece: 5, rows: { 0: 911, 1: 967, 2: 903, 3: 518 }, want: 4 },
  { name: "td-S-5", piece: 5, rows: { 0: 991, 1: 959, 2: 135, 3: 1 }, want: 5 },
  { name: "td-Z-4", piece: 6, rows: { 0: 1007, 1: 1015, 2: 900, 3: 512 }, want: 4 },
  { name: "td-Z-5", piece: 6, rows: { 0: 967, 1: 911, 2: 903, 3: 385 }, want: 5 },
  { name: "td-Z-6", piece: 6, rows: { 0: 1007, 1: 1015, 2: 932, 3: 512 }, want: 6 },
  { name: "td-S-7", piece: 5, rows: { 0: 991, 1: 959, 2: 151, 3: 1 }, want: 7 },
  { name: "td-L-2", piece: 2, rows: { 0: 991, 1: 959, 2: 900, 3: 768 }, want: 2 },
  { name: "td-J-5", piece: 1, rows: { 0: 991, 1: 959, 2: 900, 3: 384 }, want: 5 },
  { name: "td-J-3", piece: 1, rows: { 0: 1007, 1: 1015, 2: 135, 3: 3 }, want: 3 },
].map((p) => ({
  name: p.name as string,
  rows: rowsOf(p.rows as Record<number, number>),
  next: [p.piece as number, 5, 4, 3, 1, 2, 0],
  hold: 7,
  lock: [0, 0, 0, 0] as const,
  fall: [3, 20, 0, 6] as const,
  useTd: true,
  loopTemplate: false,
  opType: 1,
  opDropCount: 6,
  prev: 6,
  remains: 6,
}));

const state = (o: Partial<State> & { name: string }): State => ({
  rows: rowsOf({}),
  next: [6, 5, 4, 3, 1, 2, 0],
  hold: 7,
  lock: [0, 0, 0, 0],
  fall: [3, 20, 0, 6],
  useTd: true,
  loopTemplate: false,
  opType: 1,
  opDropCount: 0,
  prev: 0,
  remains: 6,
  ...o,
});

const CORPUS: State[] = [
  ...PATTERN_STATES,
  state({ name: "phase-0", opType: 1, opDropCount: 0 }),
  state({ name: "phase-6", opType: 1, opDropCount: 6 }),
  state({ name: "phase-7", opType: 1, opDropCount: 7 }),
  state({ name: "phase-8", opType: 1, opDropCount: 8 }),
  state({ name: "phase-16", opType: 1, opDropCount: 16 }),
  state({ name: "phase-22", opType: 1, opDropCount: 22 }),
  state({ name: "phase-30", opType: 1, opDropCount: 30 }),
  state({ name: "td-off-phase6", useTd: false, opType: 0, opDropCount: 6 }),
  state({
    name: "origin-all-hold4",
    hold: 4,
    next: [0, 1, 2, 3, 5, 6, 4],
    opDropCount: 30,
  }),
  state({ name: "origin-missing", hold: 4, next: [0, 1, 2, 3, 5, 5, 4], opDropCount: 30 }),
  state({
    name: "loop-rearm-hold4-rem5",
    hold: 4,
    next: [0, 1, 2, 5, 6, 4, 3],
    loopTemplate: true,
    opType: 0,
    opDropCount: -1,
    prev: -1,
    remains: 5,
    fall: [3, 20, 0, 5],
    btb: 3,
  } as Partial<State> & { name: string }),
  state({
    name: "loop-nohold-rem6",
    hold: 7,
    next: [0, 1, 2, 3, 4, 5, 6],
    loopTemplate: true,
    opType: 0,
    opDropCount: -1,
    prev: -1,
    remains: 6,
  }),
  state({
    name: "loop-noflag",
    hold: 4,
    next: [0, 1, 2, 5, 6, 4, 3],
    loopTemplate: false,
    opType: 0,
    opDropCount: -1,
    prev: -1,
    remains: 5,
  }),
];

function exeInput(s: State): string {
  const board = [...s.rows];
  const queue = [...s.next, 0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6, 0, 1, 2, 3, 4, 5, 6];
  return [
    `# tmpl ${s.name}`,
    `board=${board.map((v) => `0x${(v >>> 0).toString(16)}`).join(",")}`,
    `next=${queue.slice(0, 28).join(",")}`,
    `hold=${s.hold}`,
    `viewnext=5`,
    `usetdopeners=${s.useTd ? 1 : 0}`,
    `looptemplate=${s.loopTemplate ? 1 : 0}`,
    `optype=${s.opType}`,
    `opdropcount=${s.opDropCount}`,
    `prevop=${s.prev}`,
    `remains=${s.remains}`,
    `fallx=${s.fall[0]}`,
    `fally=${s.fall[1]}`,
    `fallr=${s.fall[2]}`,
    `fallm=${s.fall[3]}`,
    `lockx=${s.lock[0]}`,
    `locky=${s.lock[1]}`,
    `lockr=${s.lock[2]}`,
    `lockm=${s.lock[3]}`,
    `tmpl=1`,
    "",
  ].join("\n");
}

function replicaInput(s: State): string {
  return [
    s.lock.join(" "),
    s.fall.join(" "),
    s.hold,
    s.remains,
    5,
    s.useTd ? 1 : 0,
    s.loopTemplate ? 1 : 0,
    s.opType,
    s.opDropCount,
    s.prev,
    ...s.rows,
    ...s.next,
  ].join(" ");
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(Bun.env)) if (v !== undefined) env[k] = v;
  env.HOIKO_ORACLE_ROOT = ORACLE_ROOT;
  env.HOIKO_ORACLE_RUN = ORACLE_RUN;
  env.HOIKO_ORACLE_PREFIX = ORACLE_PREFIX;
  return env;
}

function runExe(s: State): string {
  writeFileSync(`${ORACLE_RUN}/oracle_input.txt`, exeInput(s));
  const logPath = `${ORACLE_RUN}/tmpl_${s.name}.log`;
  rmSync(logPath, { force: true });
  const proc = Bun.spawnSync(["bash", "-c", `bash '${ORACLE_SCRIPT}' > '${logPath}' 2>&1`], {
    stdout: "ignore",
    stderr: "ignore",
    timeout: 120000,
    env: childEnv(),
  });
  const text = readFileSync(logPath, "utf8");
  if (proc.exitCode !== 0 || !text.includes("ORACLE_OK")) {
    throw new Error(`oracle '${s.name}' failed (exit=${proc.exitCode}); see ${logPath}`);
  }
  return text;
}

function runReplica(s: State): string {
  const proc = Bun.spawnSync([REPLICA_BIN], {
    stdin: new TextEncoder().encode(replicaInput(s)),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) throw new Error(`replica failed: ${proc.stderr.toString()}`);
  return proc.stdout.toString();
}

interface Parsed {
  tdcmp: number;
  origin: number;
  dt: number;
  dtOpType: number;
  dtOpDrop: number;
  dtl: number;
  dtlOpType: number;
  dtlOpDrop: number;
  dtlPrev: number;
}

function parseExe(text: string): Parsed {
  const g = (re: RegExp): number => {
    const m = text.match(re);
    if (m === null) throw new Error(`parse failed: ${re}`);
    return Number(m[1]);
  };
  const statics = (tag: string): number[] => {
    const m = text.match(
      new RegExp(
        `${tag}=[01] \\| useTemplate=\\d+ opType=(-?\\d+) opDropCount=(-?\\d+) prev=(-?\\d+)`,
      ),
    );
    if (m === null) throw new Error(`statics missing for ${tag}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const dt = statics("DecisionTemplate");
  const dtl = statics("DecisionLoopTemplate");
  return {
    tdcmp: g(/TDOpenersCmp=(-?\d+)/),
    origin: g(/OriginNextCmp=(-?\d+)/),
    dt: g(/DecisionTemplate=(-?\d+)/),
    dtOpType: dt[0] as number,
    dtOpDrop: dt[1] as number,
    dtl: g(/DecisionLoopTemplate=(-?\d+)/),
    dtlOpType: dtl[0] as number,
    dtlOpDrop: dtl[1] as number,
    dtlPrev: dtl[2] as number,
  };
}

function parseReplica(text: string): Parsed {
  const g = (re: RegExp): number => {
    const m = text.match(re);
    if (m === null) throw new Error(`replica parse failed: ${re}`);
    return Number(m[1]);
  };
  return {
    tdcmp: g(/TDCMP=(-?\d+)/),
    origin: g(/ORIGIN=(-?\d+)/),
    dt: g(/DT=(-?\d+)/),
    dtOpType: g(/DT=-?\d+ opType=(-?\d+)/),
    dtOpDrop: g(/DT=-?\d+ opType=-?\d+ opDropCount=(-?\d+)/),
    dtl: g(/DTL=(-?\d+)/),
    dtlOpType: g(/DTL=-?\d+ opType=(-?\d+)/),
    dtlOpDrop: g(/DTL=-?\d+ opType=-?\d+ opDropCount=(-?\d+)/),
    dtlPrev: g(/DTL=-?\d+ opType=-?\d+ opDropCount=-?\d+ prev=(-?\d+)/),
  };
}

if (!existsSync(REPLICA_BIN)) {
  throw new Error(
    `replica probe missing: ${REPLICA_BIN}\nrun: cargo build --release --example tmpl_dump --manifest-path rust/Cargo.toml`,
  );
}

mkdirSync(EVIDENCE, { recursive: true });
interface CaseResult {
  readonly name: string;
  readonly ok: boolean;
  readonly diffs: readonly string[];
}
const results: CaseResult[] = [];
for (const s of CORPUS) {
  const exeText = runExe(s);
  const repText = runReplica(s);
  const exe = parseExe(exeText);
  const rep = parseReplica(repText);
  writeFileSync(new URL(`${s.name}-exe.log`, EVIDENCE), exeText);
  writeFileSync(new URL(`${s.name}-replica.txt`, EVIDENCE), repText);
  const diffs: string[] = [];
  const fields: readonly (keyof Parsed)[] = [
    "tdcmp",
    "origin",
    "dt",
    "dtOpType",
    "dtOpDrop",
    "dtl",
    "dtlOpType",
    "dtlOpDrop",
    "dtlPrev",
  ];
  for (const f of fields) if (exe[f] !== rep[f]) diffs.push(`${f}: exe=${exe[f]} rep=${rep[f]}`);
  results.push({ name: s.name, ok: diffs.length === 0, diffs });
  console.log(`${diffs.length === 0 ? "OK  " : "FAIL"} ${s.name.padEnd(24)} ${diffs.join("; ")}`);
}
const passed = results.filter((r) => r.ok).length;
writeFileSync(
  new URL("report.json", EVIDENCE),
  `${JSON.stringify({ cases: results, passed, total: results.length }, null, 2)}\n`,
);
console.log(`\n${passed}/${results.length} cases match`);
process.exit(passed === results.length ? 0 : 1);
