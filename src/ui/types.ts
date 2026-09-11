/** Shared view-model types for the Canvas UI shell. UI never implements rules. */

export const COLS = 10;
export const ROWS = 20;

export type CellValue = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type LockAction =
  | "None"
  | "Single"
  | "Double"
  | "Triple"
  | "Quad"
  | "Tss"
  | "Tsd"
  | "Tst"
  | "Tsm"
  | "Pc";

export type PieceKind = "I" | "O" | "T" | "S" | "Z" | "J" | "L";

export interface CellPos {
  readonly x: number;
  readonly y: number;
}

export interface ActivePieceView {
  readonly kind: PieceKind;
  readonly rotation: number;
  readonly cells: readonly CellPos[];
  readonly posX: number;
  readonly posY: number;
}

export interface BoardView {
  readonly cols: number;
  readonly rows: number;
  readonly grid: readonly (readonly CellValue[])[];
}

export interface GameSnapshot {
  readonly board: BoardView;
  readonly active: ActivePieceView | null;
  readonly ghostY: number | null;
  readonly hold: PieceKind | null;
  readonly canHold: boolean;
  readonly next: readonly PieceKind[];
  readonly score: number;
  readonly lines: number;
  readonly level: number;
  readonly gameOver: boolean;
  readonly combo: number;
  readonly b2b: boolean;
  readonly nativeCombo: number;
  readonly nativeBtb: number;
  readonly lockId: number;
  readonly lastAction: LockAction;
  readonly lastRawAttack: number;
  readonly pendingGarbage: number;
  readonly opponentCombo?: number;
  readonly opponentBtb?: number;
  readonly opponentLockId?: number;
  readonly opponentLastClearLines?: number;
  readonly opponentLastNativeCombo?: number;
  readonly opponentLastNativeBtb?: number;
  readonly opponentLastRawAttack?: number;
  readonly lastAttack: number;
  readonly lastBlocked: number;
}

export interface LockTransition {
  readonly boardAfterLockClear: readonly number[];
  readonly linesCleared: number;
  readonly garbageRowsApplied: number;
  readonly action: LockAction;
  readonly nativeCombo: number;
  readonly nativeBtb: number;
  readonly rawAttack: number;
  readonly sentAttack: number;
  readonly lockId: number;
}

export type AiExecutionStep =
  | { readonly kind: "hold" }
  | { readonly kind: "rotateCW" }
  | { readonly kind: "rotateCCW" }
  | { readonly kind: "left" }
  | { readonly kind: "right" }
  | { readonly kind: "softDrop" }
  | { readonly kind: "drop" }
  | {
      readonly kind: "placeAt";
      readonly rotation: number;
      readonly x: number;
      readonly topRow?: number;
      readonly lastSrs?: number;
    };

export interface AiExecutionPlan {
  readonly targetX: number;
  readonly targetRotation: number;
  readonly steps: readonly AiExecutionStep[];
  readonly expectedBoard: readonly number[];
  readonly expectedLinesCleared: number;
  readonly sourceActiveKind: PieceKind;
  readonly sourceRotation: number;
  readonly sourceX: number;
  readonly sourceBoardFingerprint: string;
  readonly sourceHold: PieceKind | null;
  readonly sourceCanHold: boolean;
}

export interface AiMove {
  readonly targetX: number;
  readonly targetRotation: number;
  readonly useHold: boolean;
  readonly garbageWait?: boolean;
  readonly execution?: AiExecutionPlan;
}

export interface AiDebug {
  readonly score: number;
  readonly fireScore: number;
  readonly linesCleared: number;
  readonly isTspin: boolean;
  readonly opener: string | null;
  readonly topHoles: number;
  readonly topMaxHeight: number;
  readonly thinkMs: number;
}

export interface AiPort {
  readonly name: string;
  findBestMove(snapshot: GameSnapshot): AiMove | null;
  getDebug?(): AiDebug | null;
}

/** Minimal core contract. Real core/ai must adapt to this; UI never calls rules directly. */
export interface CorePort {
  getSnapshot(): GameSnapshot;
  getLastLockTransition(): LockTransition | null;
  moveLeft(): void;
  moveRight(): void;
  softDrop(): void;
  rotateCW(): void;
  rotateCCW(): void;
  hardDrop(): void;
  hold(): void;
  /**
   * Teleport active piece to (rotation, x) if reachable, then hard-drop.
   * Returns false when the placement is invalid (caller falls back to stepwise replay).
   */
  hardDropAt?(rotation: number, x: number): boolean;
  /** Lock the piece at exact grid (rotation, x, topRow); lastSrs feeds T-spin detection. */
  placeMinoAt?(rotation: number, x: number, topRow: number, lastSrs: number): boolean;
  /** Advance gravity by one row tick. Returns true when the active piece locked/spawned. */
  gravityTick(): boolean;
  /** Outgoing garbage rows waiting to be delivered to the opponent. Drains the outbox. */
  drainOutbox?(): number;
  /** Deliver incoming garbage rows (already cancelled). Spawns after current lock flow. */
  receiveGarbage?(rows: number): void;
  setGarbageWait?(wait: boolean): void;
  reset(): void;
}

export function pieceToCell(kind: PieceKind): CellValue {
  switch (kind) {
    case "I":
      return 1;
    case "O":
      return 2;
    case "T":
      return 3;
    case "S":
      return 4;
    case "Z":
      return 5;
    case "J":
      return 6;
    case "L":
      return 7;
  }
}
