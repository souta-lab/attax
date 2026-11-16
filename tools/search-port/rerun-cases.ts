/**
 * Re-run the TS search on an existing agreement corpus (`dump-cases.ts` output, e.g.
 * `rust/search-port-evidence/cases.jsonl.gz` decompressed) and write a fresh corpus whose
 * `expect` fields come from the CURRENT TS source.
 *
 * Used for off-identity proofs: run it on two commits and compare the `--digest` files —
 * identical digests mean every decision, value, candidate list, node count and depth is
 * bit-identical. The output corpus also feeds `attax-agree` (Rust vs current TS).
 *
 * Usage: bun tools/search-port/rerun-cases.ts IN.jsonl OUT.jsonl [--digest FILE]
 *          [--weights default|case|FILE.json]
 *   --weights default (the default): the current DEFAULT_WEIGHTS, i.e. the build as shipped.
 *   --weights case: the weights object recorded in each case.
 *   Timing is not recorded (tsMs = 0) so outputs are deterministic.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { type SearchInput, type SearchResult, search } from "../../src/ai/bot/search.js";
import { DEFAULT_WEIGHTS, type Weights } from "../../src/ai/bot/weights.js";

const args = process.argv.slice(2);
const input = args.shift();
const output = args.shift();
if (input === undefined || output === undefined)
  throw new Error("usage: rerun-cases.ts IN.jsonl OUT.jsonl [--digest FILE] [--weights ...]");
let digestPath: string | undefined;
let weightsMode = "default";
while (args.length > 0) {
  const a = args.shift() as string;
  if (a === "--digest") digestPath = args.shift();
  else if (a === "--weights") weightsMode = args.shift() as string;
  else throw new Error(`unknown arg ${a}`);
}
const fileWeights: Weights | undefined =
  weightsMode !== "default" && weightsMode !== "case"
    ? JSON.parse(readFileSync(weightsMode, "utf8"))
    : undefined;

const plain = (r: SearchResult | null) =>
  r === null
    ? null
    : {
        best: r.best,
        line: r.line,
        value: r.value,
        candidates: r.candidates,
        nodes: r.nodes,
        depth: r.depth,
      };

const out: string[] = [];
const digest: string[] = [];
for (const line of readFileSync(input, "utf8").split("\n")) {
  if (line.trim() === "") continue;
  const c = JSON.parse(line);
  const weights: Weights =
    weightsMode === "default" ? DEFAULT_WEIGHTS : weightsMode === "case" ? c.weights : fileWeights;
  const searchInput: SearchInput = { ...c.input, board: Uint16Array.from(c.input.board) };
  const expect = plain(search(searchInput, { weights, ...c.options }));
  out.push(
    JSON.stringify({ id: c.id, input: c.input, options: c.options, weights, expect, tsMs: 0 }),
  );
  digest.push(`${c.id}\t${JSON.stringify(expect)}`);
}
writeFileSync(output, `${out.join("\n")}\n`);
const body = `${digest.join("\n")}\n`;
if (digestPath !== undefined) writeFileSync(digestPath, body);
console.error(
  `rerun ${out.length} cases -> ${output}; expect digest sha256 ${createHash("sha256").update(body).digest("hex")}`,
);
