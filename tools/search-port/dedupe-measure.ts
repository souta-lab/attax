/**
 * Measure what the beam dedupe key changes (audit 2026-11-14: combo/lift in the key).
 *
 * Builds two instrumented copies of src/ai/bot/search.ts in a scratch directory: "old"
 * uses the pre-audit key (next|hold|b2b|board) and "new" uses the current key. Both count,
 * over the children examined before the beam fills, how many the OLD key would drop as
 * duplicates and how many the NEW key would drop. Then each copy searches the same inputs,
 * and the first moves are compared.
 *
 * Inputs:
 *   - competition corpus: cases JSONL from tools/search-port/dump-cases.ts (guideline,
 *     40 rows, width 96, no diversity, recorded boards, pending 0 as the TBP adapter sends);
 *   - Hoiko-benchmark path: every bot decision of one fixed-seed bot-vs-Hoiko game, with the
 *     benchmark's bot options (scripts/benchmark.ts: width 48, no guideline, real pending).
 *
 * Usage: bun tools/search-port/dedupe-measure.ts CASES.jsonl [SEED] [BENCH_CASES_OUT.jsonl]
 *   The optional third argument writes the Hoiko-path decisions as attax-agree cases
 *   (expect = current src/ai/bot/search.ts) so the Rust port can be checked on them.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createBot, snapshotBoard } from "../../src/ai/bot/fighter.js";
import type { SearchInput, SearchOptions, SearchResult } from "../../src/ai/bot/search.js";
import { DEFAULT_WEIGHTS } from "../../src/ai/bot/weights.js";
import { resolveFaithfulHoikoOptions } from "../../src/ai/hoiko/faithful.js";
import { runMatch } from "../../src/bench/match.js";
import type { GameSnapshot } from "../../src/core/types.js";
import type { VersusFighter } from "../../src/versus/controller.js";
import { createHoiko } from "../hoiko-node.js";

const [casesPath, seedArg, benchOut] = process.argv.slice(2);
if (casesPath === undefined) throw new Error("usage: dedupe-measure.ts CASES.jsonl [SEED]");
const seed = Number(seedArg ?? 2001);

const here = dirname(new URL(import.meta.url).pathname);
const botDir = resolve(here, "../../src/ai/bot");
const scratch = join(here, ".gen-dedupe");
const source = readFileSync(join(botDir, "search.ts"), "utf8").replaceAll(
  /from "\.(\.?)\/([^"]+)"/g,
  (_m, up: string, path: string) =>
    `from "${up ? resolve(botDir, "..", path) : join(botDir, path)}"`,
);
// The current key line of `dedupe` (the one that reads the folded `combo`).
const NEW_KEY = /const key = `[^`\n]*\|\$\{combo\}\|[^`\n]*`;/.exec(source)?.[0];
if (NEW_KEY === undefined) throw new Error("search.ts key line changed; update the script");
const COUNT = `
    const oldKey = \`\${node.next}|\${node.hold}|\${node.b2b ? 1 : 0}|\${node.board.join(",")}\`;
    globalThis.__dd.examined += 1;
    const __o = __oldSeen.get(oldKey);
    if (__o !== undefined) {
      globalThis.__dd.oldDup += 1;
      if (!__newSeen.has(key)) {
        if (__o.lift !== node.lift) globalThis.__dd.byLift += 1;
        else if (__o.combo !== combo) globalThis.__dd.byCombo += 1;
        else globalThis.__dd.byOther += 1;
      }
    }
    if (__newSeen.has(key)) globalThis.__dd.newDup += 1;
    if (__o === undefined) __oldSeen.set(oldKey, { lift: node.lift, combo });
    __newSeen.add(key);`;
function variant(name: string, useOld: boolean): string {
  let text = source.replace(
    "const seen = new Set<string>();",
    "const seen = new Set<string>();\n  const __oldSeen = new Map<string, { lift: number; combo: number }>();\n  const __newSeen = new Set<string>();",
  );
  text = text.replace(
    NEW_KEY,
    `${NEW_KEY}${COUNT}${useOld ? "\n    const __k = oldKey;" : "\n    const __k = key;"}`,
  );
  // Only the dedupe loop: its `seen.has(key)` / `seen.add(key)` follow the inserted block.
  const at = text.indexOf("const __k");
  text =
    text.slice(0, at) +
    text
      .slice(at)
      .replace("if (seen.has(key)) continue;", "if (seen.has(__k)) continue;")
      .replace("seen.add(key);", "seen.add(__k);");
  const file = join(scratch, `${name}.ts`);
  writeFileSync(file, `// @ts-nocheck\n${text}`);
  return file;
}

interface Tally {
  examined: number;
  oldDup: number;
  newDup: number;
  byLift: number;
  byCombo: number;
  byOther: number;
}
declare global {
  var __dd: Tally;
}

type SearchFn = (input: SearchInput, options: SearchOptions) => SearchResult | null;

function key(r: SearchResult | null): string {
  if (r === null) return "null";
  const p = r.best.placement;
  return `${p.kind}${p.rotation}@${p.x},${p.y}${r.best.usedHold ? "h" : ""}`;
}

function measure(
  label: string,
  cases: { input: SearchInput; options: SearchOptions }[],
  oldSearch: SearchFn,
  newSearch: SearchFn,
): void {
  const run = (fn: SearchFn) => {
    globalThis.__dd = { examined: 0, oldDup: 0, newDup: 0, byLift: 0, byCombo: 0, byOther: 0 };
    const out = cases.map((c) => fn(c.input, c.options));
    return { out, tally: globalThis.__dd };
  };
  const a = run(oldSearch);
  const b = run(newSearch);
  let same = 0;
  for (let i = 0; i < cases.length; i += 1)
    if (key(a.out[i] ?? null) === key(b.out[i] ?? null)) same += 1;
  const pct = (n: number, d: number) => `${((100 * n) / Math.max(1, d)).toFixed(2)}%`;
  const withPending = cases.filter((c) => c.input.pending > 0).length;
  console.log(`\n## ${label}: ${cases.length} decisions (${withPending} with pending garbage > 0)`);
  for (const [name, r] of [
    ["old key search", a],
    ["new key search", b],
  ] as const) {
    const t = r.tally;
    console.log(
      `${name}: examined ${t.examined}, dropped by old key ${t.oldDup} (${pct(t.oldDup, t.examined)}), by new key ${t.newDup} (${pct(t.newDup, t.examined)}), merged-but-distinct ${t.oldDup - t.newDup} (${pct(t.oldDup - t.newDup, t.examined)}; first differing field lift ${t.byLift}, combo ${t.byCombo}, other ${t.byOther})`,
    );
  }
  console.log(`first-move agreement old vs new: ${same}/${cases.length}`);
}

rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
try {
  const oldSearch: SearchFn = (await import(variant("old", true))).search;
  const newSearch: SearchFn = (await import(variant("new", false))).search;

  // Competition corpus.
  const corpus = readFileSync(casesPath, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const c = JSON.parse(l);
      return {
        input: { ...c.input, board: Uint16Array.from(c.input.board) } as SearchInput,
        options: { ...c.options, weights: c.weights ?? DEFAULT_WEIGHTS } as SearchOptions,
      };
    });
  measure("competition corpus (guideline, TBP pending=0)", corpus, oldSearch, newSearch);

  // Hoiko-benchmark path: record the bot's inputs in one fixed-seed game.
  const recorded: { input: SearchInput; options: SearchOptions }[] = [];
  const bot = createBot();
  const recorder: VersusFighter = {
    ...bot,
    findBestMove(snapshot: GameSnapshot) {
      const active = snapshot.active;
      if (active !== null && !snapshot.gameOver) {
        recorded.push({
          input: {
            board: snapshotBoard(snapshot),
            active: {
              kind: active.kind,
              rotation: active.rotation,
              x: active.posX,
              y: active.posY,
            },
            hold: snapshot.hold,
            canHold: snapshot.canHold,
            preview: snapshot.next.slice(0, 5),
            speculativePieces: [],
            b2b: snapshot.b2b,
            combo: snapshot.combo,
            pending: snapshot.pendingGarbage,
          },
          options: {
            weights: DEFAULT_WEIGHTS,
            width: 48,
            diverse: false,
            exposure: 0,
            guideline: false,
          },
        });
      }
      return bot.findBestMove(snapshot);
    },
  };
  const hoiko = createHoiko(resolveFaithfulHoikoOptions({ HOIKO_ADAPT: "0" }));
  const record = runMatch(recorder, hoiko, seed);
  console.log(
    `\nrecorded game seed ${seed} (bot left, current tree): winner ${record.winner}, ticks ${record.ticks}`,
  );
  measure(
    `Hoiko-benchmark path (seed ${seed}, width 48, no guideline)`,
    recorded,
    oldSearch,
    newSearch,
  );
  if (benchOut !== undefined) {
    const { search } = await import("../../src/ai/bot/search.js");
    const lines = recorded.map((c, k) => {
      const r = search(c.input, c.options);
      const { weights, ...options } = c.options;
      return JSON.stringify({
        id: `bench-${seed}:${k}`,
        input: { ...c.input, board: [...c.input.board] },
        options,
        weights,
        expect:
          r === null
            ? null
            : {
                best: r.best,
                line: r.line,
                value: r.value,
                candidates: r.candidates,
                nodes: r.nodes,
                depth: r.depth,
              },
        tsMs: 0,
      });
    });
    writeFileSync(benchOut, `${lines.join("\n")}\n`);
    console.log(`wrote ${lines.length} agree cases to ${benchOut}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
