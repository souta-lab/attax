/**
 * Tail instrument stage 2 tests (design §5.2/§5.3/§8 gates 3-4 scope):
 * C sidecar layout round-trip, JS sidecar parsing, the seq/blockBytes
 * reconciliation gate (including drop rejection), and the residual
 * gate. GPU-free: all fixtures are synthetic sidecars in the exact wire
 * layouts the C host and the JS writer emit.
 */
import { describe, expect, test } from "bun:test";
import {
  buildTailCHeader,
  buildTailCRecord,
  parseTailCBin,
  TAIL_MISS,
  type TailCRecord,
  type TailJsRecord,
} from "./tail-trace.js";
import { aggregate, parseJsSidecar } from "./tail-trace-aggregate.js";

function cRecord(seq: number, blockBytes: number, drop = 0): TailCRecord {
  return {
    seq: BigInt(seq),
    c0_abs_ns: 1_000_000n,
    submit_ns: 50_000n,
    span_wall_ns: 3_100_000n,
    s6a_ns: 100_000n,
    s6b_ns: 20_000n,
    s6c_ns: 10_000n,
    s7_ns: 30_000n,
    s8_ns: 200_000n,
    s9c_ns: 40_000n,
    gpu_ns: 2_800_000n,
    arena_next: 1565,
    leaf_count: 293,
    output_nodes: 1565,
    blockBytes,
    fwrite_count: 2,
    drop_cumulative: drop,
    flags: 0,
    status: 0,
    sclk_ref: 0,
  };
}

function jsRecord(seq: number, blockBytes: number): TailJsRecord {
  return {
    seq,
    e2e_ns: 3_700_000,
    encode_ns: 5_000,
    queue_and_pipe_ns: 3_600_000,
    header_wait_ns: 3_000_000,
    parse_full_ns: null,
    parse_light_ns: 30_000,
    result_ns: 10_000,
    chunks: 3,
    concat_bytes: blockBytes + 8,
    nodes_materialized: 47,
    nodes_skipped_plies: null,
    blockBytes,
    sclk_ref: 0,
  };
}

function sidecars(n: number, mutate?: (c: TailCRecord[], j: TailJsRecord[]) => void) {
  const cs = Array.from({ length: n }, (_, i) => cRecord(i, 676_583));
  const js = Array.from({ length: n }, (_, i) => jsRecord(i, 676_583));
  mutate?.(cs, js);
  const bin = new Uint8Array(128 * (n + 1));
  bin.set(
    buildTailCHeader({ sclk_mhz: 1497.751, timestamp_cost_ns: 21n, mode: "summary", version: 1 }),
    0,
  );
  cs.forEach((r, i) => bin.set(buildTailCRecord(r), 128 * (i + 1)));
  const header = {
    type: "header",
    kind: "tail-js",
    version: 1,
    mode: "summary",
    sclk_samples: [{ at_ms: 0, sclk_mhz: 1497.751 }],
    timestamp_cost_ns: 12,
  };
  const text = `${[header, ...js].map((x) => JSON.stringify(x)).join("\n")}\n`;
  return { bin, text };
}

describe("tail C sidecar layout", () => {
  test("header + records round-trip through the parser", () => {
    const { bin } = sidecars(3);
    const { header, records } = parseTailCBin(bin);
    expect(header.sclk_mhz).toBeCloseTo(1497.751, 3);
    expect(header.timestamp_cost_ns).toBe(21n);
    expect(header.mode).toBe("summary");
    expect(records.length).toBe(3);
    expect(records[1].seq).toBe(1n);
    expect(records[1].s6a_ns).toBe(100_000n);
    expect(records[1].blockBytes).toBe(676_583);
  });

  test("missing intervals keep the sentinel, never 0", () => {
    const rec = { ...cRecord(0, 100), s7_ns: TAIL_MISS };
    const bin = new Uint8Array(256);
    bin.set(
      buildTailCHeader({ sclk_mhz: 2320, timestamp_cost_ns: 20n, mode: "full", version: 1 }),
      0,
    );
    bin.set(buildTailCRecord(rec), 128);
    const { records } = parseTailCBin(bin);
    expect(records[0].s7_ns).toBe(TAIL_MISS);
  });

  test("a non-multiple-of-128 sidecar is rejected", () => {
    expect(() => parseTailCBin(new Uint8Array(100))).toThrow();
  });
});

describe("tail aggregation gates", () => {
  test("clean run passes reconciliation and residual, segments are labeled", () => {
    const { bin, text } = sidecars(5);
    const out = aggregate(bin, text);
    expect(out.gates.reconciliation.ok).toBe(true);
    expect(out.gates.residual.ok).toBe(true);
    expect(out.joined.length).toBe(5);
    // every segment row carries its definition label + 3-point set
    expect(out.segments.e2e.measured.median_ns).toBe(3_700_000);
    expect(out.segments.tail_s6.measured.median_ns).toBe(130_000);
    expect(out.segments.c_wall_prereadback.sclk_mhz).toBeCloseTo(1497.751, 3);
    expect(out.segments.c_wall_prereadback.clock_multiplier).toBeCloseTo(2320 / 1497.751, 6);
    // sclk is not 2320 here, so the clock gate must flag the window
    expect(out.gates.clock.ok).toBe(false);
  });

  test("blockBytes mismatch fails reconciliation (§8-4)", () => {
    const { bin, text } = sidecars(3, (_c, js) => {
      js[1] = { ...js[1], blockBytes: 999 };
    });
    const out = aggregate(bin, text);
    expect(out.gates.reconciliation.ok).toBe(false);
    expect(out.gates.reconciliation.failures.join(" ")).toContain("blockBytes");
  });

  test("a dropped C record rejects the run (§8-4)", () => {
    const { bin, text } = sidecars(3, (cs) => {
      cs[2] = { ...cs[2], drop_cumulative: 1 };
    });
    const out = aggregate(bin, text);
    expect(out.gates.reconciliation.ok).toBe(false);
    expect(out.gates.reconciliation.failures.join(" ")).toContain("drop");
  });

  test("a large unexplained residual fails gate 3 (§8-3)", () => {
    const { bin, text } = sidecars(3, (_c, js) => {
      js.forEach((r, i) => {
        js[i] = { ...r, e2e_ns: 10_000_000 };
      });
    });
    const out = aggregate(bin, text);
    expect(out.gates.residual.ok).toBe(false);
    expect(out.gates.residual.ratio).toBeGreaterThan(0.05);
  });

  test("JS sidecar without the header line is rejected", () => {
    expect(() => parseJsSidecar('{"seq":0}\n')).toThrow();
  });
});
