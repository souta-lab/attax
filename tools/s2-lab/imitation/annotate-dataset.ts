/**
 * Offline & iterative-beam-regeneration annotator for DecisionRecord JSONL.
 *
 * Attaches `annotations.existing` and/or `annotations.corrected` (with `phi34`,
 * `pruningDepth`, `survivedBeam`, `fatalAtRoot`, `fatalOnBestPath`) using either
 * `tools/s2-lab/profiles/s2-seed.json` or fitted weights JSON exported by `fit.py`.
 *
 * Supports sharded parallel execution (--shard-index / --shard-count) so two
 * processes can annotate disjoint records cleanly within VM spare capacity.
 */

import { createReadStream, createWriteStream, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import readline from "node:readline";
import type { Weights } from "../../../src/ai/bot/weights.js";
import { DEFAULT_WEIGHTS } from "../../../src/ai/bot/weights.js";
import { vector24ToWeights } from "./s2-variants.js";
import type { DecisionRecord, VariantAnnotation } from "./schema.js";
import { annotateRecordVariant } from "./teacher-oracle.js";

export type AnnotatableVariant = "existing" | "corrected";

export interface LoadedWeightSpec {
  readonly weightsId: string;
  readonly weights: Weights;
  readonly augmentedWeights?: readonly number[];
}

export function loadWeightSpec(weightsPath?: string): LoadedWeightSpec {
  if (!weightsPath) {
    const seedPath = resolve(import.meta.dir, "../profiles/s2-seed.json");
    const raw = JSON.parse(readFileSync(seedPath, "utf8")) as {
      name?: string;
      weights?: Weights;
    };
    return {
      weightsId: raw.name ?? "s2-seed",
      weights: raw.weights ?? DEFAULT_WEIGHTS,
    };
  }
  const resolved = resolve(weightsPath);
  const raw = JSON.parse(readFileSync(resolved, "utf8")) as {
    weightsId?: unknown;
    name?: unknown;
    profileId?: unknown;
    weights?: unknown;
    augmentedWeights?: unknown;
    theta24?: unknown;
    theta10?: unknown;
    theta34?: unknown;
    discount?: unknown;
  };
  if (raw.weights && typeof raw.weights === "object" && !Array.isArray(raw.weights)) {
    return {
      weightsId: String(raw.weightsId ?? raw.name ?? raw.profileId ?? resolved),
      weights: raw.weights as Weights,
      ...(Array.isArray(raw.augmentedWeights)
        ? { augmentedWeights: raw.augmentedWeights.map(Number) }
        : {}),
    };
  }
  if (Array.isArray(raw.theta24)) {
    const discount = typeof raw.discount === "number" ? raw.discount : DEFAULT_WEIGHTS.discount;
    return {
      weightsId: String(raw.weightsId ?? raw.name ?? resolved),
      weights: vector24ToWeights(raw.theta24.map(Number), discount),
      ...(Array.isArray(raw.theta10) ? { augmentedWeights: raw.theta10.map(Number) } : {}),
    };
  }
  if (Array.isArray(raw.theta34) && raw.theta34.length === 34) {
    const discount = typeof raw.discount === "number" ? raw.discount : DEFAULT_WEIGHTS.discount;
    const vals = raw.theta34.map(Number);
    return {
      weightsId: String(raw.weightsId ?? raw.name ?? resolved),
      weights: vector24ToWeights(vals.slice(0, 24), discount),
      augmentedWeights: vals.slice(24, 34),
    };
  }
  throw new Error(`Unsupported weight JSON format at ${resolved}`);
}

export function annotateDecisionRecord(
  record: DecisionRecord,
  options: {
    readonly variants: readonly AnnotatableVariant[];
    readonly weightSpec: LoadedWeightSpec;
    readonly width: number;
    readonly skipExisting?: boolean;
  },
): DecisionRecord {
  let existingAnnotation: VariantAnnotation | undefined = record.annotations.existing;
  let correctedAnnotation: VariantAnnotation | undefined = record.annotations.corrected;

  if (options.variants.includes("existing")) {
    const alreadyDone =
      options.skipExisting &&
      existingAnnotation !== undefined &&
      existingAnnotation.weightsId === options.weightSpec.weightsId &&
      existingAnnotation.width === options.width;
    if (!alreadyDone) {
      existingAnnotation = annotateRecordVariant({
        observation: record.observation,
        legalActions: record.legalActions,
        teacher: record.teacher,
        variant: "existing",
        weights: options.weightSpec.weights,
        weightsId: options.weightSpec.weightsId,
        width: options.width,
      });
    }
  }

  if (options.variants.includes("corrected")) {
    const alreadyDone =
      options.skipExisting &&
      correctedAnnotation !== undefined &&
      correctedAnnotation.weightsId === options.weightSpec.weightsId &&
      correctedAnnotation.width === options.width;
    if (!alreadyDone) {
      // Note: corrected's candidate search uses base 24 weights unless augmentedWeights supplied;
      // phi34 still logs all 34 features either way for joint fitting.
      correctedAnnotation = annotateRecordVariant({
        observation: record.observation,
        legalActions: record.legalActions,
        teacher: record.teacher,
        variant: "corrected",
        weights: options.weightSpec.weights,
        weightsId: options.weightSpec.weightsId,
        width: options.width,
        augmentedWeights: options.weightSpec.augmentedWeights,
      });
    }
  }

  return {
    ...record,
    annotations: {
      ...(existingAnnotation ? { existing: existingAnnotation } : {}),
      ...(correctedAnnotation ? { corrected: correctedAnnotation } : {}),
    },
  };
}

function parseArgs(argv: readonly string[]): {
  input: string;
  output: string;
  variants: AnnotatableVariant[];
  weightsPath?: string;
  width: number;
  shardIndex: number;
  shardCount: number;
  skipExisting: boolean;
} {
  let input = "";
  let output = "";
  let variants: AnnotatableVariant[] = ["existing", "corrected"];
  let weightsPath: string | undefined;
  let width = 96;
  let shardIndex = 0;
  let shardCount = 1;
  let skipExisting = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    const next = argv[i + 1];
    if (arg === "--input" && next) {
      input = next;
      i += 1;
    } else if (arg === "--output" && next) {
      output = next;
      i += 1;
    } else if (arg === "--variants" && next) {
      const parsed = next
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is AnnotatableVariant => s === "existing" || s === "corrected");
      if (parsed.length === 0) throw new Error(`Invalid --variants: ${next}`);
      variants = parsed;
      i += 1;
    } else if (arg === "--weights" && next) {
      weightsPath = next;
      i += 1;
    } else if (arg === "--width" && next) {
      width = Number(next);
      i += 1;
    } else if (arg === "--shard-index" && next) {
      shardIndex = Number(next);
      i += 1;
    } else if (arg === "--shard-count" && next) {
      shardCount = Number(next);
      i += 1;
    } else if (arg === "--skip-existing") {
      skipExisting = true;
    }
  }
  if (!input || !output) {
    throw new Error(
      "Usage: bun tools/s2-lab/imitation/annotate-dataset.ts --input <in.jsonl> --output <out.jsonl> [--variants existing,corrected] [--weights <path>] [--width 96] [--shard-index 0 --shard-count 1]",
    );
  }
  return { input, output, variants, weightsPath, width, shardIndex, shardCount, skipExisting };
}

async function runCli(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const weightSpec = loadWeightSpec(args.weightsPath);
  mkdirSync(dirname(resolve(args.output)), { recursive: true });
  const out = createWriteStream(resolve(args.output), { encoding: "utf8" });

  const rl = readline.createInterface({
    input: createReadStream(resolve(args.input), { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let lineIdx = 0;
  let processed = 0;
  const startedAt = performance.now();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const currentIdx = lineIdx;
    lineIdx += 1;
    if (currentIdx % args.shardCount !== args.shardIndex) continue;

    const record = JSON.parse(trimmed) as DecisionRecord;
    const annotated = annotateDecisionRecord(record, {
      variants: args.variants,
      weightSpec,
      width: args.width,
      skipExisting: args.skipExisting,
    });
    out.write(`${JSON.stringify(annotated)}\n`);
    processed += 1;
    if (processed % 100 === 0) {
      const elapsedSec = (performance.now() - startedAt) / 1000;
      console.error(
        `[annotate shard ${args.shardIndex}/${args.shardCount}] ${processed} records in ${elapsedSec.toFixed(1)}s (${(processed / elapsedSec).toFixed(2)} rec/s)`,
      );
    }
  }

  await new Promise<void>((res, rej) => {
    out.end(() => res());
    out.on("error", rej);
  });
  const totalSec = (performance.now() - startedAt) / 1000;
  console.error(
    `[annotate shard ${args.shardIndex}/${args.shardCount}] DONE: ${processed} records in ${totalSec.toFixed(1)}s`,
  );
}

if (import.meta.main) {
  runCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
