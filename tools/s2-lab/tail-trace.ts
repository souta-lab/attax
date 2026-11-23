/**
 * Tail instrument, stage 2 / C basic form — JS side (design:
 * TAIL-INSTRUMENT-DESIGN-2026-11-24 §3.2, §4, §5.1, §5.3, §10 stage 2).
 *
 * Enabled by ATTAX_TAIL_TRACE=<path> (same env the C host reads; the JS
 * sidecar is "<path>.js.jsonl", the C sidecar "<path>.c.bin"). Unset =
 * OFF: `tailTraceEnabled()` is false and callers skip every measurement
 * (design §6: OFF cost is a flag check only).
 *
 * J points (design §3.2), taken in gpu-player.ts:
 *   J0 decideAsync entry, J1 encode done, J2 request written / queued,
 *   J3 serve header seen, J4 block fully received + concat done,
 *   J5 parse done, J6 resultForRootStep done = decideAsync return.
 * J0/J6 are taken at GpuDecider.decideAsync — the lab-decision wrapper
 * above it only projects the public decision, and that projection is
 * outside this E2E definition (it lands in RES, §3.3, and is named as
 * such in the stage-2 record; secretary question #7082).
 *
 * Raw records carry measured values only; clock conversion lives in the
 * aggregation layer (tail-trace-aggregate.ts), per design §5.4.
 */
import { appendFileSync, closeSync, openSync } from "node:fs";

import { sampleSclkMHz, timestampCostNs } from "./tail-parse-harness.js";

export const TAIL_TRACE_ENV = "ATTAX_TAIL_TRACE";
export const TAIL_MODE_ENV = "ATTAX_TAIL_MODE";
/** C record missing-interval sentinel (design §3.1: missing != 0). */
export const TAIL_MISS = 0xffffffffffffffffn;
export const TAIL_RECORD_BYTES = 128;

export function tailTraceEnabled(): boolean {
  const p = process.env[TAIL_TRACE_ENV];
  return typeof p === "string" && p.length > 0;
}

export function tailTracePath(): string | null {
  return tailTraceEnabled() ? (process.env[TAIL_TRACE_ENV] as string) : null;
}

export function tailMode(): "summary" | "full" {
  return process.env[TAIL_MODE_ENV] === "full" ? "full" : "summary";
}

// --- JS sidecar records (design §5.3) -------------------------------------

export interface TailJsHeader {
  readonly type: "header";
  readonly kind: "tail-js";
  readonly version: 1;
  readonly mode: "summary" | "full";
  /** sclk samples: run start, then at least every 30 s (§5.4). */
  readonly sclk_samples: { at_ms: number; sclk_mhz: number | null }[];
  readonly timestamp_cost_ns: number;
}

export interface TailJsRecord {
  readonly seq: number;
  readonly e2e_ns: number;
  readonly encode_ns: number;
  /** J4 - J2: queue + C-side processing + pipe return (§3.3 S9J). */
  readonly queue_and_pipe_ns: number;
  /** J3 - J2: time until the serve header was first seen. */
  readonly header_wait_ns: number | null;
  readonly parse_full_ns: number | null;
  readonly parse_light_ns: number | null;
  readonly result_ns: number;
  readonly chunks: number;
  readonly concat_bytes: number;
  readonly nodes_materialized: number | null;
  readonly nodes_skipped_plies: number | null;
  readonly blockBytes: number;
  readonly sclk_ref: number;
}

/**
 * Append-only JS sidecar writer. One line per decision, written at the
 * decision boundary (never mid-decision), on its own fd — the serve
 * pipe itself carries no trace bytes (design P1/P3, §5.1).
 */
export class TailTraceWriter {
  private fd: number;
  private sclkSamples: TailJsHeader["sclk_samples"] = [];
  private startedAt = performance.now();
  private lastSampleAt = 0;

  constructor(path: string) {
    this.fd = openSync(`${path}.js.jsonl`, "a");
    this.sampleSclk(true);
    const header: TailJsHeader = {
      type: "header",
      kind: "tail-js",
      version: 1,
      mode: tailMode(),
      sclk_samples: this.sclkSamples,
      timestamp_cost_ns: timestampCostNs(),
    };
    appendFileSync(this.fd, `${JSON.stringify(header)}\n`);
  }

  /** §5.4: the measuring process itself samples sclk (>= every 30 s). */
  private sampleSclk(force = false): number {
    const now = performance.now();
    if (force || now - this.lastSampleAt >= 30_000) {
      this.sclkSamples.push({ at_ms: now - this.startedAt, sclk_mhz: sampleSclkMHz() });
      this.lastSampleAt = now;
    }
    return this.sclkSamples.length - 1;
  }

  /** sclk_ref for the next record (index into the header sample table). */
  sclkRef(): number {
    return this.sampleSclk();
  }

  write(record: TailJsRecord): void {
    appendFileSync(this.fd, `${JSON.stringify(record)}\n`);
  }

  close(): void {
    closeSync(this.fd);
  }
}

let sharedWriter: TailTraceWriter | null = null;

/** The process-wide JS writer, or null when the instrument is OFF. */
export function getTailWriter(): TailTraceWriter | null {
  if (!tailTraceEnabled()) return null;
  if (!sharedWriter) sharedWriter = new TailTraceWriter(tailTracePath() as string);
  return sharedWriter;
}

export function closeTailWriter(): void {
  sharedWriter?.close();
  sharedWriter = null;
}

// --- C sidecar records (design §5.2) --------------------------------------

export interface TailCHeader {
  readonly sclk_mhz: number;
  readonly timestamp_cost_ns: bigint;
  readonly mode: "summary" | "full";
  readonly version: number;
}

export interface TailCRecord {
  readonly seq: bigint;
  readonly c0_abs_ns: bigint;
  /** C1 - C0: submit span. */
  readonly submit_ns: bigint;
  /** C2 - C0: the existing prereadback wall span (the 3.10 ms lineage). */
  readonly span_wall_ns: bigint;
  readonly s6a_ns: bigint;
  readonly s6b_ns: bigint;
  readonly s6c_ns: bigint;
  readonly s7_ns: bigint;
  readonly s8_ns: bigint;
  readonly s9c_ns: bigint;
  readonly gpu_ns: bigint;
  readonly arena_next: number;
  readonly leaf_count: number;
  readonly output_nodes: number;
  readonly blockBytes: number;
  readonly fwrite_count: number;
  readonly drop_cumulative: number;
  readonly flags: number;
  readonly status: number;
  readonly sclk_ref: number;
}

/** Missing-segment flag bits (must match vkrunner_s26.c). */
export const TAIL_FLAG_MISSING = {
  s6a: 1 << 0,
  s6b: 1 << 1,
  s6c: 1 << 2,
  s7: 1 << 3,
  s8: 1 << 4,
  s9c: 1 << 5,
} as const;

export function parseTailCBin(bytes: Uint8Array): {
  header: TailCHeader;
  records: TailCRecord[];
} {
  if (bytes.byteLength === 0 || bytes.byteLength % TAIL_RECORD_BYTES !== 0) {
    throw new Error(`tail C sidecar: size ${bytes.byteLength} is not a multiple of 128`);
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = new TextDecoder().decode(bytes.subarray(0, 8));
  if (magic !== "TAILHDR1") throw new Error("tail C sidecar: missing TAILHDR1 header record");
  if (v.getBigUint64(8, true) !== TAIL_MISS) {
    throw new Error("tail C sidecar: header seq is not the sentinel");
  }
  const header: TailCHeader = {
    sclk_mhz: v.getFloat64(80, true),
    timestamp_cost_ns: v.getBigUint64(88, true),
    mode: v.getUint32(96, true) === 1 ? "full" : "summary",
    version: v.getUint32(100, true),
  };
  const records: TailCRecord[] = [];
  for (let off = TAIL_RECORD_BYTES; off < bytes.byteLength; off += TAIL_RECORD_BYTES) {
    const flags = v.getUint32(off + 112, true);
    records.push({
      seq: v.getBigUint64(off, true),
      c0_abs_ns: v.getBigUint64(off + 8, true),
      submit_ns: v.getBigUint64(off + 16, true),
      span_wall_ns: v.getBigUint64(off + 24, true),
      s6a_ns: v.getBigUint64(off + 32, true),
      s6b_ns: v.getBigUint64(off + 40, true),
      s6c_ns: v.getBigUint64(off + 48, true),
      s7_ns: v.getBigUint64(off + 56, true),
      s8_ns: v.getBigUint64(off + 64, true),
      s9c_ns: v.getBigUint64(off + 72, true),
      gpu_ns: v.getBigUint64(off + 80, true),
      arena_next: v.getUint32(off + 88, true),
      leaf_count: v.getUint32(off + 92, true),
      output_nodes: v.getUint32(off + 96, true),
      blockBytes: v.getUint32(off + 100, true),
      fwrite_count: v.getUint32(off + 104, true),
      drop_cumulative: v.getUint32(off + 108, true),
      flags,
      status: (flags >> 8) & 0xff,
      sclk_ref: v.getUint32(off + 116, true),
    });
  }
  return { header, records };
}

/** Build one C record in the wire layout (test fixtures / tooling). */
export function buildTailCRecord(r: TailCRecord): Uint8Array {
  const out = new Uint8Array(TAIL_RECORD_BYTES);
  const v = new DataView(out.buffer);
  v.setBigUint64(0, r.seq, true);
  v.setBigUint64(8, r.c0_abs_ns, true);
  v.setBigUint64(16, r.submit_ns, true);
  v.setBigUint64(24, r.span_wall_ns, true);
  v.setBigUint64(32, r.s6a_ns, true);
  v.setBigUint64(40, r.s6b_ns, true);
  v.setBigUint64(48, r.s6c_ns, true);
  v.setBigUint64(56, r.s7_ns, true);
  v.setBigUint64(64, r.s8_ns, true);
  v.setBigUint64(72, r.s9c_ns, true);
  v.setBigUint64(80, r.gpu_ns, true);
  v.setUint32(88, r.arena_next, true);
  v.setUint32(92, r.leaf_count, true);
  v.setUint32(96, r.output_nodes, true);
  v.setUint32(100, r.blockBytes, true);
  v.setUint32(104, r.fwrite_count, true);
  v.setUint32(108, r.drop_cumulative, true);
  v.setUint32(112, r.flags, true);
  v.setUint32(116, r.sclk_ref, true);
  return out;
}

export function buildTailCHeader(h: TailCHeader): Uint8Array {
  const out = new Uint8Array(TAIL_RECORD_BYTES);
  out.set(new TextEncoder().encode("TAILHDR1"), 0);
  const v = new DataView(out.buffer);
  v.setBigUint64(8, TAIL_MISS, true);
  v.setFloat64(80, h.sclk_mhz, true);
  v.setBigUint64(88, h.timestamp_cost_ns, true);
  v.setUint32(96, h.mode === "full" ? 1 : 0, true);
  v.setUint32(100, h.version, true);
  return out;
}
