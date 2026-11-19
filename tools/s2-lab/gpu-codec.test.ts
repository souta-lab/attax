import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { boardFeatures } from "../../src/ai/bot/features.js";
import type { SearchInput } from "../../src/ai/bot/state.js";
import { DEFAULT_WEIGHTS } from "../../src/ai/bot/weights.js";
import { decodeServeBlock, encodeDecisionRecord, parseServeBlock } from "./gpu-codec.js";
import { createGpuAttaxDecider, gpuEngineInfo } from "./gpu-player.js";

function baseInput(over: Partial<SearchInput> = {}): SearchInput {
  const board = new Uint16Array(40);
  board[0] = 0x1234;
  board[39] = 0x3ff;
  const garbageRows = new Array(40).fill(0);
  garbageRows[0] = 1;
  garbageRows[5] = 1;
  return {
    board,
    frame: 7,
    garbageRows,
    active: { kind: "L", rotation: 2, x: 5, y: 10 },
    hold: "J",
    canHold: false,
    preview: ["T", "S"],
    b2b: false,
    b2bChain: 4,
    combo: 3,
    pending: 2,
    dueThisLock: 1,
    speculativePieces: [],
    ...over,
  };
}

describe("gpu codec: decision record encoder", () => {
  test("lays out every field at genfull's word positions", () => {
    const input = baseInput();
    const w = encodeDecisionRecord(input);
    const i32 = (word: number) => new DataView(w.buffer).getInt32(word * 4, true);
    expect(w[0]).toBe(0x1234);
    expect(w[39]).toBe(0x3ff);
    expect(w[40]).toBe(1);
    expect(w[41]).toBe(0);
    expect(w[45]).toBe(1);
    expect(w[80]).toBe(40);
    expect(w[81]).toBe(3); // seq_len = 1 + preview
    expect(w[82]).toBe(6); // L
    expect(w[83]).toBe(2); // T
    expect(w[84]).toBe(3); // S
    expect(w[85]).toBe(0); // missing preview slots are 0
    expect(i32(96)).toBe(2);
    expect(i32(97)).toBe(5);
    expect(i32(98)).toBe(10);
    expect(i32(99)).toBe(5); // J in hold
    expect(w[100]).toBe(0); // canHold false
    expect(i32(101)).toBe(3);
    expect(i32(102)).toBe(2);
    expect(i32(103)).toBe(4); // exact b2b chain wins over the boolean
    expect(i32(104)).toBe(1);
    expect(i32(105)).toBe(boardFeatures(input.board, 0).tSlot);
    expect(w[106]).toBe(7); // frame u64 low
    expect(w[107]).toBe(0);
  });

  test("null hold encodes as -1 and empty preview as seq_len 1", () => {
    const w = encodeDecisionRecord(baseInput({ hold: null, preview: [] }));
    const view = new DataView(w.buffer);
    expect(view.getInt32(99 * 4, true)).toBe(-1);
    expect(w[81]).toBe(1);
  });

  test("rejects a preview longer than the record's 13 slots", () => {
    const kinds = ["I", "O", "T", "S", "Z", "J", "L"] as const;
    const preview = Array.from({ length: 14 }, (_, i) => kinds[i % 7]);
    expect(() => encodeDecisionRecord(baseInput({ preview }))).toThrow("preview");
  });
});

// --- synthetic serve block -------------------------------------------------

function wireNode(opts: {
  depth: number;
  step?: {
    kind: number;
    rotation: number;
    x: number;
    y: number;
    srs: number;
    tspin: number;
    usedHold: number;
    lines: number;
    attack: number;
    reward: number;
  };
  boardRow0?: number;
}): Uint8Array {
  const buf = new Uint8Array(432);
  const v = new DataView(buf.buffer);
  v.setUint32(0, opts.boardRow0 ?? 0, true);
  v.setInt32(85 * 4, 0, true); // lift
  v.setUint32(93 * 4, opts.depth, true);
  v.setUint32(94 * 4, opts.step ? 1 : 0, true);
  if (opts.step) {
    const s = opts.step;
    v.setInt32(95 * 4, s.kind, true);
    v.setInt32(96 * 4, s.rotation, true);
    v.setInt32(97 * 4, s.x, true);
    v.setInt32(98 * 4, s.y, true);
    v.setInt32(99 * 4, s.srs, true);
    v.setInt32(100 * 4, s.tspin, true);
    v.setUint32(101 * 4, s.usedHold, true);
    v.setUint32(102 * 4, s.lines, true);
    v.setInt32(103 * 4, s.attack, true);
    v.setFloat64(104 * 4, s.reward, true);
  }
  v.setUint32(106 * 4, 40, true); // board_len
  return buf;
}

function serveBlock(): Uint8Array {
  const parts: number[] = [];
  const u32 = (v: number) =>
    parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  const f64 = (v: number) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    parts.push(...b);
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
  u32(0); // status
  head(2, 1, 4, 18, 0, 12.5); // best head (T rot1 x4 y18)
  const nodes = new Uint8Array(8);
  new DataView(nodes.buffer).setBigUint64(0, 12345n, true);
  parts.push(...nodes);
  u32(3); // depth
  u32(2); // candidates
  head(2, 1, 4, 18, 0, 12.5);
  head(0, 0, 0, 19, 1, 3.25);
  u32(1); // plies
  const nodeA = wireNode({
    depth: 1,
    boardRow0: 0b111,
    step: {
      kind: 2,
      rotation: 1,
      x: 4,
      y: 18,
      srs: 0,
      tspin: 0,
      usedHold: 0,
      lines: 2,
      attack: 3,
      reward: 40.5,
    },
  });
  u32(1); // beam count
  parts.push(...nodeA);
  u32(0); // finished count
  f64(4.25);
  f64(3.5);
  f64(0);
  f64(0.75); // trailer
  return new Uint8Array(parts);
}

describe("gpu codec: serve block decoder", () => {
  test("reconstructs the SearchResult incl. step stats and breakdown", () => {
    const block = serveBlock();
    const parsed = parseServeBlock(block);
    expect(parsed.status).toBe(0);
    expect(parsed.wallMs).toBe(4.25);
    expect(parsed.gpuMs).toBe(3.5);
    const r = decodeServeBlock(block, DEFAULT_WEIGHTS);
    expect(r).not.toBeNull();
    if (r === null) throw new Error("expected a decoded result");
    expect(r.best.placement).toEqual({
      kind: "T",
      rotation: 1,
      x: 4,
      y: 18,
      lastSrs: 0,
      tspin: "none",
    });
    expect(r.best.usedHold).toBe(false);
    expect(r.best.linesCleared).toBe(2);
    expect(r.best.attack).toBe(3);
    expect(r.best.reward).toBe(40.5);
    expect(r.value).toBe(12.5);
    expect(r.nodes).toBe(12345);
    expect(r.depth).toBe(3);
    expect(r.candidates.length).toBe(2);
    expect(r.candidates[1].value).toBe(3.25);
    expect(r.candidates[1].usedHold).toBe(true);
    expect(r.line.length).toBe(1);
    const board = new Uint16Array(40);
    board[0] = 0b111;
    const feats = boardFeatures(board, 0);
    expect(r.breakdown.maxHeight).toBe(feats.maxHeight * DEFAULT_WEIGHTS.board.maxHeight);
    expect(r.breakdown.holes).toBe(feats.holes * DEFAULT_WEIGHTS.board.holes);
  });

  test("status 1 decodes to null, status 2 throws, truncation throws", () => {
    const empty = new Uint8Array(92);
    new DataView(empty.buffer).setUint32(0, 1, true);
    expect(decodeServeBlock(empty, DEFAULT_WEIGHTS)).toBeNull();
    const err = new Uint8Array(92);
    new DataView(err.buffer).setUint32(0, 2, true);
    expect(() => parseServeBlock(err)).toThrow("kernel error");
    expect(() => parseServeBlock(serveBlock().subarray(0, 100))).toThrow();
  });
});

// --- config-O refusal -------------------------------------------------------

const ENV_KEYS = [
  "ATTAX_S2_PROFILE",
  "ATTAX_S2_STOCK_POTENTIAL",
  "ATTAX_S2_SOLVENCY",
  "ATTAX_S2_SOLVENCY_MODE",
  "ATTAX_S2_DIVERSE",
  "ATTAX_S2_GARBAGE_SCENARIOS",
];
const savedEnv = new Map<string, string | undefined>();
function clearEnv() {
  for (const k of ENV_KEYS) {
    savedEnv.set(k, process.env[k]);
    delete process.env[k];
  }
}
afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  savedEnv.clear();
});

function tempProfile(obj: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gpu-profile-"));
  const file = path.join(dir, "profile.json");
  writeFileSync(file, JSON.stringify(obj));
  return file;
}

describe("gpu decider: config-O refusal", () => {
  test("stock off is refused (the GPU engine always applies stock Φ)", async () => {
    clearEnv();
    await expect(createGpuAttaxDecider()).rejects.toThrow("stock Φ is OFF");
  });

  test("config O via env constructs; sync decide is refused as async-only", async () => {
    clearEnv();
    process.env.ATTAX_S2_STOCK_POTENTIAL = "1";
    const decider = await createGpuAttaxDecider();
    expect(() => decider.decide(baseInput(), {})).toThrow("async-only");
    decider.close();
  });

  test("config O via profile stock constructs without the env flag", async () => {
    clearEnv();
    const file = tempProfile({ mechanisms: { stock: {} } });
    const decider = await createGpuAttaxDecider(file);
    decider.close();
  });

  test("fake serve process: handshake, framing, status-1 null path", async () => {
    clearEnv();
    process.env.ATTAX_S2_STOCK_POTENTIAL = "1";
    const dir = mkdtempSync(path.join(tmpdir(), "gpu-fake-"));
    const runner = path.join(dir, "fake-runner");
    writeFileSync(
      runner,
      `#!${process.execPath}\n` +
        `process.stderr.write("selected: FakeGPU RTX 9999 (fake)\\n");\n` +
        `let buf = Buffer.alloc(0);\n` +
        `process.stdin.on("data", (c) => {\n` +
        `  buf = Buffer.concat([buf, c]);\n` +
        `  while (buf.length >= 432) {\n` +
        `    buf = buf.subarray(432);\n` +
        `    const block = Buffer.alloc(92);\n` +
        `    block.writeUInt32LE(1, 0);\n` +
        `    const hdr = Buffer.alloc(8);\n` +
        `    hdr.writeUInt32LE(1, 0);\n` +
        `    hdr.writeUInt32LE(92, 4);\n` +
        `    process.stdout.write(Buffer.concat([hdr, block]));\n` +
        `  }\n` +
        `});\n`,
    );
    chmodSync(runner, 0o755);
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const savedRunner = process.env.ATTAX_GPU_RUNNER;
    const savedTables = process.env.ATTAX_GPU_TABLES;
    process.env.ATTAX_GPU_RUNNER = runner;
    process.env.ATTAX_GPU_TABLES = path.join(repoRoot, "gpu", "tables.bin");
    try {
      const info = await gpuEngineInfo();
      expect(info.device).toBe("FakeGPU RTX 9999 (fake)");
      const decider = await createGpuAttaxDecider();
      const result = await decider.decideAsync(baseInput(), {});
      expect(result).toBeNull();
      decider.close();
    } finally {
      if (savedRunner === undefined) delete process.env.ATTAX_GPU_RUNNER;
      else process.env.ATTAX_GPU_RUNNER = savedRunner;
      if (savedTables === undefined) delete process.env.ATTAX_GPU_TABLES;
      else process.env.ATTAX_GPU_TABLES = savedTables;
    }
  });

  test("divergences are listed: width, weights, stock params, solvency", async () => {
    clearEnv();
    process.env.ATTAX_S2_STOCK_POTENTIAL = "1";
    await expect(createGpuAttaxDecider(tempProfile({ width: 48 }))).rejects.toThrow(
      "beam width is 48",
    );
    await expect(createGpuAttaxDecider(tempProfile({ attack: 91 }))).rejects.toThrow(
      "weights.attack is 91",
    );
    await expect(
      createGpuAttaxDecider(tempProfile({ mechanisms: { stock: { betaB: 0.25 } } })),
    ).rejects.toThrow("stock Φ is {scale 1, betaB 0.25, betaR 0.5}");
    process.env.ATTAX_S2_SOLVENCY = "1";
    await expect(createGpuAttaxDecider()).rejects.toThrow("solvency is ON");
  });
});
