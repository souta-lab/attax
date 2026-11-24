import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type ParsedBlock, parseServeBlock, resultForCompactBlock } from "./gpu-codec.js";
import { createPersistentGpuAttaxDecider, gpuPersistentEngineInfo } from "./gpu-player.js";
import type { SearchInput } from "./state.js";

// --- env guard (mirrors gpu-codec.test.ts) ----------------------------------

const ENV_KEYS = [
  "ATTAX_S2_PROFILE",
  "ATTAX_S2_STOCK_POTENTIAL",
  "ATTAX_S2_SOLVENCY",
  "ATTAX_S2_SOLVENCY_MODE",
  "ATTAX_S2_DIVERSE",
  "ATTAX_S2_GARBAGE_SCENARIOS",
  "ATTAX_PFSERVE",
  "ATTAX_GPU_TABLES",
  "ATTAX_GPU_DEVICE",
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

function baseInput(over: Partial<SearchInput> = {}): SearchInput {
  return {
    board: new Uint16Array(40),
    frame: 0,
    garbageRows: new Array(40).fill(0),
    active: { kind: "O", rotation: 0, x: 4, y: 19 },
    hold: null,
    canHold: true,
    preview: ["T"],
    b2b: false,
    b2bChain: 0,
    combo: -1,
    pending: 0,
    dueThisLock: 0,
    speculativePieces: [],
    ...over,
  };
}

// --- compact block builder (pfserve's layout) --------------------------------

interface HeadSpec {
  kind: number;
  rotation: number;
  x: number;
  y: number;
  usedHold?: boolean;
  value: number;
}

function writeHead(view: DataView, off: number, h: HeadSpec): void {
  view.setInt32(off + 0, h.kind, true);
  view.setInt32(off + 4, h.rotation, true);
  view.setInt32(off + 8, h.x, true);
  view.setInt32(off + 12, h.y, true);
  view.setInt32(off + 16, 0, true); // lastSrs
  view.setInt32(off + 20, 0, true); // tspin: none
  view.setUint32(off + 24, h.usedHold ? 1 : 0, true);
  view.setFloat64(off + 28, h.value, true);
}

/** status + head + candidates + nPlies=0 + trailer, as pfserve writes it. */
function compactBlock(best: HeadSpec, candidates: HeadSpec[]): Uint8Array {
  const bytes = 4 + 48 + 4 + candidates.length * 36 + 4 + 32;
  const buf = new Uint8Array(bytes);
  const view = new DataView(buf.buffer);
  view.setUint32(0, 0, true); // status 0
  writeHead(view, 4, best);
  view.setBigUint64(4 + 36, 12345n, true); // nodes
  view.setUint32(4 + 44, 7, true); // depth
  let off = 4 + 48;
  view.setUint32(off, candidates.length, true);
  off += 4;
  for (const c of candidates) {
    writeHead(view, off, c);
    off += 36;
  }
  view.setUint32(off, 0, true); // nPlies = 0 (compact)
  off += 4;
  view.setFloat64(off, 1.5, true); // wall ms
  view.setFloat64(off + 8, 1.1, true); // gpu ms
  return buf;
}

// O = kind index 1; its rotation-0 cells are (1,0),(2,0),(1,1),(2,1).
const BEST_O: HeadSpec = { kind: 1, rotation: 0, x: 0, y: 0, value: 12.5 };
const ALT_T: HeadSpec = { kind: 2, rotation: 0, x: 3, y: 0, usedHold: true, value: 9.25 };

function bestOf(parsed: ParsedBlock): NonNullable<ParsedBlock["best"]> {
  if (!parsed.best) throw new Error("test block has no best");
  return parsed.best;
}

describe("gpu codec: compact (persistent-form) blocks", () => {
  test("selection, candidates, value, nodes, depth come from the block", () => {
    const parsed = parseServeBlock(compactBlock(BEST_O, [BEST_O, ALT_T]));
    expect(parsed.plies).toEqual([]);
    const best = bestOf(parsed);
    const result = resultForCompactBlock(
      parsed,
      baseInput(),
      best.placement,
      false,
      best.valueBits,
    );
    expect(result.best.placement.kind).toBe("O");
    expect(result.best.usedHold).toBe(false);
    expect(result.value).toBe(12.5);
    expect(result.nodes).toBe(12345);
    expect(result.depth).toBe(7);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[1]?.placement.kind).toBe("T");
    expect(result.candidates[1]?.usedHold).toBe(true);
    expect(result.candidates[1]?.value).toBe(9.25);
  });

  test("linesCleared is the exact board fact of the root lock", () => {
    // Rows 0 and 1 filled except columns 1-2 — exactly the O footprint.
    const board = new Uint16Array(40);
    board[0] = 0x3f9;
    board[1] = 0x3f9;
    const parsed = parseServeBlock(compactBlock(BEST_O, [BEST_O]));
    const best = bestOf(parsed);
    const result = resultForCompactBlock(
      parsed,
      baseInput({ board }),
      best.placement,
      false,
      best.valueBits,
    );
    expect(result.best.linesCleared).toBe(2);
    // Same placement on an empty board completes nothing.
    const parsed2 = parseServeBlock(compactBlock(BEST_O, [BEST_O]));
    const best2 = bestOf(parsed2);
    const result2 = resultForCompactBlock(
      parsed2,
      baseInput(),
      best2.placement,
      false,
      best2.valueBits,
    );
    expect(result2.best.linesCleared).toBe(0);
  });

  test("fields the compact block does not carry are absent, not invented", () => {
    const parsed = parseServeBlock(compactBlock(BEST_O, [BEST_O]));
    const best = bestOf(parsed);
    const result = resultForCompactBlock(
      parsed,
      baseInput(),
      best.placement,
      false,
      best.valueBits,
    );
    expect(Number.isNaN(result.best.attack)).toBe(true);
    expect(Number.isNaN(result.best.reward)).toBe(true);
    expect(result.breakdown).toEqual({});
    expect(result.line).toEqual([result.best]);
  });

  test("a full block (plies present) is refused — wrong builder", () => {
    const parsed = parseServeBlock(compactBlock(BEST_O, [BEST_O]));
    const best = bestOf(parsed);
    const full: ParsedBlock = { ...parsed, plies: [{ beam: [], finished: [] }] };
    expect(() => resultForCompactBlock(full, baseInput(), best.placement, false, 0n)).toThrow(
      "full block",
    );
  });

  test("a placement outside the board is refused", () => {
    const parsed = parseServeBlock(
      compactBlock({ kind: 1, rotation: 0, x: 9, y: 0, value: 1 }, []),
    );
    const best = bestOf(parsed);
    expect(() =>
      resultForCompactBlock(parsed, baseInput(), best.placement, false, best.valueBits),
    ).toThrow("outside the 10x40 board");
  });
});

// --- factory: config-O refusal parity + fake pfserve wiring ------------------

describe("persistent gpu decider: config-O refusal parity", () => {
  test("stock off is refused exactly like the basic form", async () => {
    clearEnv();
    await expect(createPersistentGpuAttaxDecider()).rejects.toThrow("stock Φ is OFF");
  });

  test("divergences are listed: width and solvency", async () => {
    clearEnv();
    process.env.ATTAX_S2_STOCK_POTENTIAL = "1";
    await expect(createPersistentGpuAttaxDecider(tempProfile({ width: 48 }))).rejects.toThrow(
      "beam width is 48",
    );
    process.env.ATTAX_S2_SOLVENCY = "1";
    await expect(createPersistentGpuAttaxDecider()).rejects.toThrow("solvency is ON");
  });

  test("config O constructs; sync decide is refused as async-only", async () => {
    clearEnv();
    process.env.ATTAX_S2_STOCK_POTENTIAL = "1";
    const decider = await createPersistentGpuAttaxDecider();
    expect(() => decider.decide(baseInput(), {})).toThrow("async-only");
    decider.close();
  });
});

describe("persistent gpu decider: fake pfserve wiring", () => {
  test("handshake (profile banner + device), framing, compact result", async () => {
    clearEnv();
    process.env.ATTAX_S2_STOCK_POTENTIAL = "1";
    const dir = mkdtempSync(path.join(tmpdir(), "gpu-fake-pf-"));
    const runner = path.join(dir, "fake-pfserve");
    // The fake answers every 432-byte record with the same compact block
    // the codec tests build: best O@(0,0) value 12.5, alt T@(3,0) hold.
    const blockLiteral = Array.from(compactBlock(BEST_O, [BEST_O, ALT_T])).join(",");
    writeFileSync(
      runner,
      `#!${process.execPath}\n` +
        `process.stderr.write("profile: s2 (persistent r15)\\n");\n` +
        `process.stderr.write("selected: FakeGPU PF 9999\\n");\n` +
        `const block = Buffer.from([${blockLiteral}]);\n` +
        `let buf = Buffer.alloc(0);\n` +
        `process.stdin.on("data", (c) => {\n` +
        `  buf = Buffer.concat([buf, c]);\n` +
        `  while (buf.length >= 432) {\n` +
        `    buf = buf.subarray(432);\n` +
        `    const hdr = Buffer.alloc(8);\n` +
        `    hdr.writeUInt32LE(0, 0);\n` +
        `    hdr.writeUInt32LE(block.length, 4);\n` +
        `    process.stdout.write(Buffer.concat([hdr, block]));\n` +
        `  }\n` +
        `});\n`,
    );
    chmodSync(runner, 0o755);
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    process.env.ATTAX_PFSERVE = runner;
    process.env.ATTAX_GPU_TABLES = path.join(repoRoot, "gpu", "tables.bin");
    try {
      const info = await gpuPersistentEngineInfo();
      expect(info.device).toBe("FakeGPU PF 9999");
      expect(info.form).toBe("persistent");
      const decider = await createPersistentGpuAttaxDecider();
      const board = new Uint16Array(40);
      board[0] = 0x3f9;
      board[1] = 0x3f9;
      const result = await decider.decideAsync(baseInput({ board }), {});
      expect(result?.best.placement.kind).toBe("O");
      expect(result?.best.linesCleared).toBe(2);
      expect(result?.value).toBe(12.5);
      // acceptRoot post-filter: reject the unfiltered best (no hold),
      // accept the held candidate — same contract as the basic form.
      const filtered = await decider.decideAsync(
        baseInput({
          board,
          acceptRoot: (_placement, usedHold) => usedHold,
        }),
        {},
      );
      expect(filtered?.best.placement.kind).toBe("T");
      expect(filtered?.best.usedHold).toBe(true);
      expect(filtered?.value).toBe(9.25);
      decider.close();
    } finally {
      delete process.env.ATTAX_PFSERVE;
      delete process.env.ATTAX_GPU_TABLES;
    }
  });
});
