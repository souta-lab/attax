/**
 * Per-fighter OffsetOffAI driver — the binary's PPT2AI opponent-observation
 * flow (`ObserveOpponent` / `ObserveOpponentClear`, IL 3161-3279, 4656-4777) plus
 * the input-wait lambda (IL 2860). It owns the mutable `OffsetOffAI` state and
 * the lock-change bookkeeping, keeping the versus adapter a pure snapshot->move
 * mapper.
 *
 * Frame clock: the binary uses `Memory.GetMatchFrames()` (game frames at ~60/s).
 * The app has no frame counter, so `nowMs * 0.06` maps wall-clock ms to game
 * frames (16.67 ms/frame).
 */

import type { GameSnapshot, LockAction } from "../ui/types.js";
import type { Board } from "./native/board.js";
import type { NextMino } from "./native/nextmino.js";
import { OffsetOffAI } from "./native/offset.js";
import {
  ACT_DOUBLE,
  ACT_NONE,
  ACT_PC,
  ACT_QUAD,
  ACT_SINGLE,
  ACT_TRIPLE,
  ACT_TSD,
  ACT_TSM,
  ACT_TSS,
  ACT_TST,
  type ClearAct,
  type MinoType,
} from "./native/shapes.js";

const GAME_FRAMES_PER_MS = 0.06;

function actFromLockAction(action: LockAction): ClearAct {
  switch (action) {
    case "None":
      return ACT_NONE;
    case "Single":
      return ACT_SINGLE;
    case "Double":
      return ACT_DOUBLE;
    case "Triple":
      return ACT_TRIPLE;
    case "Quad":
      return ACT_QUAD;
    case "Tss":
      return ACT_TSS;
    case "Tsd":
      return ACT_TSD;
    case "Tst":
      return ACT_TST;
    case "Tsm":
      return ACT_TSM;
    case "Pc":
      return ACT_PC;
  }
}

export interface OffsetDecisionInput {
  readonly planActs: readonly ClearAct[];
  readonly depth: number;
  readonly hold: MinoType;
  readonly next: NextMino | null;
  readonly btb: number;
  readonly isEvenBoard: boolean;
  readonly board: Board;
  readonly pendingGarbage: number;
}

export class HoikoOffsetDriver {
  private readonly offset: OffsetOffAI;
  private readonly enabled: boolean;
  private lastOwnLockId: number | null = null;
  private lastOpponentLockId: number | null = null;

  constructor(useOffsetOff: boolean) {
    this.enabled = useOffsetOff;
    this.offset = new OffsetOffAI(useOffsetOff);
  }

  /** Apply own/opponent lock-change events observed on this snapshot. */
  sync(s: GameSnapshot, nowMs: number): void {
    const frame = Math.trunc(nowMs * GAME_FRAMES_PER_MS);
    if (this.lastOwnLockId !== null && s.lockId < this.lastOwnLockId) {
      this.offset.setUseOffsetOff(this.enabled);
      this.lastOwnLockId = null;
      this.lastOpponentLockId = null;
    }
    if (this.lastOwnLockId !== null && s.lockId !== this.lastOwnLockId) {
      this.offset.setPrevAct(actFromLockAction(s.lastAction));
      this.offset.lockOffsetAfterClearing(frame, s.lastAttack, s.lockId);
    }
    this.lastOwnLockId = s.lockId;

    const opponentLockId = s.opponentLockId;
    if (opponentLockId !== undefined && opponentLockId !== this.lastOpponentLockId) {
      if (this.offset.opponentIsNewLockDown(opponentLockId)) this.offset.resetOpponentsAtk();
      const lines = s.opponentLastClearLines ?? 0;
      if (lines > 0 && this.offset.getOpponentsAtk() === 0) {
        if (!this.offset.isFirstInvalidLockDown()) {
          if (!this.offset.isLocked(frame)) {
            const opponentBtb = s.opponentLastNativeBtb ?? 0;
            this.offset.calcOpponentsAtk(
              lines,
              opponentBtb > 0 ? 1 : 0,
              opponentBtb > 1 ? 1 : 0,
              s.opponentLastNativeCombo ?? 0,
            );
          }
        } else {
          this.offset.invalidateGettingEnemysAtk();
        }
      }
      this.lastOpponentLockId = opponentLockId;
    }
  }

  /**
   * Run DecisionOffsetOff over the chosen line and answer the driver's
   * `CanOffsetOff(pendingGarbage)` wait gate.
   */
  decide(input: OffsetDecisionInput, nowMs: number): boolean {
    if (!this.enabled) return false;
    const columnHeights = new Int32Array(10);
    input.board.getColumnHeight(columnHeights);
    if (input.next !== null) {
      this.offset.computeDecision(
        input.planActs,
        input.depth,
        input.hold,
        input.next,
        input.btb,
        input.isEvenBoard,
        columnHeights,
      );
    }
    return (
      !this.offset.isLocked(Math.trunc(nowMs * GAME_FRAMES_PER_MS)) &&
      this.offset.canOffsetOff(input.pendingGarbage, input.isEvenBoard)
    );
  }
}
