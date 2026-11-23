/**
 * Tail instrument, stage 1 (design: TAIL-INSTRUMENT-DESIGN-2026-11-24 §9.2-1
 * / §10 stage 1): an offline, GPU-free parse harness that measures S10 —
 * the JS-side serve-block parse — for BOTH parse shapes (S10f full /
 * S10l light) with one instrument, over serve blocks in the exact wire
 * format of gpu-codec.ts.
 *
 * Blocks come from two sources, treated identically downstream:
 *  - recorded blocks: raw serve-block bytes loaded from disk
 *    (`loadRecordedBlocks`), e.g. a future capture of real serve output;
 *  - synthetic blocks: `buildSyntheticServeBlock` assembles blocks in the
 *    same wire format with a caller-chosen ply/node profile, so the
 *    corpus-mean profile (≈1,565 nodes/decision, LATENCY-FLOOR-AUDIT §2)
 *    can be measured before any recorded corpus exists.
 *
 * gpu-codec.ts is NOT modified (design §10 stage 1): measurement wraps
 * the parse functions at the call site, exactly where §3.2 puts the J5
 * point. Record field names follow design §5.3 (`parse_full_ns`,
 * `parse_light_ns`, `nodes_materialized`, `nodes_skipped_plies`,
 * `blockBytes`, `sclk_ref`); raw records carry measured values only —
 * clock conversion happens in the aggregation layer (§5.4).
 */

import { readFileSync } from "node:fs";

import {
  type ParsedBlock,
  parseServeBlock,
  parseServeBlockLight,
  resultForRootStep,
  WIRE_BYTES,
} from "./gpu-codec.js";
import { DEFAULT_WEIGHTS } from "./weights.js";

// --- deterministic PRNG (corpus generation must be reproducible) ---------

export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

// --- synthetic serve blocks ----------------------------------------------

export interface PlyProfile {
  readonly beam: number;
  readonly finished: number;
}

export interface BlockProfile {
  readonly plies: readonly PlyProfile[];
}

/** Total wire nodes a full parse materializes for this profile. */
export function profileNodeCount(profile: BlockProfile): number {
  return profile.plies.reduce((a, p) => a + p.beam + p.finished, 0);
}

/**
 * The audit's corpus-mean profile: 15 plies, beam ≈1,273 + finished ≈293
 * ≈ 1,565 nodes/decision (LATENCY-FLOOR-AUDIT-2026-11-24 §2), with a
 * deterministic per-block jitter so blocks are not byte-identical.
 */
export function corpusMeanProfile(seed: number): BlockProfile {
  const rnd = lcg(seed * 7919 + 13);
  const plies: PlyProfile[] = [];
  for (let p = 0; p < 15; p++) {
    const beamBase = p === 14 ? 83 : 85;
    const finBase = p === 14 ? 13 : 20;
    const beam = Math.max(1, Math.round(beamBase * (0.9 + rnd() * 0.2)));
    const finished = Math.max(0, Math.round(finBase * (0.8 + rnd() * 0.4)));
    plies.push({ beam, finished });
  }
  return { plies };
}

const KIND_COUNT = 7;

function writeWireNode(
  out: Uint8Array,
  off: number,
  rnd: () => number,
  opts: {
    depth: number;
    step?: {
      kind: number;
      rotation: number;
      x: number;
      y: number;
      usedHold: number;
      lines: number;
      attack: number;
      reward: number;
    };
  },
): void {
  const v = new DataView(out.buffer, out.byteOffset + off, WIRE_BYTES);
  // Board / garbage words: arbitrary but stable filler — the parse reads
  // every word, so filler density is what makes the measurement honest.
  for (let i = 0; i < 40; i++) v.setUint32(i * 4, Math.floor(rnd() * 0x10000), true);
  for (let i = 0; i < 40; i++) v.setUint32((40 + i) * 4, Math.floor(rnd() * 4), true);
  v.setInt32(80 * 4, -1, true); // hold: none (a valid index would also parse)
  v.setUint32(81 * 4, Math.floor(rnd() * KIND_COUNT), true); // next
  v.setInt32(85 * 4, 0, true); // lift
  v.setBigUint64(87 * 4, BigInt(Math.floor(rnd() * 1e9)), true); // reward bits
  v.setBigUint64(89 * 4, BigInt(Math.floor(rnd() * 1e9)), true); // value bits
  v.setUint32(93 * 4, opts.depth, true);
  // Every node carries a step: in real serve blocks the beam/finished
  // nodes are lock outcomes, so the parse reconstructs a step object
  // per node. Omitting it would flatter the full parse.
  const step = opts.step ?? {
    kind: Math.floor(rnd() * KIND_COUNT),
    rotation: Math.floor(rnd() * 4),
    x: Math.floor(rnd() * 10),
    y: 10 + Math.floor(rnd() * 10),
    usedHold: Math.floor(rnd() * 2),
    lines: Math.floor(rnd() * 5),
    attack: Math.floor(rnd() * 5),
    reward: rnd() * 50,
  };
  v.setUint32(94 * 4, 1, true);
  {
    const s = step;
    v.setInt32(95 * 4, s.kind, true);
    v.setInt32(96 * 4, s.rotation, true);
    v.setInt32(97 * 4, s.x, true);
    v.setInt32(98 * 4, s.y, true);
    v.setInt32(99 * 4, 0, true); // lastSrs
    v.setInt32(100 * 4, 0, true); // tspin none
    v.setUint32(101 * 4, s.usedHold, true);
    v.setUint32(102 * 4, s.lines, true);
    v.setInt32(103 * 4, s.attack, true);
    v.setFloat64(104 * 4, s.reward, true);
  }
  v.setUint32(106 * 4, 40, true); // board_len
}

/**
 * Assemble one serve block in the exact wire format parseServeBlock
 * consumes. Ply 0's beam[0] is the best head's depth-1 node and ply 0's
 * finished[0] is candidate 2's depth-1 node, so both selection paths
 * (best, and the acceptRoot substitution via candidates) are exercisable
 * — the same arrangement as gpu-codec.test.ts's multi-ply fixture.
 * Requires profile.plies[0].beam >= 1 and .finished >= 1.
 */
export function buildSyntheticServeBlock(profile: BlockProfile, seed: number): Uint8Array {
  if (profile.plies.length === 0) throw new Error("tail harness: profile has no plies");
  if (profile.plies[0].beam < 1 || profile.plies[0].finished < 1) {
    throw new Error(
      "tail harness: ply 0 needs beam >= 1 and finished >= 1 for the selection nodes",
    );
  }
  const rnd = lcg(seed * 104729 + 7);
  const nCand = 2;
  const headBytes = 4 + 36 + 8 + 4 + 4 + nCand * 36 + 4;
  const pliesBytes = profile.plies.reduce(
    (a, p) => a + 4 + p.beam * WIRE_BYTES + 4 + p.finished * WIRE_BYTES,
    0,
  );
  const total = headBytes + pliesBytes + 32;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  let off = 0;
  const u32 = (x: number) => {
    v.setUint32(off, x, true);
    off += 4;
  };
  const f64 = (x: number) => {
    v.setFloat64(off, x, true);
    off += 8;
  };
  const head = (kind: number, rot: number, x: number, y: number, hold: number, value: number) => {
    u32(kind);
    u32(rot);
    u32(x);
    u32(y);
    u32(0);
    u32(0);
    u32(hold);
    f64(value);
  };
  u32(0); // status 0
  head(2, 1, 4, 18, 0, 12.5); // best: T rot1 x4 y18
  v.setBigUint64(off, 12345n, true);
  off += 8; // nodes (head field, not the materialized count)
  u32(3); // depth
  u32(nCand);
  head(2, 1, 4, 18, 0, 12.5);
  head(0, 0, 0, 19, 1, 3.25); // candidate 2: I rot0 x0 y19, hold
  u32(profile.plies.length);
  profile.plies.forEach((ply, p) => {
    u32(ply.beam);
    for (let i = 0; i < ply.beam; i++) {
      const isBestNode = p === 0 && i === 0;
      writeWireNode(out, off, rnd, {
        depth: p + 1,
        step: isBestNode
          ? { kind: 2, rotation: 1, x: 4, y: 18, usedHold: 0, lines: 2, attack: 3, reward: 40.5 }
          : undefined,
      });
      off += WIRE_BYTES;
    }
    u32(ply.finished);
    for (let i = 0; i < ply.finished; i++) {
      const isCandNode = p === 0 && i === 0;
      writeWireNode(out, off, rnd, {
        depth: p + 1,
        step: isCandNode
          ? { kind: 0, rotation: 0, x: 0, y: 19, usedHold: 1, lines: 0, attack: 0, reward: 1.5 }
          : undefined,
      });
      off += WIRE_BYTES;
    }
  });
  f64(4.25); // trailer wallMs
  f64(3.5); // trailer gpuMs
  f64(0);
  f64(0.75);
  if (off !== total) throw new Error(`tail harness: builder off by ${total - off} bytes`);
  return out;
}

/** Load recorded serve blocks: one file = one block, raw bytes as served. */
export function loadRecordedBlocks(paths: readonly string[]): Uint8Array[] {
  return paths.map((p) => new Uint8Array(readFileSync(p)));
}

// --- measurement -----------------------------------------------------------

export interface TailParseRecord {
  readonly seq: number;
  readonly block_index: number;
  readonly parse_full_ns: number;
  readonly parse_light_ns: number;
  /** Nodes materialized by the full parse (all plies). */
  readonly nodes_materialized: number;
  /** Nodes materialized by the light parse (ply 0 only). */
  readonly nodes_materialized_light: number;
  /** Plies the light parse skipped by count (nPlies - 1). */
  readonly nodes_skipped_plies: number;
  /** Nodes inside those skipped plies. */
  readonly nodes_skipped: number;
  readonly blockBytes: number;
  readonly sclk_ref: number;
}

export function countMaterialized(parsed: ParsedBlock): number {
  return parsed.plies.reduce((a, p) => a + p.beam.length + p.finished.length, 0);
}

/**
 * Measure S10f/S10l over a corpus. Order alternates per (rep, block) so
 * drift hits both shapes symmetrically (ABAB at the block level).
 * Warmup repetitions run first and are not recorded.
 */
export function measureCorpus(
  blocks: readonly Uint8Array[],
  opts: { reps: number; warmup: number; sclkRef: number },
): TailParseRecord[] {
  const run = (block: Uint8Array, fullFirst: boolean) => {
    let fullNs = 0;
    let lightNs = 0;
    let fullCount = 0;
    let lightCount = 0;
    let nPlies = 0;
    const timeFull = () => {
      const t0 = performance.now();
      const parsed = parseServeBlock(block);
      fullNs = (performance.now() - t0) * 1e6;
      fullCount = countMaterialized(parsed);
      nPlies = parsed.plies.length;
    };
    const timeLight = () => {
      const t0 = performance.now();
      const parsed = parseServeBlockLight(block);
      lightNs = (performance.now() - t0) * 1e6;
      lightCount = countMaterialized(parsed);
    };
    if (fullFirst) {
      timeFull();
      timeLight();
    } else {
      timeLight();
      timeFull();
    }
    return { fullNs, lightNs, fullCount, lightCount, nPlies };
  };
  for (let w = 0; w < opts.warmup; w++) {
    for (const block of blocks) run(block, w % 2 === 0);
  }
  const records: TailParseRecord[] = [];
  let seq = 0;
  for (let rep = 0; rep < opts.reps; rep++) {
    blocks.forEach((block, blockIndex) => {
      const r = run(block, (rep + blockIndex) % 2 === 0);
      records.push({
        seq: seq++,
        block_index: blockIndex,
        parse_full_ns: r.fullNs,
        parse_light_ns: r.lightNs,
        nodes_materialized: r.fullCount,
        nodes_materialized_light: r.lightCount,
        nodes_skipped_plies: r.nPlies - 1,
        nodes_skipped: r.fullCount - r.lightCount,
        blockBytes: block.byteLength,
        sclk_ref: opts.sclkRef,
      });
    });
  }
  return records;
}

// --- stage-1 gates ---------------------------------------------------------

function stableStringify(x: unknown): string {
  return JSON.stringify(x, (_k, val) => (typeof val === "bigint" ? `bigint:${val}` : val));
}

/**
 * Gate (design §8-1, stage-1 scope): selection consistency. For every
 * block, the SearchResult built from the light parse must equal the one
 * built from the full parse — for the best head AND for every candidate
 * whose depth-1 node lives in ply 0 (the acceptRoot substitution path).
 * Head fields and candidates must also agree exactly.
 */
export function checkSelectionConsistency(blocks: readonly Uint8Array[]): {
  ok: boolean;
  blocksChecked: number;
  resultsCompared: number;
  failures: string[];
} {
  const failures: string[] = [];
  let resultsCompared = 0;
  blocks.forEach((block, bi) => {
    const full = parseServeBlock(block);
    const light = parseServeBlockLight(block);
    const headFields = (p: ParsedBlock) =>
      stableStringify({
        status: p.status,
        best: p.best,
        valueBits: p.valueBits,
        nodes: p.nodes,
        depth: p.depth,
        candidates: p.candidates,
        wallMs: p.wallMs,
        gpuMs: p.gpuMs,
      });
    if (headFields(full) !== headFields(light))
      failures.push(`block ${bi}: head/candidates differ`);
    if (!full.best || !light.best) {
      if (full.best !== light.best) failures.push(`block ${bi}: best null-ness differs`);
      return;
    }
    const targets = [
      {
        placement: full.best.placement,
        usedHold: full.best.usedHold,
        valueBits: full.best.valueBits,
      },
      ...full.candidates.map((c) => ({
        placement: c.placement,
        usedHold: c.usedHold,
        valueBits: c.valueBits,
      })),
    ];
    for (const t of targets) {
      let fullResult: unknown;
      let lightResult: unknown;
      let fullErr: string | null = null;
      let lightErr: string | null = null;
      try {
        fullResult = resultForRootStep(full, t.placement, t.usedHold, t.valueBits, DEFAULT_WEIGHTS);
      } catch (e) {
        fullErr = String(e);
      }
      try {
        lightResult = resultForRootStep(
          light,
          t.placement,
          t.usedHold,
          t.valueBits,
          DEFAULT_WEIGHTS,
        );
      } catch (e) {
        lightErr = String(e);
      }
      if (fullErr !== lightErr) {
        failures.push(`block ${bi}: error mismatch full=${fullErr} light=${lightErr}`);
      } else if (fullErr === null) {
        resultsCompared++;
        if (stableStringify(fullResult) !== stableStringify(lightResult)) {
          failures.push(`block ${bi}: SearchResult differs for a root step`);
        }
      }
    }
  });
  return { ok: failures.length === 0, blocksChecked: blocks.length, resultsCompared, failures };
}

/**
 * Gate (design §8-4, stage-1 scope): reconciliation completeness. The
 * record set must cover every (rep, block) pair exactly once, seq must
 * be a contiguous 0-based run, blockBytes must match the corpus blocks,
 * and the materialized-node totals must reconcile with an independent
 * full parse of the corpus (no dropped or double-counted records).
 */
export function checkReconciliation(
  records: readonly TailParseRecord[],
  blocks: readonly Uint8Array[],
  reps: number,
): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  if (records.length !== blocks.length * reps) {
    failures.push(`record count ${records.length} != blocks*reps ${blocks.length * reps}`);
  }
  records.forEach((r, i) => {
    if (r.seq !== i) failures.push(`seq gap at position ${i}: seq=${r.seq}`);
    const block = blocks[r.block_index];
    if (!block) {
      failures.push(`record ${r.seq}: block_index ${r.block_index} out of range`);
      return;
    }
    if (r.blockBytes !== block.byteLength) {
      failures.push(`record ${r.seq}: blockBytes ${r.blockBytes} != ${block.byteLength}`);
    }
    if (r.nodes_materialized_light + r.nodes_skipped !== r.nodes_materialized) {
      failures.push(`record ${r.seq}: light + skipped != full materialized`);
    }
  });
  const expectedPerRep = blocks.reduce((a, b) => a + countMaterialized(parseServeBlock(b)), 0);
  const actualTotal = records.reduce((a, r) => a + r.nodes_materialized, 0);
  if (actualTotal !== expectedPerRep * reps) {
    failures.push(
      `materialized total ${actualTotal} != independent parse total ${expectedPerRep * reps}`,
    );
  }
  return { ok: failures.length === 0, failures };
}

// --- clock honesty (design §5.4) ------------------------------------------

/** Sample the current CPU clock (MHz) from /proc/cpuinfo; null if absent. */
export function sampleSclkMHz(): number | null {
  try {
    const text = readFileSync("/proc/cpuinfo", "utf8");
    const m = text.match(/cpu MHz\s*:\s*([0-9.]+)/);
    return m ? Number.parseFloat(m[1]) : null;
  } catch {
    return null;
  }
}

/** Cost of one performance.now() call, measured over `iterations` calls. */
export function timestampCostNs(iterations = 200_000): number {
  const t0 = performance.now();
  for (let i = 0; i < iterations; i++) performance.now();
  return ((performance.now() - t0) * 1e6) / iterations;
}

export interface SegmentStats {
  readonly n: number;
  readonly median_ns: number;
  readonly mean_ns: number;
  readonly p95_ns: number;
}

export function segmentStats(values: readonly number[]): SegmentStats {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: sorted.length,
    median_ns: at(0.5),
    mean_ns: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p95_ns: at(0.95),
  };
}

/**
 * The 3-point reporting set (design §5.4): measured value, the sclk it
 * was measured at, the 2320/sclk multiplier, and the converted value —
 * the converted value is an [見積] and is produced ONLY here, in the
 * aggregation layer, never in raw records.
 */
export function threePointSet(stats: SegmentStats, sclkMHz: number | null) {
  const multiplier = sclkMHz ? 2320 / sclkMHz : null;
  const conv = (ns: number) => (multiplier === null ? null : ns * multiplier);
  return {
    measured: {
      median_ns: stats.median_ns,
      mean_ns: stats.mean_ns,
      p95_ns: stats.p95_ns,
      n: stats.n,
    },
    sclk_mhz: sclkMHz,
    clock_multiplier: multiplier,
    converted_estimate_ns: {
      median_ns: conv(stats.median_ns),
      mean_ns: conv(stats.mean_ns),
      p95_ns: conv(stats.p95_ns),
    },
  };
}
