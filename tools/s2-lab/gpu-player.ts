/**
 * GPU decider for the S2 lab — the ONLY engine path for S2 matches from
 * here on (Souta's ruling, 2026-11-19): there is no fallback. When no
 * usable Vulkan device exists the driver stops with a clear error
 * instead of silently degrading to a path tens of times slower, because
 * that silent degradation is what contaminates measurements.
 *
 * The GPU engine (gpu/host/vkrunner_s26.c, serve mode) implements
 * exactly one configuration — config O: the seed weights
 * (DEFAULT_WEIGHTS), stock Φ ON {scale 1, βB 0.5, βR 0.5}, solvency
 * OFF, root veto OFF, diverse roots OFF, width 96, profile "s2". This
 * factory therefore resolves the lab configuration exactly like
 * createAttaxDecider does (profile file + ATTAX_S2_* env) and REFUSES
 * any configuration that does not resolve to config O, listing every
 * divergence. Nothing here imports or wires the Rust driver.
 *
 * Differences from the Rust decider's results, all consequences of the
 * wire format (see gpu-codec.ts):
 * - `line` is [best] only (no parent links are transmitted).
 * - `lineStates` cannot be produced; requesting it is refused.
 * - acceptRoot is applied as a post-filter over the block's root
 *   candidates (the record format cannot carry witness keys). When the
 *   unfiltered best is accepted the result is identical; otherwise the
 *   best accepted candidate wins. This is NOT bit-identical to
 *   in-search filtering in general (the beam is shared across roots).
 *
 * The persistent form (latency floor audit 2026-11-24, candidate P1) is
 * wired alongside the basic form: createPersistentGpuAttaxDecider
 * drives persistent/pfserve (the r15 serve engine, the TBP adapter's
 * default backend) with the SAME config-O resolution and refusal —
 * config O is the s2 profile, so the host's ATTAX_GPU_PROFILE is pinned
 * to "s2" by the driver. pfserve answers with a compact block (head +
 * candidates + trailer, no ply dump), so its results are built by
 * resultForCompactBlock: selection-faithful, with the fields the
 * compact block does not carry (attack / reward / breakdown) absent by
 * construction rather than approximated. Which form a lab run uses is
 * an explicit choice of the caller (run-match: ATTAX_LAB_ENGINE); the
 * basic form remains the default, and match records name the form via
 * GpuEngineInfo.form.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BOT_DEFAULTS } from "./defaults.js";
import {
  encodeDecisionRecordBytes,
  type ParsedBlock,
  parseServeBlock,
  parseServeBlockLight,
  resultForCompactBlock,
  resultForRootStep,
} from "./gpu-codec.js";
import type { DeciderOptions, SearchResult } from "./search-types.js";
import { DEFAULT_SOLVENCY_PARAMS, type SolvencyParams } from "./solvency.js";
import type { SearchInput } from "./state.js";
import { DEFAULT_STOCK_PARAMS, type StockParams } from "./stock.js";
import { DEFAULT_WEIGHTS, type Weights } from "./weights.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const GPU_DIR = path.join(REPO_ROOT, "gpu");
const PERSISTENT_DIR = path.join(REPO_ROOT, "persistent");

/** sha256 of the pinned evaluation tables (W8 lineage on feat/w8-setup-value, 2026-11-25; gpu/README.md). */
export const PINNED_TABLES_SHA256 =
  "3c8fa328f0ffc892547f587b97e4043c4c33fba56636878c8bbfc13277cfacb3";

/** The fixed environment the step-26 host configuration is gated under. */
const SERVE_ENV = {
  S22_PASSA: "off",
  S23_SOA: "1",
  S26_PFUSE: "on",
  S26_LFUSE: "on",
  S26_FILL: "on",
} as const;

/**
 * The persistent host's profile switch. Config O IS the s2 profile, so
 * the lab pins it: an ambient ATTAX_GPU_PROFILE must not leak the
 * guideline ruleset into a config-O driver.
 */
const PERSISTENT_ENV = {
  ATTAX_GPU_PROFILE: "s2",
} as const;

export interface GpuEngineInfo {
  /** Physical device name reported by the host ("selected: <name>"). */
  readonly device: string;
  /** Execution form that produced this info: "basic" | "persistent". */
  readonly form: string;
  readonly runnerPath: string;
  readonly tablesPath: string;
  readonly tablesSha256: string;
}

function runnerPath(): string {
  return process.env.ATTAX_GPU_RUNNER ?? path.join(GPU_DIR, "vkrunner_s26");
}
function pfservePath(): string {
  return process.env.ATTAX_PFSERVE ?? path.join(PERSISTENT_DIR, "pfserve");
}
function tablesPath(): string {
  return process.env.ATTAX_GPU_TABLES ?? path.join(GPU_DIR, "tables.bin");
}
function persistentShaderPath(): string {
  return path.join(GPU_DIR, "shaders", "pfl_r15_serve.spv");
}
function movegenPath(): string {
  // BP B1 movegen (stage 1C). The host's movegen push contract is
  // {base=0, flags=0} for this kernel; the legacy fci kernel is not
  // compatible with the current host pushes.
  return path.join(GPU_DIR, "shaders", "bpmg_b1.spv");
}
function expandPath(): string {
  return path.join(GPU_DIR, "shaders", "expand_s25_noba.spv");
}

function buildHint(): string {
  return `build it with: bash gpu/build.sh (needs gcc + libvulkan; see gpu/README.md)`;
}

/** The pinned-tables verification both execution forms share. */
function verifyTables(): string {
  const tables = tablesPath();
  if (!existsSync(tables)) {
    throw new Error(
      `GPU evaluation tables not found at ${tables} — the pinned PC-lineage ` +
        `tables.bin (sha256 ${PINNED_TABLES_SHA256}) is vendored at gpu/tables.bin`,
    );
  }
  const sha = createHash("sha256").update(readFileSync(tables)).digest("hex");
  if (sha !== PINNED_TABLES_SHA256) {
    throw new Error(
      `GPU evaluation tables lineage mismatch: ${tables} has sha256 ${sha}, ` +
        `the gate-passing pinned file is ${PINNED_TABLES_SHA256}. ` +
        `Regenerated tables differ by ULPs and FAIL the equivalence gate — ` +
        `restore the pinned file (gpu/README.md).`,
    );
  }
  return tables;
}

function verifyStaticAssets(): { runner: string; tables: string } {
  const runner = runnerPath();
  if (!existsSync(runner)) {
    throw new Error(`GPU engine binary not found at ${runner} — ${buildHint()}`);
  }
  for (const spv of [movegenPath(), expandPath()]) {
    if (!existsSync(spv)) {
      throw new Error(`GPU engine shader missing at ${spv} — the gpu/ tree is incomplete`);
    }
  }
  return { runner, tables: verifyTables() };
}

function verifyPersistentAssets(): { runner: string; tables: string } {
  const runner = pfservePath();
  if (!existsSync(runner)) {
    throw new Error(`persistent GPU engine binary not found at ${runner} — ${buildHint()}`);
  }
  const spv = persistentShaderPath();
  if (!existsSync(spv)) {
    throw new Error(`persistent GPU engine shader missing at ${spv} — the gpu/ tree is incomplete`);
  }
  return { runner, tables: verifyTables() };
}

/** Software rasterizers are not a GPU: the product targets real devices only. */
function assertRealDevice(deviceName: string): void {
  const lower = deviceName.toLowerCase();
  if (lower.includes("llvmpipe") || lower.includes("lavapipe") || lower.includes("swiftshader")) {
    throw new Error(
      `GPU engine: only a software Vulkan device is visible ("${deviceName}"). ` +
        `There is no fallback by design (Souta's ruling, 2026-11-19): the engine ` +
        `stops here rather than running tens of times slower and contaminating ` +
        `the measurement. Run on a machine with a real Vulkan GPU.`,
    );
  }
}

interface Waiter {
  resolve: (block: Uint8Array) => void;
  reject: (err: Error) => void;
}

/** How one serve host is spawned: binary, argv, pinned env, identity. */
interface ServeSpec {
  readonly form: string;
  readonly runner: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly tables: string;
  /**
   * Extra stderr evidence that must appear before start() resolves.
   * The persistent host prints its profile banner before device
   * selection; requiring it proves the pinned s2 profile took effect
   * rather than an ambient ATTAX_GPU_PROFILE leaking through.
   */
  readonly expectStderr?: RegExp;
}

function basicServeSpec(runner: string, tables: string): ServeSpec {
  // Host usage: serve <movegen.spv> <expand.spv> <tables.bin> [device]
  const args = ["serve", movegenPath(), expandPath(), tables];
  const device = process.env.ATTAX_GPU_DEVICE;
  if (device) args.push(device);
  return { form: "basic", runner, args, env: SERVE_ENV, tables };
}

function persistentServeSpec(runner: string, tables: string): ServeSpec {
  // Host usage: pfserve serve <pfl_r15_serve.spv> <tables.bin> [G] [device]
  // G stays at the host's default 96 — config O's fixed beam width.
  const args = ["serve", persistentShaderPath(), tables];
  const device = process.env.ATTAX_GPU_DEVICE;
  if (device) args.push(device);
  return {
    form: "persistent",
    runner,
    args,
    env: PERSISTENT_ENV,
    tables,
    expectStderr: /profile: s2 \(persistent r15\)/,
  };
}

/**
 * One long-lived serve process (either execution form; the serve
 * protocol is identical). Requests are serialized (the protocol is a
 * strict request/response stream); a process death rejects every
 * pending and future request loudly — there is no silent restart and
 * no fallback.
 */
class GpuServer {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private starting: Promise<GpuEngineInfo> | null = null;
  private device = "";
  private stderrTail = "";
  private stdoutBuf = Buffer.alloc(0);
  private waiters: Waiter[] = [];
  private failure: Error | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly spec: ServeSpec) {}

  async start(): Promise<GpuEngineInfo> {
    if (this.starting) return this.starting;
    this.starting = this.doStart();
    return this.starting;
  }

  private doStart(): Promise<GpuEngineInfo> {
    return new Promise<GpuEngineInfo>((resolve, reject) => {
      const proc = spawn(this.spec.runner, [...this.spec.args], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...this.spec.env },
      });
      this.proc = proc;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const err = new Error(
          `GPU engine did not report a device within 60s. stderr tail:\n${this.stderrTail}`,
        );
        this.fail(err);
        reject(err);
      }, 60_000);
      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        this.stderrTail = (this.stderrTail + text).slice(-4096);
        if (!settled) {
          const m = /selected:\s*(.+)/.exec(this.stderrTail);
          const extraOk = !this.spec.expectStderr || this.spec.expectStderr.test(this.stderrTail);
          if (m && extraOk) {
            settled = true;
            clearTimeout(timer);
            // vk_setup appends " (timestampPeriod ...)" — the device
            // name proper ends there.
            this.device = m[1].replace(/\s*\(timestampPeriod.*$/, "").trim();
            try {
              assertRealDevice(this.device);
            } catch (err) {
              this.fail(err as Error);
              reject(err as Error);
              return;
            }
            resolve({
              device: this.device,
              form: this.spec.form,
              runnerPath: this.spec.runner,
              tablesPath: this.spec.tables,
              tablesSha256: PINNED_TABLES_SHA256,
            });
          }
        }
      });
      proc.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
      const onDead = (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
        this.fail(err);
      };
      proc.on("error", (e) => onDead(new Error(`GPU engine process error: ${e.message}`)));
      proc.on("exit", (code, signal) =>
        onDead(
          new Error(
            `GPU engine exited (code ${code}, signal ${signal}). stderr tail:\n${this.stderrTail}`,
          ),
        ),
      );
    });
  }

  private fail(err: Error): void {
    if (!this.failure) this.failure = err;
    for (const w of this.waiters.splice(0)) w.reject(this.failure);
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuf = Buffer.concat([this.stdoutBuf, chunk]);
    for (;;) {
      if (this.stdoutBuf.length < 8) return;
      const status = this.stdoutBuf.readUInt32LE(0);
      const blockBytes = this.stdoutBuf.readUInt32LE(4);
      if (this.stdoutBuf.length < 8 + blockBytes) return;
      const block = Buffer.from(this.stdoutBuf.subarray(8, 8 + blockBytes));
      this.stdoutBuf = this.stdoutBuf.subarray(8 + blockBytes);
      const waiter = this.waiters.shift();
      if (!waiter) {
        this.fail(new Error("GPU engine sent a response with no pending request"));
        return;
      }
      if (block.length < 4 || block.readUInt32LE(0) !== status) {
        waiter.reject(
          new Error(
            `GPU serve protocol desync: header status ${status} != block status ` +
              `${block.length >= 4 ? block.readUInt32LE(0) : "<short block>"}`,
          ),
        );
        continue;
      }
      waiter.resolve(block);
    }
  }

  /** Send one 432-byte decision record; resolves with the raw result block. */
  request(record: Uint8Array): Promise<Uint8Array> {
    const run = async (): Promise<Uint8Array> => {
      if (this.failure) throw this.failure;
      await this.start();
      if (this.failure) throw this.failure;
      const proc = this.proc;
      if (!proc) throw new Error("GPU engine process is not running");
      return new Promise<Uint8Array>((resolve, reject) => {
        this.waiters.push({ resolve, reject });
        proc.stdin.write(record, (err) => {
          if (err) reject(new Error(`GPU engine stdin write failed: ${err.message}`));
        });
      });
    };
    const result = this.tail.then(run, run);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  close(): void {
    this.proc?.stdin.end();
    this.proc = null;
  }
}

const gpuTimingSamples: number[] = [];

/** Host-reported per-decision wall times (the block trailer's wall f64). */
export function gpuEngineTimingSummary(): { count: number; meanMs: number; maxMs: number } {
  const count = gpuTimingSamples.length;
  if (count === 0) return { count: 0, meanMs: 0, maxMs: 0 };
  let sum = 0;
  let max = 0;
  for (const ms of gpuTimingSamples) {
    sum += ms;
    if (ms > max) max = ms;
  }
  return { count, meanMs: sum / count, maxMs: max };
}

let sharedServer: GpuServer | null = null;
function getServer(): GpuServer {
  if (!sharedServer) {
    const { runner, tables } = verifyStaticAssets();
    sharedServer = new GpuServer(basicServeSpec(runner, tables));
  }
  return sharedServer;
}

let sharedPersistentServer: GpuServer | null = null;
function getPersistentServer(): GpuServer {
  if (!sharedPersistentServer) {
    const { runner, tables } = verifyPersistentAssets();
    sharedPersistentServer = new GpuServer(persistentServeSpec(runner, tables));
  }
  return sharedPersistentServer;
}

/**
 * Startup probe: verifies the static assets (binary, shaders, pinned
 * tables hash), starts the serve process and returns the selected
 * device. Callers that want fail-fast behaviour (run-match startup)
 * call this once before the first decision; with no usable device it
 * throws — by design there is nothing to fall back to.
 */
export async function gpuEngineInfo(): Promise<GpuEngineInfo> {
  return getServer().start();
}

export function closeGpuEngine(): void {
  sharedServer?.close();
  sharedServer = null;
}

/** The persistent form's startup probe (pfserve; see gpuEngineInfo). */
export async function gpuPersistentEngineInfo(): Promise<GpuEngineInfo> {
  return getPersistentServer().start();
}

export function closePersistentGpuEngine(): void {
  sharedPersistentServer?.close();
  sharedPersistentServer = null;
}

// ---------------------------------------------------------------------------
// Config-O validation. The resolution mirrors createAttaxDecider
// (attax-player.ts, removed in Phase C) field for field; anything that does
// not resolve to the GPU engine's one fixed configuration is refused,
// loudly, in full.
// ---------------------------------------------------------------------------

interface MechanismSettings {
  stock?: StockParams;
  solvency?: SolvencyParams;
  solvencyMode?: "soft" | "hard";
  diverse?: boolean;
  garbageScenarios?: readonly number[];
}

interface GpuProfile {
  /** Weights after merging the profile's top-level patch over DEFAULT_WEIGHTS. */
  weights: Weights;
  mechanisms: MechanismSettings;
  width?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Same merge-over-defaults the lab's profile parser applies. */
function mechanismParams<T extends Record<string, number>>(
  defaults: T,
  patch: unknown,
  path: string,
): T {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error(`expected an object at ${path}`);
  }
  const out: Record<string, number> = { ...defaults };
  for (const [key, value] of Object.entries(patch)) {
    if (!Object.hasOwn(defaults, key)) {
      throw new Error(`unknown mechanism parameter: ${path}.${key}`);
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`expected a finite number at ${path}.${key}`);
    }
    out[key] = value;
  }
  return out as T;
}

function parseGarbageScenarios(value: unknown, where: string): readonly number[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0)
  ) {
    throw new Error(`expected a non-empty list of non-negative integers at ${where}`);
  }
  return [...(value as number[])];
}

function parseMechanisms(raw: unknown): MechanismSettings {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error("expected an object at mechanisms");
  const out: MechanismSettings = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === "stock") {
      out.stock = mechanismParams(DEFAULT_STOCK_PARAMS, value, "mechanisms.stock");
    } else if (key === "solvency") {
      out.solvency = mechanismParams(DEFAULT_SOLVENCY_PARAMS, value, "mechanisms.solvency");
    } else if (key === "solvencyMode") {
      if (value !== "soft" && value !== "hard") {
        throw new Error(`expected "soft" or "hard" at mechanisms.solvencyMode`);
      }
      out.solvencyMode = value;
    } else if (key === "diverse") {
      if (typeof value !== "boolean") {
        throw new Error("expected a boolean at mechanisms.diverse");
      }
      out.diverse = value;
    } else if (key === "garbageScenarios") {
      out.garbageScenarios = parseGarbageScenarios(value, "mechanisms.garbageScenarios");
    } else {
      throw new Error(`unknown mechanism: mechanisms.${key}`);
    }
  }
  return out;
}

function parseProfile(raw: unknown, source: string): GpuProfile {
  if (!isRecord(raw)) throw new Error(`profile at ${source} must be a JSON object`);
  const { mechanisms: rawMechanisms, width: rawWidth, ...patch } = raw;
  const mechanisms = parseMechanisms(rawMechanisms);
  const weights: Weights = {
    ...DEFAULT_WEIGHTS,
    ...(patch as Partial<Weights>),
    board: { ...DEFAULT_WEIGHTS.board, ...((patch.board as object) ?? {}) },
    clear: { ...DEFAULT_WEIGHTS.clear, ...((patch.clear as object) ?? {}) },
    adopt: { ...(DEFAULT_WEIGHTS.adopt ?? {}), ...((patch.adopt as object) ?? {}) },
  };
  if (rawWidth !== undefined && typeof rawWidth !== "number") {
    throw new Error(`profile width at ${source} must be a number`);
  }
  return { weights, mechanisms, width: rawWidth as number | undefined };
}

async function loadProfile(profilePath: string | undefined): Promise<GpuProfile> {
  const p = profilePath ?? process.env.ATTAX_S2_PROFILE;
  if (!p) return { weights: DEFAULT_WEIGHTS, mechanisms: {} };
  const text = await readFile(p, "utf8");
  return parseProfile(JSON.parse(text) as unknown, p);
}

/** The lab's env-over-profile mechanism resolution, verbatim semantics. */
function envMechanism<T>(
  env: string | undefined,
  fromProfile: T | undefined,
  defaults: T,
): T | undefined {
  if (env === "0") return undefined;
  if (env === "1") return fromProfile ?? defaults;
  return fromProfile;
}

function envGarbageScenarios(
  env: string | undefined,
  fromProfile: readonly number[] | undefined,
): readonly number[] | undefined {
  if (env === undefined || env === "") return fromProfile;
  if (env === "off") return undefined;
  const parts = env.split(",");
  if (!parts.every((p) => /^[0-9]+$/.test(p) && Number.isSafeInteger(Number(p)))) {
    throw new Error(
      `expected "off" or a comma list of non-negative integers in ATTAX_S2_GARBAGE_SCENARIOS, got ${env}`,
    );
  }
  return parts.map(Number);
}

function collectWeightDivergences(actual: Weights, out: string[]): void {
  const check = (label: string, a: number | undefined, b: number | undefined) => {
    const av = a ?? 0;
    const bv = b ?? 0;
    if (av !== bv) out.push(`weights.${label} is ${av}, config O requires ${bv}`);
  };
  const boardKeys = Object.keys(DEFAULT_WEIGHTS.board) as (keyof Weights["board"])[];
  for (const k of boardKeys) check(`board.${k}`, actual.board[k], DEFAULT_WEIGHTS.board[k]);
  const clearKeys = Object.keys(DEFAULT_WEIGHTS.clear) as (keyof Weights["clear"])[];
  for (const k of clearKeys) check(`clear.${k}`, actual.clear[k], DEFAULT_WEIGHTS.clear[k]);
  check("attack", actual.attack, DEFAULT_WEIGHTS.attack);
  check("conversion", actual.conversion, DEFAULT_WEIGHTS.conversion);
  check("b2bBreak", actual.b2bBreak, DEFAULT_WEIGHTS.b2bBreak);
  check("wastedT", actual.wastedT, DEFAULT_WEIGHTS.wastedT);
  check("discount", actual.discount, DEFAULT_WEIGHTS.discount);
  const adoptKeys = new Set([
    ...Object.keys(DEFAULT_WEIGHTS.adopt ?? {}),
    ...Object.keys(actual.adopt ?? {}),
  ]) as Set<keyof NonNullable<Weights["adopt"]>>;
  for (const k of adoptKeys) {
    check(
      `adopt.${k}`,
      actual.adopt?.[k] as number | undefined,
      DEFAULT_WEIGHTS.adopt?.[k] as number | undefined,
    );
  }
}

export interface GpuDecider {
  decide: (input: SearchInput, options: DeciderOptions) => SearchResult | null;
  decideAsync: (input: SearchInput, options: DeciderOptions) => Promise<SearchResult | null>;
  close: () => void;
}

/**
 * The config-O resolution both GPU factories share, mirroring
 * createAttaxDecider's option and env resolution (ATTAX_S2_PROFILE /
 * ATTAX_S2_STOCK_POTENTIAL / ATTAX_S2_SOLVENCY / ATTAX_S2_SOLVENCY_MODE /
 * ATTAX_S2_DIVERSE / ATTAX_S2_GARBAGE_SCENARIOS) — and refusing every
 * resolution that is not exactly config O, because neither GPU engine
 * form implements anything else. The refusal text is shared verbatim:
 * a configuration the basic form refuses is refused here too, in full.
 */
async function resolveConfigO(profilePath?: string): Promise<{ weights: Weights }> {
  const profile = await loadProfile(profilePath);
  const weights = profile.weights;
  const mechanisms = profile.mechanisms;

  // Resolution mirrors createAttaxDecider (attax-player.ts, removed in Phase C) exactly.
  const stock = envMechanism(
    process.env.ATTAX_S2_STOCK_POTENTIAL,
    mechanisms.stock,
    DEFAULT_STOCK_PARAMS,
  );
  const solvencyEnv = process.env.ATTAX_S2_SOLVENCY;
  const modeEnv = process.env.ATTAX_S2_SOLVENCY_MODE;
  if (modeEnv !== undefined && modeEnv !== "soft" && modeEnv !== "hard") {
    throw new Error(`expected "soft" or "hard" in ATTAX_S2_SOLVENCY_MODE`);
  }
  const solvencyMode: "soft" | "hard" | undefined =
    solvencyEnv === "0"
      ? undefined
      : (modeEnv ??
        mechanisms.solvencyMode ??
        (mechanisms.solvency !== undefined || solvencyEnv === "1" ? "soft" : undefined));
  const solvency =
    solvencyMode === "soft"
      ? envMechanism(solvencyEnv, mechanisms.solvency, DEFAULT_SOLVENCY_PARAMS)
      : undefined;
  const rootVeto = solvencyMode === "hard";
  const diverseEnv = process.env.ATTAX_S2_DIVERSE;
  if (diverseEnv !== undefined && diverseEnv !== "0" && diverseEnv !== "1") {
    throw new Error(`expected "0" or "1" in ATTAX_S2_DIVERSE, got "${diverseEnv}"`);
  }
  const diverse =
    diverseEnv === "0" ? false : diverseEnv === "1" ? true : (mechanisms.diverse ?? false);
  const garbageScenarios = envGarbageScenarios(
    process.env.ATTAX_S2_GARBAGE_SCENARIOS,
    mechanisms.garbageScenarios,
  );
  const width = profile.width ?? BOT_DEFAULTS.width;

  const problems: string[] = [];
  collectWeightDivergences(weights, problems);
  if (!stock) {
    problems.push(
      "stock Φ is OFF — the GPU engine always applies stock Φ " +
        "{scale 1, betaB 0.5, betaR 0.5} (enable it: profile mechanisms.stock or ATTAX_S2_STOCK_POTENTIAL=1)",
    );
  } else if (
    stock.scale !== DEFAULT_STOCK_PARAMS.scale ||
    stock.betaB !== DEFAULT_STOCK_PARAMS.betaB ||
    stock.betaR !== DEFAULT_STOCK_PARAMS.betaR
  ) {
    problems.push(
      `stock Φ is {scale ${stock.scale}, betaB ${stock.betaB}, betaR ${stock.betaR}} — ` +
        `config O requires {scale 1, betaB 0.5, betaR 0.5}`,
    );
  }
  if (solvency !== undefined) {
    problems.push("solvency is ON — the GPU engine has no solvency mechanism");
  }
  if (rootVeto) {
    problems.push("root veto is ON (solvency hard mode) — the GPU engine has no root veto");
  }
  if (diverse) problems.push("diverse roots are ON — the GPU engine has no diverse mode");
  if (garbageScenarios !== undefined) {
    problems.push("garbage scenarios are set — the GPU engine takes the referee's due rows only");
  }
  if (width !== 96) problems.push(`beam width is ${width} — the GPU engine is fixed at 96`);
  if (problems.length > 0) {
    throw new Error(
      `GPU engine implements exactly config O and nothing else; this lab ` +
        `configuration diverges:\n- ${problems.join("\n- ")}\n` +
        `Align the profile/env to config O, or run the archived reference ` +
        `engine for this configuration — the GPU driver will not silently ` +
        `approximate it.`,
    );
  }
  return { weights };
}

/**
 * The GPU decider factory (basic form: vkrunner_s26 serve), refusing
 * every lab configuration that does not resolve to config O.
 */
export async function createGpuAttaxDecider(profilePath?: string): Promise<GpuDecider> {
  const { weights } = await resolveConfigO(profilePath);

  const decideAsync = async (
    input: SearchInput,
    options: DeciderOptions,
  ): Promise<SearchResult | null> => {
    if (options.lineStates) {
      throw new Error(
        "GPU decider cannot produce lineStates: the wire format carries no " +
          "per-step states. Drop the lineStates request for GPU decisions.",
      );
    }
    const record = encodeDecisionRecordBytes(input);
    const block = await getServer().request(record);
    // Decision path (H1, latency floor audit 2026-11-24): only the head,
    // the candidates, ply 0 and the trailer are consumed here, so the
    // light parse materializes nothing deeper. The gate keeps the full
    // parse (decodeServeBlock in gpu-gate.ts).
    const parsed: ParsedBlock = parseServeBlockLight(block);
    gpuTimingSamples.push(parsed.wallMs);
    if (parsed.status === 1 || !parsed.best) return null;
    const best = parsed.best;
    if (!input.acceptRoot || input.acceptRoot(best.placement, best.usedHold)) {
      return resultForRootStep(parsed, best.placement, best.usedHold, best.valueBits, weights);
    }
    for (const cand of parsed.candidates) {
      if (input.acceptRoot(cand.placement, cand.usedHold)) {
        return resultForRootStep(parsed, cand.placement, cand.usedHold, cand.valueBits, weights);
      }
    }
    return null;
  };

  return {
    decide: () => {
      throw new Error("GPU decider is async-only (the engine is a serve process); use decideAsync");
    },
    decideAsync,
    close: () => closeGpuEngine(),
  };
}

/** Convenience: a config-O-validated GPU decider as the lab's default. */
export async function createDefaultGpuDecider(): Promise<GpuDecider> {
  return createGpuAttaxDecider();
}

/**
 * The persistent-form decider factory (latency floor audit 2026-11-24,
 * candidate P1): drives persistent/pfserve — the r15 serve engine the
 * TBP adapter already defaults to — under the SAME config-O resolution
 * and refusal as the basic form (resolveConfigO). The persistent host
 * implements config O as its s2 profile; the driver pins
 * ATTAX_GPU_PROFILE=s2 (PERSISTENT_ENV) and requires the host's profile
 * banner before the first decision resolves.
 *
 * Results are built from pfserve's compact block by
 * resultForCompactBlock: the selection, candidates, value, nodes and
 * depth are the engine's own; attack / reward / breakdown are absent
 * (NaN / empty) because the compact block does not carry them — see
 * gpu-codec.ts. The verification contract is selection agreement with
 * the basic form, not full-record identity.
 */
export async function createPersistentGpuAttaxDecider(profilePath?: string): Promise<GpuDecider> {
  // Validation only: the compact result builder needs no weights (the
  // block carries no feature breakdown to weight).
  await resolveConfigO(profilePath);

  const decideAsync = async (
    input: SearchInput,
    options: DeciderOptions,
  ): Promise<SearchResult | null> => {
    if (options.lineStates) {
      throw new Error(
        "persistent GPU decider cannot produce lineStates: the compact serve " +
          "block carries no per-step states. Drop the lineStates request for " +
          "GPU decisions.",
      );
    }
    const record = encodeDecisionRecordBytes(input);
    const block = await getPersistentServer().request(record);
    const parsed: ParsedBlock = parseServeBlock(block);
    gpuTimingSamples.push(parsed.wallMs);
    if (parsed.status === 1 || !parsed.best) return null;
    const best = parsed.best;
    if (!input.acceptRoot || input.acceptRoot(best.placement, best.usedHold)) {
      return resultForCompactBlock(parsed, input, best.placement, best.usedHold, best.valueBits);
    }
    for (const cand of parsed.candidates) {
      if (input.acceptRoot(cand.placement, cand.usedHold)) {
        return resultForCompactBlock(parsed, input, cand.placement, cand.usedHold, cand.valueBits);
      }
    }
    return null;
  };

  return {
    decide: () => {
      throw new Error(
        "persistent GPU decider is async-only (the engine is a serve process); use decideAsync",
      );
    },
    decideAsync,
    close: () => closePersistentGpuEngine(),
  };
}

/** Convenience: a config-O-validated persistent-form decider. */
export async function createDefaultPersistentGpuDecider(): Promise<GpuDecider> {
  return createPersistentGpuAttaxDecider();
}
