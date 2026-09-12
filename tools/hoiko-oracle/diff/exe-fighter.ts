// allow: SIZE_OK — one cohesive exe-stub adapter: state carry, input
// marshalling, decision parsing and turn comparison share the same state type.
/**
 * Exe-backed `VersusFighter`: one Wine query per think against the shipping
 * binary stub, plus a same-snapshot replay query of the Rust/WASM replica.
 *
 * The wrapper carries the OffsetOffAI state exactly like `RustHoikoEngine`:
 * the previous query's `OFFSET post` line is written back into the next input
 * (`useoffset`/`ofs*`/`gb*`/`haslast*`), and the virtual frame clock advances by
 * the same `frameStepMs` as the replica. Every think therefore runs one state
 * step on both engines, which is what makes the offset state machine comparable.
 */

import {
  frameStepMs,
  lockActionCode,
  makePlaceAtMove,
  type RustHoikoFighter,
  type RustOut,
} from "../../../src/ai/hoiko-rust-core.js";
import { kindToMino, MINO_NONE } from "../../../src/ai/mino-codes.js";
import type { AiMove, GameSnapshot } from "../../../src/ui/types.js";
import { ROWS } from "../../../src/ui/types.js";
import type { VersusFighter } from "../../../src/versus/controller.js";
import { type ExeOffsetState, exeHoldUsed, nativeRowsOf, parseExe, runExe } from "./exe.js";

const FRAMES_PER_THINK = 20;

interface ExeFighterState {
  useOffsetOff: number;
  ofsCanWait: number;
  ofsCenter4: number;
  ofsAtk: number;
  ofsPcChance: number;
  ofsNearOffset: number;
  gbOpponentsAtk: number;
  gbCoolTime: number;
  gbRemainingTime: number;
  gbOpponentsLockCount: number;
  gbFirstInvalidLock: number;
  hasLastOwn: number;
  lastOwnId: number;
  hasLastOpp: number;
  lastOppId: number;
  weightIndex: number;
  frameMs: number;
}

function initialExeState(): ExeFighterState {
  return {
    useOffsetOff: 1,
    ofsCanWait: 0,
    ofsCenter4: 0,
    ofsAtk: 0,
    ofsPcChance: 0,
    ofsNearOffset: 0,
    gbOpponentsAtk: 0,
    gbCoolTime: 0,
    gbRemainingTime: 0,
    gbOpponentsLockCount: 0,
    gbFirstInvalidLock: 0,
    hasLastOwn: 0,
    lastOwnId: 0,
    hasLastOpp: 0,
    lastOppId: 0,
    weightIndex: 0,
    frameMs: 0,
  };
}

export interface SnapshotSummary {
  readonly board: readonly number[];
  readonly current: number;
  readonly queue: readonly number[];
  readonly hold: number;
  readonly combo: number;
  readonly btb: number;
  readonly lockId: number;
  readonly lastAction: string;
  readonly lastAttack: number;
  readonly pendingGarbage: number;
  readonly opponentLockId: number | null;
  readonly opponentLastClearLines: number | null;
  readonly opponentLastNativeBtb: number | null;
  readonly opponentLastNativeCombo: number | null;
}

export interface ExeDecision {
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
  readonly useHold: boolean;
  readonly garbageWait: boolean;
  readonly planActs: readonly number[];
  readonly offset: ExeOffsetState | null;
  readonly weightIndex: number;
}

export interface TurnMatch {
  readonly move: boolean;
  readonly act: boolean;
  readonly garbageWait: boolean;
  readonly useHold: boolean;
  readonly weightIndex: boolean;
  readonly offsetDiffs: readonly string[];
  readonly all: boolean;
}

export interface ExeTurn {
  readonly index: number;
  readonly snapshot: SnapshotSummary;
  readonly exeInput: string;
  readonly exe: ExeDecision | null;
  readonly replica: RustOut | null;
  readonly match: TurnMatch;
  readonly exeRaw: string | null;
  readonly wallMs: number;
}

export function summarizeSnapshot(s: GameSnapshot): SnapshotSummary {
  const board = nativeRowsOf(s);
  while (board.length < 32) board.push(0);
  const queue = [s.active === null ? MINO_NONE : kindToMino(s.active.kind)];
  for (const kind of s.next) queue.push(kindToMino(kind));
  // The stub wraps short `next=` lists; pad to 28 with NONE exactly like the
  // replica's `build_root` so both engines see the same queue tail.
  while (queue.length < 28) queue.push(MINO_NONE);
  return {
    board,
    current: s.active === null ? MINO_NONE : kindToMino(s.active.kind),
    queue: queue.slice(0, 28),
    hold: s.hold === null ? MINO_NONE : kindToMino(s.hold),
    combo: s.nativeCombo,
    btb: s.nativeBtb,
    lockId: s.lockId,
    lastAction: s.lastAction,
    lastAttack: s.lastAttack,
    pendingGarbage: s.pendingGarbage,
    opponentLockId: s.opponentLockId ?? null,
    opponentLastClearLines: s.opponentLastClearLines ?? null,
    opponentLastNativeBtb: s.opponentLastNativeBtb ?? null,
    opponentLastNativeCombo: s.opponentLastNativeCombo ?? null,
  };
}

function exeInputFor(s: GameSnapshot, state: ExeFighterState, isEvenBoard: boolean): string {
  const summary = summarizeSnapshot(s);
  const nowMs = Math.trunc(state.frameMs);
  return [
    `# exe-fighter lockId=${s.lockId} pending=${s.pendingGarbage} nowMs=${nowMs}`,
    `board=${summary.board.map((v) => `0x${(v >>> 0).toString(16)}`).join(",")}`,
    `next=${summary.queue.join(",")}`,
    `hold=${summary.hold}`,
    `combo=${summary.combo}`,
    `b2b=${summary.btb}`,
    "timer=1",
    `usehold=${s.canHold ? 1 : 0}`,
    `garbage=${s.pendingGarbage}`,
    `nowms=${nowMs}`,
    `iseven=${isEvenBoard ? 1 : 0}`,
    "sync=1",
    "offsetenabled=1",
    `useoffset=${state.useOffsetOff}`,
    `ofscanwait=${state.ofsCanWait}`,
    `ofscenter4=${state.ofsCenter4}`,
    `ofsatk=${state.ofsAtk}`,
    `ofspcchance=${state.ofsPcChance}`,
    `ofsnearoffset=${state.ofsNearOffset}`,
    `gboppatk=${state.gbOpponentsAtk}`,
    `gbcool=${state.gbCoolTime}`,
    `gbremaining=${state.gbRemainingTime}`,
    `gblockcount=${state.gbOpponentsLockCount}`,
    `gbfirstinvalid=${state.gbFirstInvalidLock}`,
    `haslastown=${state.hasLastOwn}`,
    `lastownid=${state.lastOwnId}`,
    `haslastopp=${state.hasLastOpp}`,
    `lastoppid=${state.lastOppId}`,
    `weightindex=${state.weightIndex}`,
    `lockid=${s.lockId}`,
    `lastaction=${lockActionCode(s.lastAction)}`,
    `lastattack=${s.lastAttack}`,
    `opplock=${s.opponentLockId === undefined ? 0 : 1}`,
    `opplockid=${s.opponentLockId ?? 0}`,
    `oppclear=${s.opponentLastClearLines ?? 0}`,
    `oppbtb=${s.opponentLastNativeBtb ?? 0}`,
    `opplastcombo=${s.opponentLastNativeCombo ?? 0}`,
    "",
  ].join("\n");
}

function applyExeState(state: ExeFighterState, offset: ExeOffsetState): void {
  state.useOffsetOff = offset.use;
  state.ofsCanWait = offset.canWait;
  state.ofsCenter4 = offset.center4;
  state.ofsAtk = offset.atk;
  state.ofsPcChance = offset.pc;
  state.ofsNearOffset = offset.near;
  state.gbOpponentsAtk = offset.gbAtk;
  state.gbCoolTime = offset.gbCool;
  state.gbRemainingTime = offset.gbRem;
  state.gbOpponentsLockCount = offset.gbLock;
  state.gbFirstInvalidLock = offset.gbFirst;
  state.hasLastOwn = offset.hasOwn;
  state.lastOwnId = offset.ownId;
  state.hasLastOpp = offset.hasOpp;
  state.lastOppId = offset.oppId;
}

function offsetDiffs(exe: ExeOffsetState, out: RustOut): string[] {
  const diffs: string[] = [];
  const cmp = (name: string, exeValue: number, rustValue: number): void => {
    if (exeValue !== rustValue) diffs.push(`${name}: exe=${exeValue} rust=${rustValue}`);
  };
  cmp("useOffsetOff", exe.use, out.useOffsetOff);
  cmp("ofsCanWait", exe.canWait, out.ofsCanWait);
  cmp("ofsCenter4", exe.center4, out.ofsCenter4);
  cmp("ofsAtk", exe.atk, out.ofsAtk);
  cmp("ofsPcChance", exe.pc, out.ofsPcChance);
  cmp("ofsNearOffset", exe.near, out.ofsNearOffset);
  cmp("gbOpponentsAtk", exe.gbAtk, out.gbOpponentsAtk);
  cmp("gbCoolTime", exe.gbCool, out.gbCoolTime);
  cmp("gbRemainingTime", exe.gbRem, out.gbRemainingTime);
  cmp("gbOpponentsLockCount", exe.gbLock, out.gbOpponentsLockCount);
  cmp("gbFirstInvalidLock", exe.gbFirst, out.gbFirstInvalidLock);
  cmp("hasLastOwnLock", exe.hasOwn, out.hasLastOwnLock);
  cmp("lastOwnLockId", exe.ownId, out.lastOwnLockId);
  cmp("hasLastOppLock", exe.hasOpp, out.hasLastOppLock);
  cmp("lastOppLockId", exe.oppId, out.lastOppLockId);
  return diffs;
}

export function createExeFighter(
  replica: RustHoikoFighter,
  onTurn: (turn: ExeTurn) => void,
): VersusFighter {
  const state = initialExeState();
  let index = 0;
  return {
    name: "HOIKO-EXE",
    color: "#e94fb0",
    findBestMove(s: GameSnapshot): AiMove | null {
      if (s.active === null || s.gameOver) return null;
      const replicaRes = replica.searchSnapshot(s);
      const input = exeInputFor(s, state, replica.engine.isEvenBoard);
      const run = runExe(input);
      const exe = run.ok ? parseExe(run.text, run.wallMs) : null;
      const currentIndex = index;
      index += 1;
      if (exe === null || exe.offset === null || exe.garbageWait === null) {
        onTurn({
          index: currentIndex,
          snapshot: summarizeSnapshot(s),
          exeInput: input,
          exe: null,
          replica: replicaRes?.out ?? null,
          match: {
            move: false,
            act: false,
            garbageWait: false,
            useHold: false,
            weightIndex: false,
            offsetDiffs: ["exe query or offset parse failed"],
            all: false,
          },
          exeRaw: run.text,
          wallMs: run.wallMs,
        });
        return null;
      }
      const holdUsed = exeHoldUsed(s, exe);
      const rot = ((exe.rot % 4) + 4) % 4;
      const decision: ExeDecision = {
        x: exe.x,
        y: exe.y,
        rot,
        m: exe.m,
        srs: exe.srs,
        act: exe.act,
        moveDelay: exe.moveDelay,
        getDelay: exe.getDelay,
        depth: exe.depth,
        beam: exe.beam,
        useHold: holdUsed,
        garbageWait: exe.garbageWait === 1,
        planActs: exe.planActs,
        offset: exe.offset,
        weightIndex: exe.weightIndex ?? state.weightIndex,
      };
      applyExeState(state, exe.offset);
      state.weightIndex = decision.weightIndex;
      state.frameMs += frameStepMs(FRAMES_PER_THINK);
      const out = replicaRes?.out ?? null;
      const move =
        out !== null &&
        exe.x === out.x &&
        rot === ((out.firstRRaw % 4) + 4) % 4 &&
        exe.m === out.firstM;
      const act = out !== null && exe.act === out.firstAct;
      const garbageWait = out !== null && (exe.garbageWait === 1) === (out.garbageWait === 1);
      const useHold = out !== null && holdUsed === (out.useHold === 1);
      const weightIndex = out !== null && decision.weightIndex === out.weightIndex;
      const diffs = out === null ? ["replica query returned null"] : offsetDiffs(exe.offset, out);
      const all = move && act && garbageWait && useHold && weightIndex && diffs.length === 0;
      onTurn({
        index: currentIndex,
        snapshot: summarizeSnapshot(s),
        exeInput: input,
        exe: decision,
        replica: out,
        match: {
          move,
          act,
          garbageWait,
          useHold,
          weightIndex,
          offsetDiffs: diffs,
          all,
        },
        exeRaw: all ? null : run.text,
        wallMs: run.wallMs,
      });
      if (holdUsed) {
        return {
          targetX: exe.x,
          targetRotation: rot,
          useHold: true,
          garbageWait: decision.garbageWait,
        };
      }
      const base = makePlaceAtMove(s, exe.x, rot, ROWS - 1 - exe.y, exe.srs);
      return base === null ? null : { ...base, garbageWait: decision.garbageWait };
    },
  };
}
