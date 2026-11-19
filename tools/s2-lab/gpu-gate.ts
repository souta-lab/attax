/**
 * Offline equivalence gate for the GPU lab codec (no GPU required).
 *
 * Usage: bun tools/s2-lab/gpu-gate.ts [gateDir]
 *   gateDir must contain obs.bin, decisions.bin, expect.bin
 *   (default: $ATTAX_GPU_GATE_DIR or /tmp/gpu-gate).
 *
 * Two checks over the full gate corpus (180 decisions):
 *  1. Encoder: obs.bin records, rebuilt into shared SearchInputs the
 *     way m4-harness obs_inputs does, encode byte-for-byte to the
 *     genfull decisions in decisions.bin.
 *  2. Decoder: each genfull expectation (expect.bin) is spliced into
 *     the serve block shape (status word + expectation payload + zero
 *     timing trailer — the payload layout is identical by design) and
 *     decoded; best / candidates / value / nodes / depth must match
 *     the expectation summary exactly, and the reconstructed step
 *     stats + breakdown must match the expectation's own depth-1 node.
 *
 * The live serve path itself is gated separately on the GPU machine
 * (adoption gate, gpu/README.md); this script gates the lab-side codec
 * against the same reference data.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { BOARD_FEATURES, boardFeatures } from "../../src/ai/bot/features.js";
import type { SearchInput } from "../../src/ai/bot/state.js";
import { DEFAULT_WEIGHTS } from "../../src/ai/bot/weights.js";
import {
  DECISION_BYTES,
  decodeServeBlock,
  encodeDecisionRecordBytes,
  kindByIndex,
} from "./gpu-codec.js";

const gateDir = process.argv[2] ?? process.env.ATTAX_GPU_GATE_DIR ?? "/tmp/gpu-gate";
const obs = readFileSync(path.join(gateDir, "obs.bin"));
const decisions = readFileSync(path.join(gateDir, "decisions.bin"));
const expect = readFileSync(path.join(gateDir, "expect.bin"));

const OBS_BYTES = 154;
if (obs.length % OBS_BYTES !== 0)
  throw new Error(`obs.bin size ${obs.length} not a multiple of ${OBS_BYTES}`);
const nObs = obs.length / OBS_BYTES;

const decView = new DataView(decisions.buffer, decisions.byteOffset, decisions.byteLength);
if (decView.getUint32(0, true) !== 0x4d344443) throw new Error("decisions.bin: bad magic");
const nDec = decView.getUint32(4, true);
if (nDec !== nObs) throw new Error(`corpus size mismatch: obs ${nObs} vs decisions ${nDec}`);
if (decisions.length !== 8 + nDec * DECISION_BYTES) {
  throw new Error(`decisions.bin size ${decisions.length} != 8 + ${nDec} * ${DECISION_BYTES}`);
}

/** Mirror of m4-harness obs_inputs: 154-byte referee records -> SearchInput. */
function obsInput(rec: Uint8Array): SearchInput {
  const view = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  const board = new Uint16Array(40);
  for (let i = 0; i < 40; i++) board[i] = view.getUint16(i * 2, true);
  const garbageRows: number[] = [];
  for (let i = 0; i < 40; i++) garbageRows.push(rec[80 + i]);
  const p = (i: number) => rec[120 + i];
  const gi = (o: number) => view.getInt32(120 + 18 + o, true);
  const knownLen = p(4);
  const preview = [];
  // obs "known" list = the preview AFTER the current piece (obs_inputs
  // sets preview: known verbatim; the current kind is p[0], separate).
  for (let i = 0; i < knownLen; i++) preview.push(kindByIndex(p(5 + i)));
  const chain = gi(4);
  return {
    board,
    frame: 0,
    garbageRows,
    active: { kind: kindByIndex(p(0)), rotation: 0, x: 3, y: 19 },
    hold: p(1) !== 0 ? kindByIndex(p(2)) : null,
    canHold: p(3) !== 0,
    preview,
    b2b: chain > 0,
    b2bChain: chain,
    combo: gi(0),
    pending: gi(8),
    dueThisLock: gi(12),
    speculativePieces: [],
  };
}

// --- Check 1: encoder byte identity --------------------------------------
let encBad = 0;
for (let d = 0; d < nObs; d++) {
  const rec = obs.subarray(d * OBS_BYTES, (d + 1) * OBS_BYTES);
  const encoded = encodeDecisionRecordBytes(obsInput(rec));
  const want = decisions.subarray(8 + d * DECISION_BYTES, 8 + (d + 1) * DECISION_BYTES);
  if (!Buffer.from(encoded).equals(Buffer.from(want))) {
    encBad++;
    if (encBad <= 3) {
      for (let i = 0; i < DECISION_BYTES; i++) {
        if (encoded[i] !== want[i]) {
          console.error(
            `encoder mismatch decision ${d} byte ${i} (word ${i >> 2}): got ${encoded[i]}, want ${want[i]}`,
          );
          break;
        }
      }
    }
  }
}
console.log(`encoder: ${nObs - encBad}/${nObs} decisions byte-identical`);

// --- Check 2: decoder against expectations --------------------------------
const bitsOf = (v: number): bigint => {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, v, true);
  return dv.getBigUint64(0, true);
};

const xpHead = new DataView(expect.buffer, expect.byteOffset, 8);
if (xpHead.getUint32(0, true) !== 0x4d345850) throw new Error("expect.bin: bad magic (want M4XP)");
if (xpHead.getUint32(4, true) !== nObs) throw new Error("expect.bin: decision count mismatch");
let xpOff = 8;
const xpU32 = () => {
  const v = new DataView(expect.buffer, expect.byteOffset + xpOff, 4).getUint32(0, true);
  xpOff += 4;
  return v;
};
let decBad = 0;
let decChecked = 0;
for (let d = 0; d < nObs; d++) {
  const start = xpOff;
  const has = xpU32();
  if (has === 0) {
    // Zero-filled status-1 block: status + 56 zero bytes + 32 trailer.
    const block = new Uint8Array(92);
    new DataView(block.buffer).setUint32(0, 1, true);
    const result = decodeServeBlock(block, DEFAULT_WEIGHTS);
    if (result !== null) {
      decBad++;
      console.error(`decoder decision ${d}: expected null (no result), got a result`);
    }
    decChecked++;
    continue;
  }
  // Splice: status word + the expectation's own payload + zero trailer.
  // Payload after `has`: best head (48) + cand count + candidates +
  // ply count + plies — the same bytes a serve block carries.
  const payloadStart = xpOff;
  xpOff += 48; // best head
  const nCand = xpU32();
  xpOff += nCand * 36; // candidate entry: 6 i32 + hold u32 + value u64
  const nPlies = xpU32();
  for (let p = 0; p < nPlies; p++) {
    const nBeam = xpU32();
    xpOff += nBeam * 432;
    const nFin = xpU32();
    xpOff += nFin * 432;
  }
  const payload = expect.subarray(payloadStart, xpOff);
  const block = new Uint8Array(4 + payload.length + 32);
  new DataView(block.buffer).setUint32(0, 0, true);
  block.set(payload, 4);

  // Ground truth from the expectation summary.
  const sum = new DataView(expect.buffer, expect.byteOffset + start + 4, 48);
  const wantTspinIdx = sum.getInt32(20, true);
  const wantTspin = (["none", "mini", "full"] as const)[wantTspinIdx];
  if (wantTspin === undefined) throw new Error(`expectation ${d}: bad tspin index ${wantTspinIdx}`);
  const wantBest = {
    kind: kindByIndex(sum.getInt32(0, true)),
    rotation: sum.getInt32(4, true),
    x: sum.getInt32(8, true),
    y: sum.getInt32(12, true),
    lastSrs: sum.getInt32(16, true),
    tspin: wantTspin,
  };
  const wantHold = sum.getUint32(24, true) !== 0;
  const wantValueBits = sum.getBigUint64(28, true);
  const wantNodes = sum.getBigUint64(36, true);
  const wantDepth = sum.getUint32(44, true);

  const result = decodeServeBlock(block, DEFAULT_WEIGHTS);
  const fail = (msg: string) => {
    decBad++;
    console.error(`decoder decision ${d}: ${msg}`);
  };
  if (!result) {
    fail("expected a result, got null");
    decChecked++;
    continue;
  }
  const bp = result.best.placement;
  if (
    bp.kind !== wantBest.kind ||
    bp.rotation !== wantBest.rotation ||
    bp.x !== wantBest.x ||
    bp.y !== wantBest.y ||
    bp.lastSrs !== wantBest.lastSrs ||
    bp.tspin !== wantBest.tspin ||
    result.best.usedHold !== wantHold
  ) {
    fail(
      `best step mismatch: got ${JSON.stringify(result.best)}, want ${JSON.stringify(wantBest)} hold=${wantHold}`,
    );
  }
  if (bitsOf(result.value) !== wantValueBits) fail(`value bits mismatch`);
  if (BigInt(result.nodes) !== wantNodes)
    fail(`nodes mismatch: got ${result.nodes}, want ${wantNodes}`);
  if (result.depth !== wantDepth) fail(`depth mismatch: got ${result.depth}, want ${wantDepth}`);
  if (result.candidates.length !== nCand) {
    fail(`candidate count mismatch: got ${result.candidates.length}, want ${nCand}`);
  } else {
    const candView = new DataView(
      expect.buffer,
      expect.byteOffset + payloadStart + 48,
      4 + nCand * 36,
    );
    for (let c = 0; c < nCand; c++) {
      const off = 4 + c * 36;
      const got = result.candidates[c];
      const wk = kindByIndex(candView.getInt32(off, true));
      const wv = candView.getBigUint64(off + 28, true);
      if (
        got.placement.kind !== wk ||
        got.placement.rotation !== candView.getInt32(off + 4, true) ||
        got.placement.x !== candView.getInt32(off + 8, true) ||
        got.placement.y !== candView.getInt32(off + 12, true) ||
        got.usedHold !== (candView.getUint32(off + 24, true) !== 0) ||
        bitsOf(got.value) !== wv
      ) {
        fail(`candidate ${c} mismatch`);
        break;
      }
    }
  }
  // Step stats + breakdown: recompute from the expectation's depth-1
  // node for the best root step (found inside the payload's ply 0).
  const pliesOff = 4 + 48 + 4 + nCand * 36;
  const ply0 = new DataView(block.buffer, block.byteOffset + pliesOff, block.length - pliesOff);
  const nPliesInBlock = ply0.getUint32(0, true);
  if (nPliesInBlock < 1) {
    fail("expectation carries no plies");
  } else {
    let off = 4;
    const nBeam = ply0.getUint32(off, true);
    off += 4;
    const nodesInPly0: Uint8Array[] = [];
    for (let i = 0; i < nBeam; i++) {
      nodesInPly0.push(block.subarray(pliesOff + off, pliesOff + off + 432));
      off += 432;
    }
    const nFin = ply0.getUint32(off, true);
    off += 4;
    for (let i = 0; i < nFin; i++) {
      nodesInPly0.push(block.subarray(pliesOff + off, pliesOff + off + 432));
      off += 432;
    }
    let found: DataView | null = null;
    for (const raw of nodesInPly0) {
      const nv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      if (nv.getUint32(93 * 4, true) !== 1 || nv.getUint32(94 * 4, true) === 0) continue;
      if (
        kindByIndex(nv.getInt32(95 * 4, true)) === wantBest.kind &&
        nv.getInt32(96 * 4, true) === wantBest.rotation &&
        nv.getInt32(97 * 4, true) === wantBest.x &&
        nv.getInt32(98 * 4, true) === wantBest.y &&
        nv.getInt32(99 * 4, true) === wantBest.lastSrs &&
        nv.getInt32(100 * 4, true) === wantTspinIdx &&
        (nv.getUint32(101 * 4, true) !== 0) === wantHold
      ) {
        found = nv;
        break;
      }
    }
    if (!found) {
      fail("no depth-1 node for the best root step in the expectation");
    } else {
      if (result.best.linesCleared !== found.getUint32(102 * 4, true))
        fail("linesCleared mismatch");
      if (result.best.attack !== found.getInt32(103 * 4, true)) fail("attack mismatch");
      if (bitsOf(result.best.reward) !== found.getBigUint64(104 * 4, true))
        fail("step reward mismatch");
      const rows = new Uint16Array(40);
      for (let i = 0; i < 40; i++) rows[i] = found.getUint32(i * 4, true) & 0xffff;
      const boardLen = found.getUint32(106 * 4, true) || 40;
      const feats = boardFeatures(rows.subarray(0, boardLen), found.getInt32(85 * 4, true));
      for (const f of BOARD_FEATURES) {
        if (!Object.is(result.breakdown[f], feats[f] * DEFAULT_WEIGHTS.board[f])) {
          fail(`breakdown.${f} mismatch`);
          break;
        }
      }
    }
  }
  decChecked++;
}
if (xpOff !== expect.length) {
  console.error(`expect.bin not fully consumed: ${xpOff} of ${expect.length} bytes`);
  decBad++;
}
console.log(`decoder: ${decChecked - decBad}/${decChecked} decisions match the expectations`);

if (encBad > 0 || decBad > 0) {
  console.error("GPU codec gate: FAIL");
  process.exit(1);
}
console.log("GPU codec gate: PASS");
