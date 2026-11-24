/**
 * Selection-agreement check between the two GPU execution forms
 * (latency floor audit 2026-11-24 §6/§9): drive the SAME gate corpus
 * through the basic form (vkrunner_s26 serve) and the persistent form
 * (pfserve, r15) and compare the SELECTED root step (placement +
 * usedHold) per decision — the persistent form's verification contract
 * (r15 measured 180/180 against the basic form's canonical output).
 * Full-record identity is NOT checked: pfserve's compact block does
 * not carry the ply dump, by design, so there is nothing to compare
 * beyond the selection, the candidates and the value.
 *
 * Usage: bun tools/s2-lab/persistent-agreement.ts [gateDir]
 *   gateDir must contain obs.bin and decisions.bin (the gpu-gate
 *   corpus; default: $ATTAX_GPU_GATE_DIR or /tmp/gpu-gate).
 *
 * Requires a real Vulkan GPU and both serve binaries (bash
 * gpu/build.sh). Config O must resolve: set ATTAX_S2_STOCK_POTENTIAL=1
 * (or pass a config-O profile via ATTAX_S2_PROFILE). This is a
 * correctness check, not a latency measurement, but it holds the GPU
 * exclusively while it runs — schedule it in a quiet GPU window
 * (audit §9.1). Exit code 0 iff every decision agrees (null == null
 * counts as agreement).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Placement } from "./board.js";
import { DECISION_BYTES, encodeDecisionRecordBytes, kindByIndex } from "./gpu-codec.js";
import { createGpuAttaxDecider, createPersistentGpuAttaxDecider } from "./gpu-player.js";
import type { SearchInput } from "./state.js";

const gateDir = process.argv[2] ?? process.env.ATTAX_GPU_GATE_DIR ?? "/tmp/gpu-gate";
const obs = readFileSync(path.join(gateDir, "obs.bin"));
const decisions = readFileSync(path.join(gateDir, "decisions.bin"));

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

/** Mirror of m4-harness obs_inputs, copied from gpu-gate.ts verbatim. */
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

function stepKey(placement: Placement, usedHold: boolean): string {
  return (
    `${placement.kind}:${placement.rotation}:${placement.x}:${placement.y}:` +
    `${placement.lastSrs}:${placement.tspin}:${usedHold}`
  );
}

// Corpus sanity: the encoder must reproduce decisions.bin byte-for-byte
// (gpu-gate check 1), so a corpus mixup cannot masquerade as a
// selection disagreement.
const inputs: SearchInput[] = [];
let encBad = 0;
for (let d = 0; d < nObs; d++) {
  const input = obsInput(obs.subarray(d * OBS_BYTES, (d + 1) * OBS_BYTES));
  inputs.push(input);
  const encoded = encodeDecisionRecordBytes(input);
  const want = decisions.subarray(8 + d * DECISION_BYTES, 8 + (d + 1) * DECISION_BYTES);
  if (!Buffer.from(encoded).equals(Buffer.from(want))) encBad++;
}
if (encBad > 0) {
  throw new Error(
    `encoder sanity failed on ${encBad}/${nObs} decisions — wrong corpus for this tree; ` +
      "run gpu-gate.ts first",
  );
}
console.log(`corpus: ${nObs} decisions, encoder byte-identical`);

const basic = await createGpuAttaxDecider();
const persistent = await createPersistentGpuAttaxDecider();
let agree = 0;
let disagree = 0;
try {
  for (let d = 0; d < nObs; d++) {
    const input = inputs[d] as SearchInput;
    const b = await basic.decideAsync(input, {});
    const p = await persistent.decideAsync(input, {});
    const bk = b ? stepKey(b.best.placement, b.best.usedHold) : "<null>";
    const pk = p ? stepKey(p.best.placement, p.best.usedHold) : "<null>";
    if (bk === pk) {
      agree++;
    } else {
      disagree++;
      if (disagree <= 10) {
        console.error(`decision ${d}: basic ${bk} != persistent ${pk}`);
      }
    }
  }
} finally {
  basic.close();
  persistent.close();
}
console.log(`selection agreement: ${agree}/${nObs} (${disagree} disagreements)`);
if (disagree > 0) process.exit(1);
