/**
 * Tail instrument, stage 2 aggregation layer (design:
 * TAIL-INSTRUMENT-DESIGN-2026-11-24 §3.3, §5.4, §8, §10 stage 2).
 *
 * Joins one run's C sidecar (.c.bin) and JS sidecar (.js.jsonl) on seq,
 * enforces the stage-2-scope acceptance gates, and prints per-segment
 * 3-point sets (measured / sclk / multiplier / converted [見積]) with a
 * definition label on every row — unlabeled numbers cannot be produced
 * here (§5.4). Raw sidecars are never modified and never contain
 * converted values.
 *
 * Gates evaluated (design §8, stage-2 scope):
 *   4 reconciliation: C/JS record counts, seq and blockBytes agree
 *     exactly; any record with drop_cumulative > 0 rejects the run.
 *   3 residual: RES = E2E - (encode + queue_and_pipe + parse + result)
 *     must be <= 5% of E2E (median-based). queue_and_pipe (S9J) already
 *     contains the C-side span, so C segments are reported alongside,
 *     never added into E2E a second time (§3.3).
 *   5 clock sanity (reporting form): if the sampled sclk is not
 *     dominantly 2320 MHz the run is flagged "quiet window not
 *     established" — values are still printed, always with their sclk
 *     and multiplier, never bare next to reference values.
 * Gates 1 (selection consistency, end-to-end form) and 2 (ABAB
 * overhead) need a live GPU serve and stay with the GPU-window lane;
 * gate 1's stage-1/stage-2-corpus scope already passed offline.
 */
import { readFileSync } from "node:fs";

import { segmentStats, threePointSet } from "./tail-parse-harness.js";
import {
  parseTailCBin,
  TAIL_MISS,
  type TailCRecord,
  type TailJsHeader,
  type TailJsRecord,
} from "./tail-trace.js";

export interface JoinedDecision {
  readonly seq: number;
  readonly c: TailCRecord;
  readonly js: TailJsRecord;
}

export interface AggregateResult {
  readonly joined: JoinedDecision[];
  readonly gates: {
    reconciliation: { ok: boolean; failures: string[] };
    residual: { ok: boolean; median_res_ns: number; median_e2e_ns: number; ratio: number };
    clock: { ok: boolean; sclk_mhz: number | null; note: string };
  };
  /** Per-segment 3-point sets keyed by definition label. */
  readonly segments: Record<string, ReturnType<typeof threePointSet>>;
}

export function parseJsSidecar(text: string): { header: TailJsHeader; records: TailJsRecord[] } {
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) throw new Error("tail JS sidecar: empty");
  const header = JSON.parse(lines[0]) as TailJsHeader;
  if (header.type !== "header" || header.kind !== "tail-js") {
    throw new Error("tail JS sidecar: first line is not the tail header");
  }
  const records = lines.slice(1).map((l) => JSON.parse(l) as TailJsRecord);
  return { header, records };
}

const num = (v: bigint): number | null => (v === TAIL_MISS ? null : Number(v));

function segment(
  out: Record<string, ReturnType<typeof threePointSet>>,
  label: string,
  values: (number | null)[],
  sclkMHz: number | null,
): void {
  const present = values.filter((x): x is number => x !== null);
  if (present.length === 0) return;
  out[label] = threePointSet(segmentStats(present), sclkMHz);
}

export function aggregate(cBytes: Uint8Array, jsText: string): AggregateResult {
  const { header: cHeader, records: cRecords } = parseTailCBin(cBytes);
  const { header: jsHeader, records: jsRecords } = parseJsSidecar(jsText);

  // Gate 4: reconciliation completeness.
  const failures: string[] = [];
  if (cRecords.length !== jsRecords.length) {
    failures.push(`record count C=${cRecords.length} != JS=${jsRecords.length}`);
  }
  const jsBySeq = new Map(jsRecords.map((r) => [r.seq, r]));
  const joined: JoinedDecision[] = [];
  cRecords.forEach((c, i) => {
    if (c.seq !== BigInt(i)) failures.push(`C seq gap at position ${i}: seq=${c.seq}`);
    if (c.drop_cumulative > 0)
      failures.push(`C seq ${c.seq}: drop_cumulative=${c.drop_cumulative}`);
    const js = jsBySeq.get(Number(c.seq));
    if (!js) {
      failures.push(`C seq ${c.seq}: no JS record`);
      return;
    }
    if (js.blockBytes !== c.blockBytes) {
      failures.push(`seq ${c.seq}: blockBytes C=${c.blockBytes} != JS=${js.blockBytes}`);
    }
    joined.push({ seq: Number(c.seq), c, js });
  });
  for (const js of jsRecords) {
    if (!cRecords.some((c) => Number(c.seq) === js.seq)) {
      failures.push(`JS seq ${js.seq}: no C record`);
    }
  }

  // sclk: the C header's single sample is the run's reference; the JS
  // header samples must not contradict it materially.
  const sclkMHz = cHeader.sclk_mhz > 0 ? cHeader.sclk_mhz : null;
  const jsSclk = jsHeader.sclk_samples.at(-1)?.sclk_mhz ?? null;

  // Per-segment 3-point sets, every row definition-labeled (§5.4).
  const segments: AggregateResult["segments"] = {};
  const pick = (f: (d: JoinedDecision) => number | null) => joined.map(f);
  segment(
    segments,
    "e2e",
    pick((d) => d.js.e2e_ns),
    sclkMHz,
  );
  segment(
    segments,
    "c_wall_prereadback",
    pick((d) => num(d.c.span_wall_ns)),
    sclkMHz,
  );
  segment(
    segments,
    "gpu_span",
    pick((d) => num(d.c.gpu_ns)),
    sclkMHz,
  );
  segment(
    segments,
    "tail_s6a",
    pick((d) => num(d.c.s6a_ns)),
    sclkMHz,
  );
  segment(
    segments,
    "tail_s6b",
    pick((d) => num(d.c.s6b_ns)),
    sclkMHz,
  );
  segment(
    segments,
    "tail_s6c",
    pick((d) => num(d.c.s6c_ns)),
    sclkMHz,
  );
  segment(
    segments,
    "tail_s6",
    pick((d) => {
      const a = num(d.c.s6a_ns);
      const b = num(d.c.s6b_ns);
      const c = num(d.c.s6c_ns);
      return a === null || b === null || c === null ? null : a + b + c;
    }),
    sclkMHz,
  );
  segment(
    segments,
    "tail_s7",
    pick((d) => num(d.c.s7_ns)),
    sclkMHz,
  );
  segment(
    segments,
    "tail_s8",
    pick((d) => num(d.c.s8_ns)),
    sclkMHz,
  );
  segment(
    segments,
    "tail_s9c",
    pick((d) => num(d.c.s9c_ns)),
    sclkMHz,
  );
  segment(
    segments,
    "tail_s9j",
    pick((d) => d.js.queue_and_pipe_ns),
    sclkMHz,
  );
  segment(
    segments,
    "tail_s10f",
    pick((d) => d.js.parse_full_ns),
    sclkMHz,
  );
  segment(
    segments,
    "tail_s10l",
    pick((d) => d.js.parse_light_ns),
    sclkMHz,
  );
  segment(
    segments,
    "tail_s11",
    pick((d) => d.js.result_ns),
    sclkMHz,
  );
  segment(
    segments,
    "encode",
    pick((d) => d.js.encode_ns),
    sclkMHz,
  );

  // Gate 3: residual (§3.3). S9J already contains the C-side work, so
  // the JS-observable sum is encode + S9J + parse + result.
  const resValues = joined.map((d) => {
    const parse = d.js.parse_light_ns ?? d.js.parse_full_ns ?? 0;
    return d.js.e2e_ns - (d.js.encode_ns + d.js.queue_and_pipe_ns + parse + d.js.result_ns);
  });
  const medianRes = segmentStats(resValues).median_ns;
  const medianE2e = segmentStats(joined.map((d) => d.js.e2e_ns)).median_ns;
  const ratio = medianE2e > 0 ? medianRes / medianE2e : 0;

  // Gate 5 (reporting form): 2320 MHz dominant or the run is flagged.
  const clockOk = sclkMHz !== null && Math.abs(sclkMHz - 2320) < 1;
  return {
    joined,
    gates: {
      reconciliation: { ok: failures.length === 0, failures },
      residual: { ok: ratio <= 0.05, median_res_ns: medianRes, median_e2e_ns: medianE2e, ratio },
      clock: {
        ok: clockOk,
        sclk_mhz: sclkMHz,
        note: clockOk
          ? "sclk 2320 MHz: quiet window established"
          : `sclk ${sclkMHz ?? jsSclk ?? "unknown"} MHz != 2320: quiet window NOT established; ` +
            "values are reported only as measured+sclk+multiplier+converted [見積]",
      },
    },
    segments,
  };
}

// CLI: bun tools/s2-lab/tail-trace-aggregate.ts <trace-path>
//   reads <trace-path>.c.bin and <trace-path>.js.jsonl, prints JSON.
if (import.meta.main) {
  const base = process.argv[2];
  if (!base) {
    console.error("usage: tail-trace-aggregate.ts <trace-path>");
    process.exit(2);
  }
  const result = aggregate(
    new Uint8Array(readFileSync(`${base}.c.bin`)),
    readFileSync(`${base}.js.jsonl`, "utf8"),
  );
  const { joined: _joined, ...printable } = result;
  console.log(JSON.stringify({ decisions: result.joined.length, ...printable }, null, 2));
  if (!result.gates.reconciliation.ok) process.exit(1);
}
