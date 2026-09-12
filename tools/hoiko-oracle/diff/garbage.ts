/**
 * Versus-level differential: the shipping `Hoiko.exe` stub (right fighter) vs the
 * Rust/WASM replica on identical `GameSnapshot`s, including pending garbage and
 * the OffsetOffAI sync state machine.
 *
 *   bun garbage.ts [--seeds=1,2,7] [--cap=120] [--max-ticks=20000] [--tick=16] [--name=]
 *
 * Left fighter: DeepSeek v2 (Rust/WASM) generates real attacks/garbage. Right:
 * one Wine query per think (fresh process, `timer=1`, `adapt:false`-equivalent
 * regime) plus a same-snapshot replica query; every think is compared on
 * move `(x, rot, m)`, `act`, `garbageWait`, `useHold` and the full carried
 * OffsetOffAI state. First mismatch stops the seed and is dumped raw.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { FAITHFUL_HOIKO } from "../../../src/ai/hoiko-faithful.js";
import { resolveVersusConfig } from "../../../src/versus/config.js";
import { createVersusController, VERSUS_DEFAULTS } from "../../../src/versus/controller.js";
import { createRustDeepSeekV2 } from "../../deepseek-rust/loader.js";
import { createRustHoiko } from "../../hoiko-rust/loader.js";
import { createExeFighter, type ExeTurn } from "./exe-fighter.js";

const EVIDENCE_DIR = new URL("../../../evidence/hoiko-fullgame/garbage/", import.meta.url);

const args = Bun.argv.slice(2);

function argValue(flag: string): string | undefined {
  const hit = args.find((a) => a.startsWith(`${flag}=`));
  return hit === undefined ? undefined : hit.slice(flag.length + 1);
}

function readInt(flag: string, fallback: number): number {
  const raw = argValue(flag);
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${flag} must be a positive integer`);
  return value;
}

const seeds = (argValue("--seeds") ?? "1")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10));
if (seeds.some((seed) => !Number.isInteger(seed))) throw new Error("--seeds must be integers");
const cap = readInt("--cap", 120);
const maxTicks = readInt("--max-ticks", 20000);
const tickMs = readInt("--tick", 16);
// Synthetic garbage pressure (coverage for the garbageWait=1 branch): rows
// injected into the right core via `receiveGarbage` every `--pressure-every`
// ticks. Default 0 = pure DeepSeek attacks. Both engines see identical
// snapshots; only the attacker is artificial.
const pressure = Number.parseInt(argValue("--pressure") ?? "0", 10);
const pressureEvery = readInt("--pressure-every", 96);
if (!Number.isInteger(pressure) || pressure < 0) throw new Error("--pressure must be >= 0");
// Stress-only: larger `garbageDelay` keeps rows pending across more locks so
// the wait decision is observable on a low stack. Snapshots stay identical
// for both engines; the app's canonical config stays `resolveVersusConfig()`.
const garbageDelay = Number.parseInt(argValue("--garbage-delay") ?? "1", 10);
if (!Number.isInteger(garbageDelay) || garbageDelay < 1)
  throw new Error("--garbage-delay must be >= 1");
const name = argValue("--name") ?? "";
const prefix = name === "" ? "" : `${name}-`;

interface SeedSummary {
  readonly seed: number;
  readonly cap: number;
  readonly pressure: number;
  readonly ticks: number;
  readonly pieces: number;
  readonly winner: string | null;
  readonly reason: string;
  readonly rightThinks: number;
  readonly exeWallSeconds: number;
  readonly thinksWithPendingGarbage: number;
  readonly exeGarbageWaits: number;
  readonly replicaGarbageWaits: number;
  readonly divergence: {
    readonly index: number;
    readonly snapshot: ExeTurn["snapshot"];
    readonly exe: ExeTurn["exe"];
    readonly replica: ExeTurn["replica"];
    readonly match: ExeTurn["match"];
    readonly wallMs: number;
  } | null;
  readonly final: unknown;
}

function runSeed(seed: number): SeedSummary {
  const replica = createRustHoiko({ ...FAITHFUL_HOIKO, adapt: false });
  const left = createRustDeepSeekV2({});
  const jsonlUrl = new URL(`${prefix}seed${seed}.jsonl`, EVIDENCE_DIR);
  writeFileSync(jsonlUrl, "");
  let rightThinks = 0;
  let exeWallMs = 0;
  let thinksWithPendingGarbage = 0;
  let exeGarbageWaits = 0;
  let replicaGarbageWaits = 0;
  let divergence: ExeTurn | null = null;

  const exeFighter = createExeFighter(replica, (turn: ExeTurn) => {
    appendFileSync(jsonlUrl, `${JSON.stringify(turn)}\n`);
    rightThinks += 1;
    exeWallMs += turn.wallMs;
    if (turn.snapshot.pendingGarbage > 0) thinksWithPendingGarbage += 1;
    if (turn.exe?.garbageWait === true) exeGarbageWaits += 1;
    if (turn.replica !== null && turn.replica.garbageWait === 1) replicaGarbageWaits += 1;
    if (!turn.match.all && divergence === null) divergence = turn;
  });

  const controller = createVersusController(
    left,
    exeFighter,
    seed,
    resolveVersusConfig({ garbageDelay }),
  );
  let ticks = 0;
  while (
    controller.result === null &&
    controller.pieces < cap &&
    ticks < maxTicks &&
    divergence === null
  ) {
    if (pressure > 0 && ticks % pressureEvery === 0) {
      controller.right.core.receiveGarbage?.(pressure);
    }
    controller.tick(tickMs, VERSUS_DEFAULTS);
    ticks += 1;
  }

  const leftSnap = controller.left.core.getSnapshot();
  const rightSnap = controller.right.core.getSnapshot();
  const result = controller.result;
  const reason =
    result?.reason ??
    (divergence !== null ? "divergence" : ticks >= maxTicks ? "max-ticks" : "cap");
  const summary: SeedSummary = {
    seed,
    cap,
    pressure,
    ticks,
    pieces: controller.pieces,
    winner: result?.winner ?? null,
    reason,
    rightThinks,
    exeWallSeconds: Math.round(exeWallMs / 1000),
    thinksWithPendingGarbage,
    exeGarbageWaits,
    replicaGarbageWaits,
    divergence:
      divergence === null
        ? null
        : {
            index: divergence.index,
            snapshot: divergence.snapshot,
            exe: divergence.exe,
            replica: divergence.replica,
            match: divergence.match,
            wallMs: divergence.wallMs,
          },
    final: {
      left: {
        lockId: leftSnap.lockId,
        lines: leftSnap.lines,
        pendingGarbage: leftSnap.pendingGarbage,
        gameOver: leftSnap.gameOver,
        lastAction: leftSnap.lastAction,
      },
      right: {
        lockId: rightSnap.lockId,
        lines: rightSnap.lines,
        pendingGarbage: rightSnap.pendingGarbage,
        gameOver: rightSnap.gameOver,
        lastAction: rightSnap.lastAction,
      },
    },
  };
  writeFileSync(
    new URL(`${prefix}summary-seed${seed}.jsonl`, EVIDENCE_DIR),
    `${JSON.stringify(summary)}\n`,
  );

  if (divergence !== null) {
    const base = `${prefix}divergence-seed${seed}-turn${divergence.index}`;
    writeFileSync(
      new URL(`${base}.json`, EVIDENCE_DIR),
      `${JSON.stringify({ summary, turn: divergence, exeInput: divergence.exeInput }, null, 2)}\n`,
    );
    if (divergence.exeRaw !== null) {
      writeFileSync(new URL(`${base}.log`, EVIDENCE_DIR), divergence.exeRaw);
    }
    console.log(
      `seed ${seed}: DIVERGENCE think=${divergence.index} ` +
        `move=${divergence.match.move} act=${divergence.match.act} ` +
        `garbageWait=${divergence.match.garbageWait} useHold=${divergence.match.useHold} ` +
        `weightIndex=${divergence.match.weightIndex} ` +
        `offsetDiffs=${JSON.stringify(divergence.match.offsetDiffs)}`,
    );
  } else {
    console.log(
      `seed ${seed}: FULL AGREEMENT ${rightThinks}/${rightThinks} right thinks ` +
        `(pieces=${controller.pieces}, reason=${reason}, pendingGarbageTurns=${thinksWithPendingGarbage}, ` +
        `garbageWait exe=${exeGarbageWaits} replica=${replicaGarbageWaits}, exe ${Math.round(exeWallMs / 1000)}s)`,
    );
  }
  return summary;
}

mkdirSync(EVIDENCE_DIR, { recursive: true });
const summaries = seeds.map((seed) => runSeed(seed));

const anyDivergence = summaries.some((summary) => summary.divergence !== null);
const verdict = anyDivergence
  ? `DIVERGENCE on ${summaries
      .filter((s) => s.divergence !== null)
      .map((s) => `seed ${s.seed} think ${s.divergence?.index}`)
      .join(", ")}`
  : `FULL AGREEMENT on all ${summaries.length} seed(s): ${summaries
      .map((s) => `${s.rightThinks} thinks (seed ${s.seed})`)
      .join(", ")}`;

const report = [
  "# Versus garbage/OffsetAI differential — shipping Hoiko.exe vs Rust/WASM replica",
  "",
  `Run: ${new Date().toISOString()}`,
  `Args: seeds=${seeds.join(",")} cap=${cap} maxTicks=${maxTicks} tick=${tickMs} pressure=${pressure} pressureEvery=${pressureEvery} garbageDelay=${garbageDelay}${name === "" ? "" : ` name=${name}`}`,
  "",
  "## Verdict",
  "",
  `**${verdict}**`,
  "",
  "## Setup",
  "",
  "- Right fighter: one fresh `Hoiko.exe` (Wine oracle stub) per think, `timer=1` (depth 14, beam 150), `adapt:false`-equivalent.",
  "- Right replica: persistent `createRustHoiko({...FAITHFUL_HOIKO, adapt:false})`, queried on the identical snapshot each think.",
  "- Left fighter: Rust/WASM DeepSeek v2 (generates attacks/garbage); engine `src/core/engine.ts` seeded per seed, `resolveVersusConfig()` (aligned garbage, 1-lock delay).",
  pressure > 0
    ? `- Pressure mode: ${pressure} extra garbage rows injected into the right core every ${pressureEvery} ticks (coverage for garbageWait=1). Snapshots stay identical for both engines.`
    : "- Natural mode: no injected garbage (DeepSeek attacks only).",
  garbageDelay === 1
    ? "- Garbage delay: canonical `GARBAGE_DELAY=1`."
    : `- Garbage delay: ${garbageDelay} (stress-only deviation from the canonical config; snapshots stay identical for both engines).`,
  "- Exe input per think: board(32 bottom-up) + next(28, current first) + hold + combo + b2b + timer=1 + garbage + nowms + iseven + sync=1 + offsetenabled=1 + carried `useoffset/ofs*/gb*/haslast*` + own/opp lock sync fields.",
  "- Stub applies the carried OffsetOffAI statics at native RVAs (0x6638C/0x66390/0x663A0), mirrors `offset_driver.rs::sync`, runs `SearchAI.Search`, then `DecisionOffsetOff` + `IsLocked`/`CanOffsetOff` and prints `garbageWait` + `OFFSET post`.",
  "- Compared per think: move `(x, rot, m)`, `act`, `garbageWait`, `useHold`, and all 15 carried OffsetOffAI state fields.",
  "",
  "## Results",
  "",
] as string[];

for (const summary of summaries) {
  report.push(
    `### seed ${summary.seed}`,
    "",
    `- Right thinks: **${summary.rightThinks}**; pieces: **${summary.pieces}**; pressure: ${summary.pressure}; winner: ${summary.winner ?? "n/a"}; reason: **${summary.reason}**.`,
    `- Pending-garbage turns: **${summary.thinksWithPendingGarbage}**; garbageWait=1 turns: exe **${summary.exeGarbageWaits}**, replica **${summary.replicaGarbageWaits}**.`,
    `- Exe wall time: ${summary.exeWallSeconds}s.`,
    summary.divergence === null
      ? "- **All compared fields agreed.**"
      : `- **FIRST DIVERGENCE** at think ${summary.divergence.index}: move=${summary.divergence.match.move} act=${summary.divergence.match.act} garbageWait=${summary.divergence.match.garbageWait} useHold=${summary.divergence.match.useHold} weightIndex=${summary.divergence.match.weightIndex} offsetDiffs=${JSON.stringify(summary.divergence.match.offsetDiffs)}.`,
    "",
  );
}
report.push(
  "## Artifacts",
  "",
  ...summaries.map(
    (s) =>
      `- seed ${s.seed}: \`${prefix}seed${s.seed}.jsonl\`, \`${prefix}summary-seed${s.seed}.jsonl\`${s.divergence === null ? "" : `, \`${prefix}divergence-seed${s.seed}-turn${s.divergence.index}.json/.log\``}`,
  ),
  "",
);
writeFileSync(new URL(`${prefix}REPORT.md`, EVIDENCE_DIR), report.join("\n"));

console.log(`artifacts: evidence/hoiko-fullgame/garbage/${prefix}REPORT.md`);
process.exit(anyDivergence ? 1 : 0);
