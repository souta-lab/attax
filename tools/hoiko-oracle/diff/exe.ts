/**
 * Shared Wine-oracle query helpers for the hoiko differential harnesses.
 *
 * One fresh `Hoiko.exe` process per query (design A). Each query writes
 * `oracle_input.txt` and runs `run_oracle.sh`; the stub's stdout is captured to a
 * file so Bun's spawnSync returns as soon as bash exits (wine grandchildren
 * otherwise hold inherited pipes alive for seconds).
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { kindToMino, MINO_NONE } from "../../../src/ai/hoiko/mino-codes.js";
import type { GameSnapshot } from "../../../src/core/types.js";

export const ORACLE_ROOT = Bun.env.HOIKO_ORACLE_ROOT ?? "/tmp/opencode/oracle";
export const ORACLE_RUN = Bun.env.HOIKO_ORACLE_RUN ?? `${ORACLE_ROOT}/run`;
export const ORACLE_PREFIX = Bun.env.HOIKO_ORACLE_PREFIX ?? `${ORACLE_ROOT}/prefix`;
export const ORACLE_SCRIPT = new URL("../run_oracle.sh", import.meta.url).pathname;

const CLEAR_DELAY: Readonly<Record<number, number>> = {
  0: 0,
  1: 36,
  5: 36,
  8: 36,
  2: 41,
  3: 41,
  6: 41,
  7: 41,
  4: 46,
  9: 1,
};

export function rGetDelay(moveDelay: number, act: number): number {
  return (CLEAR_DELAY[act] ?? 0) * 16 + moveDelay;
}

export function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(Bun.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.HOIKO_ORACLE_ROOT = ORACLE_ROOT;
  env.HOIKO_ORACLE_RUN = ORACLE_RUN;
  env.HOIKO_ORACLE_PREFIX = ORACLE_PREFIX;
  return env;
}

export function runExe(input: string): {
  readonly ok: boolean;
  readonly text: string;
  readonly wallMs: number;
} {
  writeFileSync(`${ORACLE_RUN}/oracle_input.txt`, input);
  const logPath = `${ORACLE_RUN}/oracle_stdout.log`;
  rmSync(logPath, { force: true });
  const t0 = performance.now();
  const proc = Bun.spawnSync(["bash", "-c", `bash '${ORACLE_SCRIPT}' > '${logPath}' 2>&1`], {
    stdout: "ignore",
    stderr: "ignore",
    timeout: 180000,
    env: childEnv(),
  });
  const wallMs = performance.now() - t0;
  const text = readFileSync(logPath, "utf8");
  return { ok: proc.exitCode === 0 && text.includes("ORACLE_OK"), text, wallMs };
}

export function matchInt(text: string, re: RegExp): number | null {
  const m = text.match(re);
  if (m === null) return null;
  const parsed = Number.parseInt(m[1] ?? "", 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/** OffsetOffAI state written back by the stub's `OFFSET post` line. */
export interface ExeOffsetState {
  readonly use: number;
  readonly canWait: number;
  readonly center4: number;
  readonly atk: number;
  readonly pc: number;
  readonly near: number;
  readonly gbAtk: number;
  readonly gbCool: number;
  readonly gbRem: number;
  readonly gbLock: number;
  readonly gbFirst: number;
  readonly hasOwn: number;
  readonly ownId: number;
  readonly hasOpp: number;
  readonly oppId: number;
}

export interface ExeResult {
  readonly ok: boolean;
  readonly x: number;
  readonly y: number;
  readonly rot: number;
  readonly m: number;
  readonly srs: number;
  readonly act: number;
  readonly moveDelay: number;
  readonly getDelay: number;
  readonly depth: number;
  readonly beam: number;
  readonly postHold: number;
  readonly postCombo: number;
  readonly postBtb: number;
  readonly postAct: number;
  readonly postFallM: number;
  readonly postBoard: readonly number[];
  readonly wallMs: number;
  /** Present in offset mode (`offsetenabled=`). */
  readonly garbageWait: number | null;
  readonly offset: ExeOffsetState | null;
  readonly planActs: readonly number[];
  /** Present in carried-state mode (`weightindex=`). */
  readonly weightIndex: number | null;
}

export function parseBoardRows(hex: string): number[] {
  const bytes = hex
    .trim()
    .split(/\s+/)
    .map((b) => Number.parseInt(b, 16));
  const rows: number[] = [];
  for (let i = 0; i + 3 < bytes.length; i += 4) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const b3 = bytes[i + 3] ?? 0;
    rows.push(b0 | (b1 << 8) | (b2 << 16) | (b3 << 24) | 0);
  }
  return rows;
}

function parseIntAt(m: RegExpMatchArray, index: number): number {
  return Number.parseInt(m[index] ?? "0", 10);
}

export function parseExe(text: string, wallMs: number): ExeResult | null {
  const move = text.match(/firstMove @\+?456:\s*x=(-?\d+)\s+y=(-?\d+)\s+rot=(-?\d+)\s+m=(-?\d+)/);
  const post = text.match(
    /postmove: hold=(-?\d+) combo=(-?\d+) btb=(-?\d+) act=(-?\d+) moveDelay=(-?\d+) fallX=(-?\d+) fallY=(-?\d+) fallRot=(-?\d+) fallM=(-?\d+)/,
  );
  const boardHex = text.match(/final board\s+@216\.\.344:\s*((?:[0-9a-f]{2}\s*)+)/);
  if (move === null || post === null || boardHex === null) return null;
  const x = parseIntAt(move, 1);
  const y = parseIntAt(move, 2);
  const rot = parseIntAt(move, 3);
  const m = parseIntAt(move, 4);
  if ([x, y, rot, m].some((v) => Number.isNaN(v))) return null;

  const offsetMatch = text.match(
    /OFFSET post use=(-?\d+) canWait=(-?\d+) center4=(-?\d+) atk=(-?\d+) pc=(-?\d+) near=(-?\d+) gbAtk=(-?\d+) gbCool=(-?\d+) gbRem=(-?\d+) gbLock=(-?\d+) gbFirst=(-?\d+) hasOwn=(-?\d+) ownId=(-?\d+) hasOpp=(-?\d+) oppId=(-?\d+)/,
  );
  const planMatch = text.match(/planacts=(-?\d+),(-?\d+),(-?\d+)/);
  return {
    ok: true,
    x,
    y,
    rot,
    m,
    srs: matchInt(text, /firstMoveSrs @\+?472\s*=\s*(-?\d+)/) ?? 0,
    act: matchInt(text, /act\s+@\+?416\s*=\s*(-?\d+)/) ?? -1,
    moveDelay: matchInt(text, /moveDelay @\+?400\s*=\s*(-?\d+)/) ?? -1,
    getDelay: matchInt(text, /GetDelay\s*=\s*(-?\d+)/) ?? -1,
    depth: matchInt(text, /depth\s+@\+?444\s*=\s*(-?\d+)/) ?? -1,
    beam: matchInt(text, /beamLimit\s+@\+?452\s*=\s*(-?\d+)/) ?? -1,
    postHold: parseIntAt(post, 1),
    postCombo: parseIntAt(post, 2),
    postBtb: parseIntAt(post, 3),
    postAct: parseIntAt(post, 4),
    postFallM: parseIntAt(post, 9),
    postBoard: parseBoardRows(boardHex[1] ?? ""),
    wallMs,
    garbageWait: matchInt(text, /garbageWait=(-?\d+)/),
    offset:
      offsetMatch === null
        ? null
        : {
            use: parseIntAt(offsetMatch, 1),
            canWait: parseIntAt(offsetMatch, 2),
            center4: parseIntAt(offsetMatch, 3),
            atk: parseIntAt(offsetMatch, 4),
            pc: parseIntAt(offsetMatch, 5),
            near: parseIntAt(offsetMatch, 6),
            gbAtk: parseIntAt(offsetMatch, 7),
            gbCool: parseIntAt(offsetMatch, 8),
            gbRem: parseIntAt(offsetMatch, 9),
            gbLock: parseIntAt(offsetMatch, 10),
            gbFirst: parseIntAt(offsetMatch, 11),
            hasOwn: parseIntAt(offsetMatch, 12),
            ownId: parseIntAt(offsetMatch, 13),
            hasOpp: parseIntAt(offsetMatch, 14),
            oppId: parseIntAt(offsetMatch, 15),
          },
    planActs:
      planMatch === null
        ? []
        : [parseIntAt(planMatch, 1), parseIntAt(planMatch, 2), parseIntAt(planMatch, 3)],
    weightIndex: matchInt(text, /weightIndex=(-?\d+)/),
  };
}

export function nativeRowsOf(snap: GameSnapshot): number[] {
  const rows: number[] = [];
  for (let y = 0; y < snap.board.rows; y += 1) {
    const src = snap.board.grid[snap.board.rows - 1 - y];
    let bits = 0;
    for (let x = 0; x < 10; x += 1) {
      if ((src?.[x] ?? 0) !== 0) bits |= 1 << (9 - x);
    }
    rows.push(bits);
  }
  return rows;
}

export function rowsEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

export function exeHoldUsed(snap: GameSnapshot, exe: ExeResult): boolean {
  const preHoldMino = snap.hold === null ? MINO_NONE : kindToMino(snap.hold);
  const currentMino = snap.active === null ? MINO_NONE : kindToMino(snap.active.kind);
  return exe.postHold !== preHoldMino || exe.m !== currentMino;
}
