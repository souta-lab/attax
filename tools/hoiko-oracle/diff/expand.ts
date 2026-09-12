/**
 * E3 expansion differential: walk the shipping Hoiko.exe's chosen turn-183
 * line and compare its `ExpandAI.ExpandNode` child list against the Rust
 * replica at every generation, naming the first missing/extra placement.
 *
 *   bun expand.ts
 *
 * Exe side: `tools/hoiko-oracle/ScpDriverStub.cs` in `expand=1` mode dumps
 * `GEN`/`CHILD`/`PATH` lines for the root and for each child selected by
 * `path=`. Replica side: `rust/target/release/examples/expand_dump`
 * (`cargo build --release --example expand_dump`). Raw outputs are written to
 * `evidence/hoiko-fullgame/expand-turn183/`.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const ORACLE_ROOT = Bun.env.HOIKO_ORACLE_ROOT ?? "/tmp/opencode/oracle";
const ORACLE_RUN = Bun.env.HOIKO_ORACLE_RUN ?? `${ORACLE_ROOT}/run`;
const ORACLE_PREFIX = Bun.env.HOIKO_ORACLE_PREFIX ?? `${ORACLE_ROOT}/prefix`;
const ORACLE_SCRIPT = new URL("../run_oracle.sh", import.meta.url).pathname;
const REPLICA_BIN = new URL("../../../rust/target/release/examples/expand_dump", import.meta.url)
  .pathname;

if (!existsSync(REPLICA_BIN)) {
  throw new Error(
    `replica probe missing: ${REPLICA_BIN}\nrun: cargo build --release --example expand_dump --manifest-path rust/Cargo.toml`,
  );
}

const args = Bun.argv.slice(2);
function argValue(flag: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  return hit === undefined ? undefined : hit.slice(flag.length + 1);
}

interface SnapshotFile {
  readonly turn: number;
  readonly board: readonly number[];
  readonly current: number;
  readonly next: readonly number[];
  readonly hold: number;
  readonly combo: number;
  readonly btb: number;
}

const SNAPSHOT_ARG = argValue("--snapshot");
const SNAPSHOT: SnapshotFile | null =
  SNAPSHOT_ARG === undefined
    ? null
    : (JSON.parse(readFileSync(SNAPSHOT_ARG, "utf8")) as SnapshotFile);
const TURN = SNAPSHOT?.turn ?? 183;
const NAME = argValue("--name") ?? `expand-turn${TURN}`;
const EVIDENCE_DIR = new URL(`../../../evidence/hoiko-fullgame/${NAME}/`, import.meta.url);

// Default source is the turn-183 snapshot; `--snapshot=<replay-turn JSON>`
// selects any other turn.
const BOARD_ROWS: readonly number[] =
  SNAPSHOT === null
    ? [0x3f7, 0x3f7, 0x3e3, 0x3c0, 0x1c0, ...Array.from({ length: 27 }, () => 0)]
    : [
        ...SNAPSHOT.board,
        ...Array.from({ length: Math.max(0, 32 - SNAPSHOT.board.length) }, () => 0),
      ];
const CURRENT = SNAPSHOT?.current ?? 2;
const NEXT_HEAD = SNAPSHOT === null ? [0, 1, 5, 6, 5, 2, 0] : [...SNAPSHOT.next];
const FULL_NEXT = [
  CURRENT,
  ...NEXT_HEAD,
  ...Array.from({ length: Math.max(0, 27 - NEXT_HEAD.length) }, () => 7),
].slice(0, 28);
const HOLD = SNAPSHOT?.hold ?? 4;
const COMBO = SNAPSHOT?.combo ?? 0;
const BTB = SNAPSHOT?.btb ?? 24;
const VIEW_NEXT = 2;
const ALLOW_HOLD = 1;

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.HOIKO_ORACLE_ROOT = ORACLE_ROOT;
  env.HOIKO_ORACLE_RUN = ORACLE_RUN;
  env.HOIKO_ORACLE_PREFIX = ORACLE_PREFIX;
  return env;
}

function runExeInput(input: string, tag: string): string {
  writeFileSync(`${ORACLE_RUN}/oracle_input.txt`, input);
  const logPath = `${ORACLE_RUN}/diff_expand_${tag}.log`;
  rmSync(logPath, { force: true });
  const proc = Bun.spawnSync(["bash", "-c", `bash '${ORACLE_SCRIPT}' > '${logPath}' 2>&1`], {
    stdout: "ignore",
    stderr: "ignore",
    timeout: 180000,
    env: childEnv(),
  });
  const text = readFileSync(logPath, "utf8");
  if (proc.exitCode !== 0 || !text.includes("ORACLE_OK")) {
    throw new Error(`oracle run '${tag}' failed (exit=${proc.exitCode})`);
  }
  return text;
}

function runReplica(input: string): string {
  const proc = Bun.spawnSync([REPLICA_BIN], {
    stdin: new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(`replica expand_dump failed: ${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

function matchInt(text: string, re: RegExp): number | null {
  const m = text.match(re);
  if (m === null) return null;
  const parsed = Number.parseInt(m[1] ?? "", 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function boardInput(rows: readonly number[]): string {
  return rows.map((v) => `0x${(v >>> 0).toString(16)}`).join(",");
}

interface PlanEntry {
  readonly index: number;
  readonly isBreak: boolean;
  readonly x: number;
  readonly y: number;
  readonly rot: number;
  readonly m: number;
  readonly act: number;
}

function parsePlan(text: string, depth: number): PlanEntry[] {
  const byIndex = new Map<number, PlanEntry>();
  for (const line of text.split(/\r?\n/)) {
    const lineMatch = line.match(/^\s*seq\[(\d+)\] @\d+: (.*)$/);
    if (lineMatch === null) continue;
    const index = Number.parseInt(lineMatch[1] ?? "", 10);
    const rest = lineMatch[2] ?? "";
    const fm = rest.match(/x=(-?\d+) y=(-?\d+) rot=(-?\d+) m=(-?\d+) act=(-?\d+)/);
    if (fm !== null) {
      byIndex.set(index, {
        index,
        isBreak: false,
        x: Number.parseInt(fm[1] ?? "", 10),
        y: Number.parseInt(fm[2] ?? "", 10),
        rot: Number.parseInt(fm[3] ?? "", 10),
        m: Number.parseInt(fm[4] ?? "", 10),
        act: Number.parseInt(fm[5] ?? "", 10),
      });
      continue;
    }
    if (rest.startsWith("drawingBreak")) {
      const hex = (rest.split("raw ")[1] ?? "").trim();
      const words = hex.split(/\s+/).map((b) => Number.parseInt(b, 16));
      const word = (o: number): number =>
        ((words[o] ?? 0) |
          ((words[o + 1] ?? 0) << 8) |
          ((words[o + 2] ?? 0) << 16) |
          ((words[o + 3] ?? 0) << 24)) >>>
        0;
      byIndex.set(index, {
        index,
        isBreak: true,
        x: word(0),
        y: word(4),
        rot: word(8),
        m: 7,
        act: -1,
      });
    }
  }
  const entries: PlanEntry[] = [];
  for (let i = 0; i < depth; i += 1) {
    const entry = byIndex.get(i);
    if (entry !== undefined) entries.push(entry);
  }
  return entries;
}

interface ExeChild {
  readonly gen: number;
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly rot: number;
  readonly m: number;
  readonly fallM: number;
  readonly holdM: number;
  readonly combo: number;
  readonly btb: number;
  readonly act: number;
  readonly delay: number;
  readonly stack: number;
  readonly rows: readonly number[];
  readonly queue: readonly number[];
}

interface ExeGen {
  readonly gen: number;
  readonly count: number;
  readonly safe: number;
  readonly curM: number;
  readonly holdM: number;
  readonly combo: number;
  readonly btb: number;
  readonly children: ExeChild[];
}

interface ExeExpand {
  readonly gens: ExeGen[];
  readonly pathSel: Map<number, number>;
}

function parseExpand(text: string): ExeExpand {
  const genHead = new Map<number, Omit<ExeGen, "children">>();
  const children = new Map<string, ExeChild>();
  const pathSel = new Map<number, number>();
  for (const line of text.split(/\r?\n/)) {
    const genM = line.match(
      /^(?:GEN|POS) (\d+) count=(\d+) safe=(\d+) curM=(-?\d+) holdM=(-?\d+) combo=(-?\d+) btb=(-?\d+)/,
    );
    if (genM !== null && !genHead.has(Number(genM[1]))) {
      genHead.set(Number(genM[1]), {
        gen: Number(genM[1]),
        count: Number(genM[2]),
        safe: Number(genM[3]),
        curM: Number(genM[4]),
        holdM: Number(genM[5]),
        combo: Number(genM[6]),
        btb: Number(genM[7]),
      });
      continue;
    }
    const childM = line.match(
      /^CHILD (\d+) (\d+) x=(-?\d+) y=(-?\d+) rot=(-?\d+) m=(-?\d+) fallM=(-?\d+) holdM=(-?\d+) combo=(-?\d+) btb=(-?\d+) act=(-?\d+) delay=(-?\d+) stack=(-?\d+) lb=(-?\d+) rows=([\d,-]+) queue=([\d,]*)$/,
    );
    if (childM !== null) {
      const key = `${childM[1]}:${childM[2]}`;
      if (!children.has(key)) {
        children.set(key, {
          gen: Number(childM[1]),
          index: Number(childM[2]),
          x: Number(childM[3]),
          y: Number(childM[4]),
          rot: Number(childM[5]),
          m: Number(childM[6]),
          fallM: Number(childM[7]),
          holdM: Number(childM[8]),
          combo: Number(childM[9]),
          btb: Number(childM[10]),
          act: Number(childM[11]),
          delay: Number(childM[12]),
          stack: Number(childM[13]),
          rows: (childM[15] ?? "").split(",").map((v) => Number(v)),
          queue:
            (childM[16] ?? "").length === 0
              ? []
              : (childM[16] ?? "").split(",").map((v) => Number(v)),
        });
      }
      continue;
    }
    const pathM = line.match(/^PATH (\d+) sel=(\d+) matches=(\d+)/);
    if (pathM !== null && !pathSel.has(Number(pathM[1]))) {
      pathSel.set(Number(pathM[1]), Number(pathM[2]));
    }
  }
  const gens: ExeGen[] = [];
  for (const [gen, head] of [...genHead.entries()].sort((a, b) => a[0] - b[0])) {
    const kids: ExeChild[] = [];
    for (let i = 0; i < head.count; i += 1) {
      const child = children.get(`${gen}:${i}`);
      if (child !== undefined) kids.push(child);
    }
    gens.push({ ...head, children: kids });
  }
  return { gens, pathSel };
}

interface RepChild {
  readonly holdUsed: number;
  readonly tuck: number;
  readonly x: number;
  readonly rot: number;
  readonly m: number;
  readonly act: number;
  readonly stack: number;
  readonly delay: number;
  readonly fallM: number;
  readonly holdM: number;
  readonly combo: number;
  readonly btb: number;
  readonly rows: readonly number[];
}

interface RepExpand {
  readonly count: number;
  readonly holdUsed: number;
  readonly spawnY: number;
  readonly children: RepChild[];
}

function parseReplica(text: string): RepExpand {
  const children: RepChild[] = [];
  let count = -1;
  let holdUsed = 0;
  let spawnY = -1;
  for (const line of text.trim().split(/\r?\n/)) {
    if (line.startsWith("S ")) {
      spawnY = Number(line.slice(2).trim());
      continue;
    }
    if (line.startsWith("N ")) {
      const parts = line.split(/\s+/);
      count = Number(parts[1] ?? "-1");
      holdUsed = Number(parts[2] ?? "0");
      continue;
    }
    if (!line.startsWith("C ")) continue;
    const parts = line.slice(2).split(/\s+/);
    children.push({
      holdUsed: Number(parts[0] ?? "0"),
      tuck: Number(parts[1] ?? "0"),
      x: Number(parts[2] ?? "0"),
      rot: Number(parts[3] ?? "0"),
      m: Number(parts[4] ?? "0"),
      act: Number(parts[5] ?? "0"),
      stack: Number(parts[6] ?? "0"),
      delay: Number(parts[7] ?? "0"),
      fallM: Number(parts[8] ?? "0"),
      holdM: Number(parts[9] ?? "0"),
      combo: Number(parts[10] ?? "0"),
      btb: Number(parts[11] ?? "0"),
      rows: parts.slice(12).map((v) => Number(v)),
    });
  }
  return { count, holdUsed, spawnY, children };
}

function replicaInput(
  rows: readonly number[],
  current: number,
  queue: readonly number[],
  hold: number,
  combo: number,
  btb: number,
): string {
  const q =
    queue.length >= 2 ? queue : [...queue, ...Array.from({ length: 2 - queue.length }, () => 7)];
  return [
    String(rows.length),
    ...rows.map((v) => String(v)),
    String(current),
    String(q.length),
    ...q.map((v) => String(v)),
    String(hold),
    String(combo),
    String(btb),
    String(VIEW_NEXT),
    String(ALLOW_HOLD),
  ].join(" ");
}

function tuckOf(
  parentRows: readonly number[],
  placed: { readonly m: number; readonly rot: number; readonly x: number; readonly y: number },
): number {
  const input = [
    "tuck",
    String(placed.m),
    String(placed.rot),
    String(placed.x),
    String(placed.y),
    String(parentRows.length),
    ...parentRows.map((v) => String(v)),
  ].join(" ");
  const out = runReplica(input).trim();
  return Number(out.replace("T ", ""));
}

const childKey = (x: number, rot: number, m: number, rows: readonly number[]): string =>
  `${x},${rot},${m},${rows.join(",")}`;

interface GenReport {
  readonly gen: number;
  readonly exeCount: number;
  readonly repCount: number;
  readonly exeSafe: number;
  readonly countMatch: boolean;
  readonly orderMatch: boolean;
  readonly setMatch: boolean;
  readonly exeOnly: readonly Placed[];
  readonly repOnly: readonly Placed[];
  readonly firstOrderDiff: number | null;
  readonly exeDelays: readonly number[];
  readonly repDelays: readonly number[];
}

interface Placed {
  readonly gen: number;
  readonly x: number;
  readonly y: number | null;
  readonly rot: number;
  readonly m: number;
  readonly act: number;
  readonly delay: number;
  readonly rows: readonly number[];
  readonly tuck: number;
  readonly holdUsed: number | null;
}

function countBy(keys: readonly string[]): Map<string, number> {
  const bag = new Map<string, number>();
  for (const key of keys) bag.set(key, (bag.get(key) ?? 0) + 1);
  return bag;
}

function diffGen(gen: ExeGen, rep: RepExpand, parentRows: readonly number[]): GenReport {
  const exeKeys = gen.children.map((c) => childKey(c.x, c.rot, c.m, c.rows));
  const repKeys = rep.children.map((c) => childKey(c.x, c.rot, c.m, c.rows));
  const exeBag = countBy(exeKeys);
  const repBag = countBy(repKeys);
  const exeOnly: Placed[] = [];
  const repOnly: Placed[] = [];
  for (const c of gen.children) {
    const key = childKey(c.x, c.rot, c.m, c.rows);
    const left = repBag.get(key) ?? 0;
    if (left > 0) {
      repBag.set(key, left - 1);
      continue;
    }
    exeOnly.push({
      gen: gen.gen,
      x: c.x,
      y: c.y,
      rot: c.rot,
      m: c.m,
      act: c.act,
      delay: c.delay,
      rows: c.rows,
      tuck: tuckOf(parentRows, c),
      holdUsed: null,
    });
  }
  for (const c of rep.children) {
    const key = childKey(c.x, c.rot, c.m, c.rows);
    const left = exeBag.get(key) ?? 0;
    if (left > 0) {
      exeBag.set(key, left - 1);
      continue;
    }
    repOnly.push({
      gen: gen.gen,
      x: c.x,
      y: null,
      rot: c.rot,
      m: c.m,
      act: c.act,
      delay: c.delay,
      rows: c.rows,
      tuck: c.tuck,
      holdUsed: c.holdUsed,
    });
  }
  let firstOrderDiff: number | null = null;
  const limit = Math.min(exeKeys.length, repKeys.length);
  for (let i = 0; i < limit; i += 1) {
    if (exeKeys[i] !== repKeys[i]) {
      firstOrderDiff = i;
      break;
    }
  }
  if (firstOrderDiff === null && exeKeys.length !== repKeys.length) {
    firstOrderDiff = limit;
  }
  return {
    gen: gen.gen,
    exeCount: gen.children.length,
    repCount: rep.children.length,
    exeSafe: gen.safe,
    countMatch: gen.children.length === rep.children.length,
    orderMatch: firstOrderDiff === null,
    setMatch: exeOnly.length === 0 && repOnly.length === 0,
    exeOnly,
    repOnly,
    firstOrderDiff,
    exeDelays: gen.children.map((c) => c.delay),
    repDelays: rep.children.map((c) => c.delay),
  };
}

mkdirSync(EVIDENCE_DIR, { recursive: true });

const searchInput = [
  `# expand differential (search) turn=${TURN}`,
  `board=${boardInput(BOARD_ROWS)}`,
  `next=${FULL_NEXT.join(",")}`,
  `hold=${HOLD}`,
  `combo=${COMBO}`,
  `b2b=${BTB}`,
  "timer=1",
  "",
].join("\n");

console.log("expand: step 1/4 exe search on the turn-183 snapshot");
const searchText = runExeInput(searchInput, "search");
writeFileSync(new URL("exe-search.log", EVIDENCE_DIR), searchText);

const depth = matchInt(searchText, /depth\s+@\+?444\s*=\s*(-?\d+)/) ?? -1;
const nodeCount = matchInt(searchText, /nodeCount\s+@\+?440\s*=\s*(-?\d+)/) ?? -1;
const firstMove = searchText.match(
  /firstMove @\+?456:\s*x=(-?\d+)\s+y=(-?\d+)\s+rot=(-?\d+)\s+m=(-?\d+)/,
);
const plan = parsePlan(searchText, depth);
console.log(
  `  nodeCount=${nodeCount} depth=${depth} firstMove=${
    firstMove === null
      ? "?"
      : `x=${firstMove[1]} y=${firstMove[2]} rot=${firstMove[3]} m=${firstMove[4]}`
  }`,
);
console.log(
  `  plan: ${plan.map((e) => (e.isBreak ? `[break @${e.x},${e.y},r${e.rot}]` : `@${e.x},${e.y},r${e.rot},m${e.m}`)).join(" ")}`,
);

const path = plan
  .map((e) => `${e.x}:${e.rot}:${e.isBreak ? -1 : e.m}:${e.isBreak ? -1 : e.act}`)
  .join(",");

const expandInput = [
  `# expand differential (expand) turn=${TURN}`,
  `board=${boardInput(BOARD_ROWS)}`,
  `next=${FULL_NEXT.join(",")}`,
  `hold=${HOLD}`,
  `combo=${COMBO}`,
  `b2b=${BTB}`,
  "timer=1",
  "expand=1",
  `path=${path}`,
  "",
].join("\n");

console.log(`expand: step 2/4 exe walk (${plan.length} plies, ${plan.length + 1} generations)`);
const expandText = runExeInput(expandInput, "expand");
writeFileSync(new URL("exe-expand.log", EVIDENCE_DIR), expandText);
const exe = parseExpand(expandText);

const selected: ExeChild[] = [];
for (let k = 0; k < plan.length; k += 1) {
  const gen = exe.gens.find((g) => g.gen === k);
  const sel = exe.pathSel.get(k);
  const child = sel === undefined ? undefined : gen?.children[sel];
  if (child === undefined) {
    console.log(`  WARNING: exe selection at generation ${k} missing (PATH not found?)`);
    break;
  }
  selected.push(child);
}

const reports: GenReport[] = [];
let firstMismatch: GenReport | null = null;
let parentRows: readonly number[] = BOARD_ROWS;
let currentNode = CURRENT;
let currentQueue: readonly number[] = FULL_NEXT.slice(1);
let currentHold = HOLD;
let currentCombo = COMBO;
let currentBtb = BTB;
let stopReason: string | null = null;

console.log("expand: step 3/4 per-generation diff");
for (let k = 0; k <= plan.length; k += 1) {
  const gen = exe.gens.find((g) => g.gen === k);
  if (gen === undefined) {
    stopReason = `exe has no GEN ${k} dump`;
    break;
  }
  const repInput = replicaInput(
    parentRows,
    currentNode,
    currentQueue,
    currentHold,
    currentCombo,
    currentBtb,
  );
  const repText = runReplica(repInput);
  writeFileSync(new URL(`replica-gen-${String(k).padStart(2, "0")}.txt`, EVIDENCE_DIR), repText);
  const rep = parseReplica(repText);
  const report = diffGen(gen, rep, parentRows);
  reports.push(report);

  const flag =
    report.countMatch && report.setMatch && report.orderMatch
      ? "match"
      : `DIFF count=${report.countMatch} set=${report.setMatch} order=${report.orderMatch}`;
  console.log(
    `  gen ${k}: exe=${report.exeCount} replica=${report.repCount} safe=${gen.safe} curM=${gen.curM} hold=${gen.holdM} combo=${gen.combo} -> ${flag}`,
  );
  if (firstMismatch === null && (!report.countMatch || !report.setMatch)) {
    firstMismatch = report;
  }
  if (k === plan.length) break;

  const child = selected[k];
  if (child === undefined) {
    stopReason = `no exe-selected child at generation ${k} (not found in GEN dump)`;
    break;
  }
  parentRows = child.rows;
  currentNode = child.fallM;
  currentQueue = child.queue.slice(1);
  currentHold = child.holdM;
  currentCombo = child.combo;
  currentBtb = child.btb;
}

console.log("expand: step 4/4 report");
const reportJson = {
  turn: TURN,
  snapshot: {
    board: BOARD_ROWS,
    current: CURRENT,
    next: FULL_NEXT,
    hold: HOLD,
    combo: COMBO,
    btb: BTB,
  },
  exe: { nodeCount, depth },
  plan,
  generations: reports,
  firstMismatch,
  stopReason,
};
writeFileSync(new URL("report.json", EVIDENCE_DIR), `${JSON.stringify(reportJson, null, 2)}\n`);

const lines: string[] = [];
lines.push(`# E3 expand differential — turn ${TURN}`);
lines.push("");
lines.push(
  `Exe search: nodeCount=${nodeCount}, depth=${depth}, plan=${plan.length} entries (${plan.filter((e) => e.isBreak).length} display breaks).`,
);
lines.push("");
lines.push("| gen | exe | replica | safe | count | set | order |");
lines.push("|----:|----:|--------:|-----:|:-----:|:---:|:-----:|");
for (const r of reports) {
  lines.push(
    `| ${r.gen} | ${r.exeCount} | ${r.repCount} | ${r.exeSafe} | ${r.countMatch ? "ok" : "DIFF"} | ${r.setMatch ? "ok" : "DIFF"} | ${r.orderMatch ? "ok" : "DIFF"} |`,
  );
}
lines.push("");
if (firstMismatch === null) {
  lines.push(
    stopReason === null
      ? "No child-set mismatch along the exe's chosen line."
      : `No child-set mismatch before the walk stopped: ${stopReason}`,
  );
} else {
  lines.push(
    `First mismatch: generation ${firstMismatch.gen} (exe=${firstMismatch.exeCount}, replica=${firstMismatch.repCount}, safe=${firstMismatch.exeSafe}).`,
  );
  lines.push("");
  if (firstMismatch.exeOnly.length > 0) {
    lines.push("Exe-only placements (replica missing):");
    lines.push("");
    for (const p of firstMismatch.exeOnly) {
      lines.push(
        `- x=${p.x} y=${p.y ?? "?"} rot=${p.rot} m=${p.m} act=${p.act} delay=${p.delay} tuck=${p.tuck} rows=[${p.rows.join(",")}]`,
      );
    }
    lines.push("");
  }
  if (firstMismatch.repOnly.length > 0) {
    lines.push("Replica-only placements (exe missing):");
    lines.push("");
    for (const p of firstMismatch.repOnly) {
      lines.push(
        `- x=${p.x} rot=${p.rot} m=${p.m} act=${p.act} delay=${p.delay} tuck=${p.tuck} rows=[${p.rows.join(",")}]`,
      );
    }
    lines.push("");
  }
}

interface ComparePosition {
  readonly label: string;
  readonly board: readonly number[];
  readonly current: number;
  readonly queue: readonly number[];
  readonly hold: number;
  readonly combo: number;
  readonly btb: number;
}

interface PositionedReport extends GenReport {
  readonly pos: number;
  readonly label: string;
}

interface ComparePositionsResult {
  readonly reports: readonly PositionedReport[];
  readonly firstMismatch: PositionedReport | null;
  readonly sumExe: number;
  readonly sumRep: number;
  readonly unsafe: number;
  readonly h1Candidates: number;
}

/** Expand every position in one exe process (expand_multi) and compare the
 * child lists against one replica expansion per position. */
function comparePositions(
  tag: string,
  positions: readonly ComparePosition[],
): ComparePositionsResult {
  const replicas = positions.map((p) =>
    parseReplica(runReplica(replicaInput(p.board, p.current, p.queue, p.hold, p.combo, p.btb))),
  );
  const positionLines = positions.map((p, i) => {
    const next = [p.current, ...p.queue];
    while (next.length < 28) next.push(7);
    return [
      `board=${p.board.map((v) => `0x${(v >>> 0).toString(16)}`).join(",")}`,
      `next=${next.slice(0, 28).join(",")}`,
      `hold=${p.hold}`,
      `combo=${p.combo}`,
      `b2b=${p.btb}`,
      `fally=${replicas[i]?.spawnY ?? 20}`,
    ].join("|");
  });
  writeFileSync(`${ORACLE_RUN}/expand_positions.txt`, `${positionLines.join("\n")}\n`);
  const multiInput = [
    `# expand differential: ${tag}`,
    `board=${boardInput(BOARD_ROWS)}`,
    `next=${FULL_NEXT.join(",")}`,
    `hold=${HOLD}`,
    `combo=${COMBO}`,
    `b2b=${BTB}`,
    "timer=1",
    "expand_multi=1",
    "positions_file=expand_positions.txt",
    "",
  ].join("\n");
  const multiText = runExeInput(multiInput, tag);
  writeFileSync(new URL(`exe-${tag}.log`, EVIDENCE_DIR), multiText);
  const multi = parseExpand(multiText);

  const reports: PositionedReport[] = [];
  let firstMismatch: PositionedReport | null = null;
  let sumExe = 0;
  let sumRep = 0;
  let unsafe = 0;
  let h1Candidates = 0;
  for (let pos = 0; pos < positions.length; pos += 1) {
    const p = positions[pos];
    const rep = replicas[pos];
    if (p === undefined || rep === undefined) break;
    const gen = multi.gens.find((g) => g.gen === pos);
    if (gen === undefined) throw new Error(`no POS ${pos} in ${tag} dump`);
    if (gen.safe === 0) unsafe += 1;
    if (gen.safe === 0 && gen.count > 34) h1Candidates += 1;
    const report: PositionedReport = {
      ...diffGen(gen, rep, p.board),
      pos,
      label: p.label,
    };
    reports.push(report);
    sumExe += report.exeCount;
    sumRep += report.repCount;
    if (firstMismatch === null && (!report.countMatch || !report.setMatch)) {
      firstMismatch = report;
    }
  }
  return { reports, firstMismatch, sumExe, sumRep, unsafe, h1Candidates };
}

function printMismatch(report: PositionedReport): void {
  console.log(
    `  FIRST MISMATCH pos=${report.pos} [${report.label}] exe=${report.exeCount} replica=${report.repCount} safe=${report.exeSafe}`,
  );
  for (const p of report.exeOnly) {
    console.log(
      `    EXE_ONLY x=${p.x} y=${p.y ?? "?"} rot=${p.rot} m=${p.m} act=${p.act} delay=${p.delay} tuck=${p.tuck} rows=[${p.rows.join(",")}]`,
    );
  }
  for (const p of report.repOnly) {
    console.log(
      `    REP_ONLY x=${p.x} rot=${p.rot} m=${p.m} act=${p.act} delay=${p.delay} tuck=${p.tuck} rows=[${p.rows.join(",")}]`,
    );
  }
}

// Phase B: breadth comparison at search depth 2. Both engines expand all 68
// depth-1 states (generation 1 is never beam-capped), so comparing these child
// sets checks expansion away from the exe's chosen line.
console.log("expand-bfs: expanding all gen-0 children (depth-2 child sets)");
const gen0 = exe.gens.find((g) => g.gen === 0);
if (gen0 === undefined) throw new Error("no GEN 0 in the exe expand dump");
const bfsPositions: ComparePosition[] = gen0.children.map((c, i) => ({
  label: `gen1[${i}] x=${c.x} rot=${c.rot} m=${c.m} y=${c.y}`,
  board: c.rows,
  current: c.fallM,
  queue: c.queue.slice(1),
  hold: c.holdM,
  combo: c.combo,
  btb: c.btb,
}));
const bfs = comparePositions("multi", bfsPositions);
writeFileSync(new URL("report-bfs.json", EVIDENCE_DIR), `${JSON.stringify(bfs, null, 2)}\n`);
console.log(
  `  depth-2 totals: exe children=${bfs.sumExe} replica children=${bfs.sumRep}; unsafe positions=${bfs.unsafe}, unsafe with count>34 (H1-active)=${bfs.h1Candidates}`,
);
if (bfs.firstMismatch === null) {
  console.log(
    `  depth-2: all ${bfsPositions.length} position child sets match (count + set + order)`,
  );
} else {
  printMismatch(bfs.firstMismatch);
}

// Phase C: synthetic H1/H2 fuzz. Tall towers exercise ExpandBaseNode (and the
// >34 GetFilteredCount prune); holed boards exercise ExpandDeriveNode.
function rowsFromHeights(heights: readonly number[], holes: ReadonlySet<number>): number[] {
  const maxH = Math.max(...heights);
  const rows: number[] = [];
  for (let y = 0; y <= maxH; y += 1) {
    let bits = 0;
    for (let c = 0; c < 10; c += 1) {
      if ((heights[c] ?? -1) < y) continue;
      if (holes.has(c * 64 + y)) continue;
      bits |= 1 << (9 - c);
    }
    rows.push(bits);
  }
  while (rows.length < 32) rows.push(0);
  return rows;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fuzzRng = mulberry32(0x1337);
const fuzzPositions: ComparePosition[] = [];
const handBoards: readonly {
  readonly label: string;
  readonly rows: readonly number[];
  readonly current: number;
}[] = [
  {
    label: "H1 tower182",
    rows: rowsFromHeights([18, 18, 18, 18, 0, 0, 0, 0, 0, 0], new Set()),
    current: 2,
  },
  {
    label: "H1 tower17",
    rows: rowsFromHeights([17, 17, 17, 17, 17, 0, 0, 0, 0, 0], new Set()),
    current: 5,
  },
  {
    label: "H1 tower+notch",
    rows: rowsFromHeights([19, 19, 19, 18, 0, 8, 0, 0, 0, 0], new Set()),
    current: 0,
  },
  { label: "H2 c1 hole", rows: [0x300, 0x300, 0x200, 0x300], current: 1 },
  { label: "H2 T pocket", rows: [0x3ff, 0x3ff, 0x0ff, 0x001], current: 4 },
  { label: "H2 deep hole", rows: [0x3ff, 0x3ff, 0x3ff, 0x21f, 0x201], current: 4 },
];
for (const b of handBoards) {
  fuzzPositions.push({
    label: b.label,
    board: b.rows,
    current: b.current,
    queue: [0, 1, 2, 3, 4, 5, 6, 0, 1, 2],
    hold: 4,
    combo: 0,
    btb: 0,
  });
}
for (let i = 0; i < 42; i += 1) {
  const tall = i % 2 === 0;
  const heights: number[] = [];
  for (let c = 0; c < 10; c += 1) {
    heights.push(tall ? Math.floor(fuzzRng() * 21) : Math.floor(fuzzRng() * 9));
  }
  const holes = new Set<number>();
  if (!tall) {
    for (let c = 0; c < 10; c += 1) {
      const h = heights[c] ?? 0;
      if (h >= 2 && fuzzRng() < 0.35) holes.add(c * 64 + (h - 1));
    }
  }
  const queue: number[] = [];
  for (let q = 0; q < 6; q += 1) queue.push(Math.floor(fuzzRng() * 7));
  fuzzPositions.push({
    label: tall ? `tall#${i}` : `holes#${i}`,
    board: rowsFromHeights(heights, holes),
    current: Math.floor(fuzzRng() * 7),
    queue,
    hold: Math.floor(fuzzRng() * 8),
    combo: 0,
    btb: 0,
  });
}
console.log(`expand-fuzz: ${fuzzPositions.length} synthetic H1/H2 positions`);
const fuzz = comparePositions("fuzz", fuzzPositions);
writeFileSync(new URL("report-fuzz.json", EVIDENCE_DIR), `${JSON.stringify(fuzz, null, 2)}\n`);
console.log(
  `  fuzz totals: exe children=${fuzz.sumExe} replica children=${fuzz.sumRep}; unsafe positions=${fuzz.unsafe}, unsafe with count>34 (H1-active)=${fuzz.h1Candidates}`,
);
if (fuzz.firstMismatch === null) {
  console.log(`  fuzz: all ${fuzzPositions.length} synthetic position child sets match`);
} else {
  printMismatch(fuzz.firstMismatch);
}

lines.push("## Depth-2 breadth (all 68 gen-1 states)");
lines.push("");
lines.push(`- Exe total children at depth 2: ${bfs.sumExe}; replica: ${bfs.sumRep}.`);
lines.push(
  `- Unsafe positions: ${bfs.unsafe}; unsafe with childCount>34 (H1 prune active): ${bfs.h1Candidates}.`,
);
if (bfs.firstMismatch === null) {
  lines.push("- All 68 depth-1 state child sets match (count, set, order).");
} else {
  lines.push(
    `- First mismatch: position ${bfs.firstMismatch.pos} (exe=${bfs.firstMismatch.exeCount}, replica=${bfs.firstMismatch.repCount}).`,
  );
}
lines.push("");
lines.push("## Synthetic H1/H2 fuzz");
lines.push("");
lines.push(`- Positions: ${fuzzPositions.length}.`);
lines.push(`- Exe total children: ${fuzz.sumExe}; replica: ${fuzz.sumRep}.`);
lines.push(
  `- Unsafe positions: ${fuzz.unsafe}; unsafe with childCount>34 (H1 prune active): ${fuzz.h1Candidates}.`,
);
if (fuzz.firstMismatch === null) {
  lines.push("- All synthetic position child sets match (count, set, order).");
} else {
  lines.push(
    `- First mismatch: position ${fuzz.firstMismatch.pos} (${fuzz.firstMismatch.label}); exe=${fuzz.firstMismatch.exeCount}, replica=${fuzz.firstMismatch.repCount}, safe=${fuzz.firstMismatch.exeSafe}.`,
  );
}
lines.push("");

const repSwaps = fuzz.reports.filter((r) => {
  if (r.setMatch) return false;
  const exeBoards = r.exeOnly.map((p) => p.rows.join(",")).sort();
  const repBoards = r.repOnly.map((p) => p.rows.join(",")).sort();
  return JSON.stringify(exeBoards) === JSON.stringify(repBoards);
});
const boardsMultisetMatch = (r: GenReport): boolean => {
  const exeBoards = r.exeOnly.map((p) => p.rows.join(",")).sort();
  const repBoards = r.repOnly.map((p) => p.rows.join(",")).sort();
  return JSON.stringify(exeBoards) === JSON.stringify(repBoards);
};
const missingBoardReports = [
  ...reports.filter((r) => !r.countMatch || !boardsMultisetMatch(r)),
  ...bfs.reports.filter((r) => !r.countMatch || !boardsMultisetMatch(r)),
  ...fuzz.reports.filter((r) => !r.countMatch || !boardsMultisetMatch(r)),
];
lines.push("## Verdict");
lines.push("");
if (missingBoardReports.length === 0) {
  lines.push(
    "- No missing or extra child boards anywhere: counts and final boards match along the exe's chosen line, across all 68 depth-1 states, and across the 48-state H1/H2 fuzz.",
  );
  lines.push(
    "- H1 (`get_filtered_count`) and H2 (derive BFS) are not evidenced as causes of the turn-183 divergence; the node-count difference must come from different beam membership (evaluation/tie-break), not from child generation.",
  );
} else {
  lines.push(`- A child-board difference was found in ${missingBoardReports.length} position(s).`);
}
if (repSwaps.length > 0) {
  lines.push(
    `- ${repSwaps.length}/${fuzzPositions.length} fuzz positions differ only in which equal-delay duplicate placement representative survives dedup (same final boards; e.g. pos ${repSwaps[0]?.pos}); these are label/order differences, not missing boards.`,
  );
}
lines.push("");

writeFileSync(new URL("REPORT.md", EVIDENCE_DIR), `${lines.join("\n")}\n`);

for (const r of reports) {
  if (!r.countMatch || !r.setMatch) {
    console.log(
      `FIRST MISMATCH gen=${r.gen}: exe=${r.exeCount} replica=${r.repCount} safe=${r.exeSafe}; exeOnly=${r.exeOnly.length} repOnly=${r.repOnly.length}`,
    );
    for (const p of r.exeOnly) {
      console.log(
        `  EXE_ONLY x=${p.x} y=${p.y ?? "?"} rot=${p.rot} m=${p.m} act=${p.act} delay=${p.delay} tuck=${p.tuck} rows=[${p.rows.join(",")}]`,
      );
    }
    for (const p of r.repOnly) {
      console.log(
        `  REP_ONLY x=${p.x} rot=${p.rot} m=${p.m} act=${p.act} delay=${p.delay} tuck=${p.tuck} rows=[${p.rows.join(",")}]`,
      );
    }
    break;
  }
}
if (firstMismatch === null && stopReason !== null) console.log(`walk stopped: ${stopReason}`);
console.log(`artifacts: evidence/hoiko-fullgame/${NAME}/REPORT.md`);
