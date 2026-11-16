/**
 * S2 decision corpus for off-identity proofs of evaluator/search changes.
 *
 * The corpus (`evidence/adopt-s2-corpus.jsonl.gz`) is 180 public S2 decisions sampled from
 * the imitation datasets (attax-s2/imitation/dataset_raw_s{0,1}.jsonl): 15 per stratum of
 * (garbage on board, pending > 0, B2B > 0, rows due this lock), chosen by sha256(recordId).
 * Each line: {id, stratum, observation: PublicDecision}.
 *
 * This runner replays every decision through `createAttaxDecider(profile)` — the exact
 * path the S2 lab uses — and writes one digest line per decision with the full search
 * result (best step, line, value, candidates, nodes, depth). Run it on two commits and
 * compare the digests: identical files mean bit-identical decisions and values.
 *
 * Usage: bun tools/s2-lab/decision-corpus.ts DIGEST.tsv [--profile FILE]... [--limit N]
 *   No --profile = DEFAULT_WEIGHTS with no mechanisms. Several --profile flags run each
 *   configuration in turn ("default" names the default configuration).
 *   ATTAX_S2_* env overrides must be unset (checked).
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type { SearchResult } from "../../src/ai/bot/search.js";
import { createAttaxDecider, type PublicDecision } from "./attax-player.js";

const args = process.argv.slice(2);
const out = args.shift();
if (out === undefined) throw new Error("usage: decision-corpus.ts DIGEST.tsv [--profile F]...");
const profiles: (string | undefined)[] = [];
let limit = Number.POSITIVE_INFINITY;
let corpusPath = new URL("./evidence/adopt-s2-corpus.jsonl.gz", import.meta.url).pathname;
while (args.length > 0) {
  const a = args.shift() as string;
  if (a === "--profile") {
    const p = args.shift() as string;
    profiles.push(p === "default" ? undefined : p);
  } else if (a === "--limit") limit = Number(args.shift());
  else if (a === "--corpus") corpusPath = args.shift() as string;
  else throw new Error(`unknown arg ${a}`);
}
if (profiles.length === 0) profiles.push(undefined);
for (const key of Object.keys(process.env))
  if (key.startsWith("ATTAX_S2_")) throw new Error(`unset ${key} for a corpus run`);

const corpus = gunzipSync(readFileSync(corpusPath))
  .toString("utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .slice(0, limit)
  .map((l) => JSON.parse(l) as { id: string; observation: PublicDecision });

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

const lines: string[] = [];
for (const profile of profiles) {
  const decider = createAttaxDecider(profile);
  const label = profile ?? "default";
  for (const c of corpus) {
    lines.push(`${c.id}\t${label}\t${JSON.stringify(plain(decider.decide(c.observation)))}`);
  }
  console.error(`${label}: ${corpus.length} decisions (profileId ${decider.profileId})`);
}
const body = `${lines.join("\n")}\n`;
writeFileSync(out, body);
console.error(
  `wrote ${lines.length} lines to ${out}; sha256 ${createHash("sha256").update(body).digest("hex")}`,
);
