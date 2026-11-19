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
import {
  createAttaxDecider,
  engineIdentity,
  engineTimingSummary,
  type PublicDecision,
  tripwireWarningText,
} from "./attax-player.js";

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

/**
 * The corpus surface runs at the shipped standard width, pinned explicitly:
 * the digest is the identity proof for this surface, so a future change of
 * the shipped default must not silently recompute it. Re-pinning the digest
 * for a new width is a deliberate act (CI holds the pin). Width 96 since the
 * 2026-11-16 landing (the width-48 digest d12375f7… is the pre-landing
 * artifact, kept in the hookup record).
 */
const CORPUS_WIDTH = 96;

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
// Decisions run through decideAsync (the Rust engine's server mode) and, with
// ATTAX_CORPUS_WORKERS > 1, across that many engine servers in parallel. Lines
// are reassembled in corpus order, so the digest is worker-count invariant.
const workers = Math.max(1, Number(process.env.ATTAX_CORPUS_WORKERS ?? 4));
for (const profile of profiles) {
  const label = profile ?? "default";
  const deciders = Array.from({ length: workers }, () =>
    createAttaxDecider(profile, { width: CORPUS_WIDTH }),
  );
  const results = new Array<string>(corpus.length);
  let next = 0;
  await Promise.all(
    deciders.map(async (decider) => {
      while (true) {
        const i = next++;
        if (i >= corpus.length) return;
        const c = corpus[i] as (typeof corpus)[number];
        results[i] =
          `${c.id}\t${label}\t${JSON.stringify(plain(await decider.decideAsync(c.observation)))}`;
      }
    }),
  );
  for (const d of deciders) d.close();
  lines.push(...results);
  console.error(`${label}: ${corpus.length} decisions (profileId ${deciders[0]?.profileId})`);
}
const body = `${lines.join("\n")}\n`;
writeFileSync(out, body);
const sha256 = createHash("sha256").update(body).digest("hex");
console.error(`wrote ${lines.length} lines to ${out}; sha256 ${sha256}`);
// Engine identity is a required part of every corpus record. It lives in this
// sidecar (and the stderr summary) rather than in the TSV rows so the digest
// stays byte-comparable with historical corpus runs.
const engine = engineIdentity();
const timing = engineTimingSummary();
const sidecar = { engine, rows: lines.length, sha256, timing };
writeFileSync(`${out}.engine.json`, `${JSON.stringify(sidecar, null, 2)}\n`);
console.error(
  `engine: ${engine.id} (build ${engine.build}); median ${timing.medianMs?.toFixed(1)} ms/decision over ${timing.decisions} decisions; record: ${out}.engine.json`,
);
const tripwire = tripwireWarningText();
if (tripwire) console.error(tripwire);
