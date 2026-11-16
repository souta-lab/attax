/**
 * Dump the S2 decision corpus as attax-search-cli cases (JSONL) with TS expectations.
 *
 * Mirrors tools/s2-lab/decision-corpus.ts exactly: the same corpus file, the same
 * profiles, and expectations from `createAttaxDecider(profile).decide(observation)` —
 * the production lab path. Each case carries the projected shared input
 * (projectAttax + toSharedInput), the merged profile weights, and the resolved
 * mechanism options, so the Rust CLI can replay the decision bit for bit.
 *
 * Usage: bun tools/search-port/dump-s2-cases.ts OUT.jsonl [--profile FILE]...
 *   No --profile = the standard 4 profiles of the corpus digest gate.
 *   ATTAX_S2_* env overrides must be unset (checked, like the corpus runner).
 *   Must run with ATTAX_ENGINE=ts-reference: the expectations recorded here are
 *   the TS reference's by definition — dumping them from the Rust engine would
 *   make the agreement harness compare Rust against itself.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { BOT_DEFAULTS } from "../../src/ai/bot/fighter.js";
import type { SearchResult } from "../../src/ai/bot/search.js";
import {
  createAttaxDecider,
  engineIdentity,
  type PublicDecision,
  projectAttax,
} from "../s2-lab/attax-player.js";
import { toSharedInput } from "../s2-lab/s2-input.js";

if (engineIdentity().id !== "ts-reference")
  throw new Error(
    "dump-s2-cases records TS reference expectations: run with ATTAX_ENGINE=ts-reference",
  );

const args = process.argv.slice(2);
const out = args.shift();
if (out === undefined) throw new Error("usage: dump-s2-cases.ts OUT.jsonl [--profile F]...");
const profiles: (string | undefined)[] = [];
while (args.length > 0) {
  const a = args.shift() as string;
  if (a === "--profile") {
    const p = args.shift() as string;
    profiles.push(p === "default" ? undefined : p);
  } else throw new Error(`unknown arg ${a}`);
}
if (profiles.length === 0) {
  profiles.push(
    undefined,
    "tools/s2-lab/profiles/s2-tuned.json",
    "tools/s2-lab/profiles/s2-ports.json",
    "tools/s2-lab/profiles/league/snap-L60.json",
  );
}
for (const key of Object.keys(process.env))
  if (key.startsWith("ATTAX_S2_")) throw new Error(`unset ${key} for a case dump`);

const corpusPath = new URL("../s2-lab/evidence/adopt-s2-corpus.jsonl.gz", import.meta.url).pathname;
const corpus = gunzipSync(readFileSync(corpusPath))
  .toString("utf8")
  .split("\n")
  .filter((l) => l.trim() !== "")
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
  // Mechanism resolution with ATTAX_S2_* unset (enforced above): the profile's own
  // sections, with the decider's mode rule (a solvency section implies "soft"
  // unless the profile names a mode; "hard" swaps the penalty for the root veto).
  const mechanisms = decider.mechanisms;
  const mode = mechanisms.solvencyMode ?? (mechanisms.solvency !== undefined ? "soft" : undefined);
  const options = {
    width: BOT_DEFAULTS.width,
    ...(mechanisms.stock ? { stock: mechanisms.stock } : {}),
    ...(mode === "soft" && mechanisms.solvency ? { solvency: mechanisms.solvency } : {}),
    ...(mode === "hard" ? { rootVeto: true } : {}),
  };
  for (const c of corpus) {
    const shared = toSharedInput(projectAttax(c.observation));
    lines.push(
      JSON.stringify({
        id: `${label}:${c.id}`,
        profile: "s2",
        input: {
          board: Array.from(shared.board),
          frame: shared.frame ?? 0,
          garbageRows: shared.garbageRows ? Array.from(shared.garbageRows) : null,
          active: shared.active,
          hold: shared.hold,
          canHold: shared.canHold,
          preview: [...shared.preview],
          b2b: shared.b2b,
          b2bChain: shared.b2bChain,
          combo: shared.combo,
          pending: shared.pending,
          dueThisLock: shared.dueThisLock ?? 0,
          speculativePieces: [...(shared.speculativePieces ?? [])],
        },
        options,
        weights: decider.weights,
        expect: plain(decider.decide(c.observation)),
      }),
    );
  }
  console.error(`${label}: ${corpus.length} cases (profileId ${decider.profileId})`);
}
writeFileSync(out, `${lines.join("\n")}\n`);
console.error(`wrote ${lines.length} cases to ${out}`);
