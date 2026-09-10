import { createAi } from "../ai/search.js";
import { createEngine } from "../core/engine.js";
import type { RendererHandle } from "./renderer.js";
import type { AiMove, AiPort, CorePort, GameSnapshot, PlayMode } from "./types.js";

export interface AppOptions {
  readonly core: CorePort;
  readonly renderer: RendererHandle;
  readonly ai?: AiPort | null;
  readonly mode?: PlayMode;
  readonly aiInstant?: boolean;
  readonly aiStepIntervalMs?: number;
  readonly onStats?: (snapshot: GameSnapshot) => void;
}

export interface AppHandle {
  setMode(mode: PlayMode): void;
  getMode(): PlayMode;
  setAiInstant(instant: boolean): void;
  isAiInstant(): boolean;
  setStepIntervalMs(ms: number): void;
  getStepIntervalMs(): number;
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  stepOnce(): void;
  setAi(ai: AiPort | null): void;
  getAiName(): string;
  reset(): void;
  destroy(): void;
}

type AiStep =
  | { readonly kind: "hold" }
  | { readonly kind: "rotateCW" }
  | { readonly kind: "rotateCCW" }
  | { readonly kind: "left" }
  | { readonly kind: "right" }
  | { readonly kind: "drop" };

function gravityIntervalMs(level: number, mode: PlayMode): number {
  if (mode === "spectate") return 35;
  if (mode === "ai") return 120;
  return Math.max(800 - (level - 1) * 70, 80);
}

/** Expand a best-move into single-step replay actions (no rules here, just sequencing). */
export function planAiSteps(
  currentRotation: number,
  currentX: number,
  move: AiMove,
): readonly AiStep[] {
  const steps: AiStep[] = [];
  if (move.useHold) steps.push({ kind: "hold" });
  const targetRot = ((move.targetRotation % 4) + 4) % 4;
  const curRot = ((currentRotation % 4) + 4) % 4;
  const cw = (targetRot - curRot + 4) % 4;
  const ccw = (curRot - targetRot + 4) % 4;
  if (cw <= ccw) {
    for (let i = 0; i < cw; i += 1) steps.push({ kind: "rotateCW" });
  } else {
    for (let i = 0; i < ccw; i += 1) steps.push({ kind: "rotateCCW" });
  }
  const dx = move.targetX - currentX;
  if (dx < 0) {
    for (let i = 0; i < -dx; i += 1) steps.push({ kind: "left" });
  } else {
    for (let i = 0; i < dx; i += 1) steps.push({ kind: "right" });
  }
  steps.push({ kind: "drop" });
  return steps;
}

function applyStep(core: CorePort, step: AiStep): void {
  switch (step.kind) {
    case "hold":
      core.hold();
      break;
    case "rotateCW":
      core.rotateCW();
      break;
    case "rotateCCW":
      core.rotateCCW();
      break;
    case "left":
      core.moveLeft();
      break;
    case "right":
      core.moveRight();
      break;
    case "drop":
      core.hardDrop();
      break;
  }
}

export function createApp(options: AppOptions): AppHandle {
  const { core, renderer } = options;
  let mode: PlayMode = options.mode ?? "human";
  let ai: AiPort | null = options.ai ?? null;
  let rafId = 0;
  let lastTime = performance.now();
  let gravityAcc = 0;
  let aiAcc = 0;
  let destroyed = false;

  // AI thinks exactly once per spawn; replay animates the plan step-by-step.
  let pendingThink = mode !== "human";
  let aiQueue: readonly AiStep[] = [];
  let lastActiveKey: string | null = null;
  let aiInstant = options.aiInstant ?? true;
  let stepIntervalMs = options.aiStepIntervalMs ?? 200;
  let paused = false;
  let singleStep = false;

  function activeKey(snap: GameSnapshot): string | null {
    const a = snap.active;
    if (a === null) return null;
    return `${a.kind}:${a.posX}:${a.posY}:${a.rotation}:${snap.board.grid.flat().join("")}`;
  }

  function thinkOnce(snap: GameSnapshot): void {
    if (ai === null) return;
    const a = snap.active;
    if (a === null || snap.gameOver) return;
    let move: AiMove | null = null;
    try {
      move = ai.findBestMove(snap);
    } catch {
      move = null;
    }
    if (move === null) {
      aiQueue = [{ kind: "drop" }];
      return;
    }
    if (move.useHold) {
      aiQueue = [{ kind: "hold" }];
      pendingThink = true;
      return;
    }
    if (aiInstant && typeof core.hardDropAt === "function") {
      const ok = core.hardDropAt(move.targetRotation, move.targetX);
      if (ok) {
        aiQueue = [];
        pendingThink = true;
        return;
      }
    }
    aiQueue = planAiSteps(a.rotation, a.posX, move);
  }

  function advanceAi(dt: number): GameSnapshot {
    let snap = core.getSnapshot();
    if (pendingThink && aiQueue.length === 0 && !snap.gameOver && snap.active !== null) {
      pendingThink = false;
      thinkOnce(core.getSnapshot());
      snap = core.getSnapshot();
      if (aiQueue.length === 0) return snap;
    }
    aiAcc += dt;
    if (aiQueue.length > 0 && aiAcc >= stepIntervalMs) {
      aiAcc = 0;
      const [head, ...rest] = aiQueue;
      if (head !== undefined) {
        applyStep(core, head);
        if (head.kind === "drop" || head.kind === "hold") pendingThink = aiQueue.length <= 1;
      }
      aiQueue = rest;
      snap = core.getSnapshot();
      lastActiveKey = activeKey(snap);
    }
    return snap;
  }

  function frame(now: number): void {
    if (destroyed) return;
    rafId = requestAnimationFrame(frame);
    const dt = Math.min(now - lastTime, 250);
    lastTime = now;
    if (paused && !singleStep) {
      renderer.render(core.getSnapshot());
      return;
    }
    singleStep = false;

    let snap = core.getSnapshot();

    const key = activeKey(snap);
    if (key !== lastActiveKey) {
      lastActiveKey = key;
      if (mode !== "human" && aiQueue.length === 0) pendingThink = true;
    }

    if (mode !== "human") {
      snap = advanceAi(dt);
      gravityAcc += dt;
      const interval = gravityIntervalMs(snap.level, mode);
      if (gravityAcc >= interval && aiQueue.length === 0 && !aiInstant) {
        gravityAcc = 0;
        const locked = core.gravityTick();
        if (locked) pendingThink = true;
        snap = core.getSnapshot();
        lastActiveKey = activeKey(snap);
      }
    } else {
      aiQueue = [];
      pendingThink = false;
      gravityAcc += dt;
      const interval = gravityIntervalMs(snap.level, mode);
      if (gravityAcc >= interval) {
        gravityAcc = 0;
        core.gravityTick();
        snap = core.getSnapshot();
      }
    }

    renderer.render(snap);
    options.onStats?.(snap);
  }

  lastTime = performance.now();
  rafId = requestAnimationFrame(frame);

  return {
    setMode(next: PlayMode): void {
      mode = next;
      aiQueue = [];
      aiAcc = 0;
      gravityAcc = 0;
      pendingThink = next !== "human";
      lastActiveKey = activeKey(core.getSnapshot());
    },
    getMode(): PlayMode {
      return mode;
    },
    reset(): void {
      core.reset();
      aiQueue = [];
      pendingThink = mode !== "human";
      gravityAcc = 0;
      aiAcc = 0;
      lastActiveKey = null;
      paused = false;
      singleStep = false;
    },
    setAiInstant(instant: boolean): void {
      aiInstant = instant;
      aiQueue = [];
      pendingThink = mode !== "human";
    },
    isAiInstant(): boolean {
      return aiInstant;
    },
    setStepIntervalMs(ms: number): void {
      stepIntervalMs = Math.min(2000, Math.max(20, ms));
      aiAcc = 0;
    },
    getStepIntervalMs(): number {
      return stepIntervalMs;
    },
    setPaused(next: boolean): void {
      paused = next;
      singleStep = false;
    },
    isPaused(): boolean {
      return paused;
    },
    stepOnce(): void {
      singleStep = true;
      paused = true;
    },
    setAi(next: AiPort | null): void {
      ai = next;
      aiQueue = [];
      aiAcc = 0;
      pendingThink = mode !== "human";
      lastActiveKey = activeKey(core.getSnapshot());
    },
    getAiName(): string {
      return ai?.name ?? "-";
    },
    destroy(): void {
      destroyed = true;
      cancelAnimationFrame(rafId);
    },
  };
}

/**
 * Adapter: prefer a real core/ai when those modules land, else fall back to mock.
 * Never throws: missing modules are absorbed here, not in UI code.
 */
export async function resolveCore(): Promise<CorePort> {
  return createEngine();
}

export async function resolveAi(): Promise<AiPort | null> {
  return createAi() as unknown as AiPort;
}

/** Greedy placeholder AI so spectate/AI modes animate even before real AI lands. */
export function createFallbackAi(): AiPort {
  return {
    name: "fallback-greedy",
    findBestMove(snapshot: GameSnapshot): AiMove | null {
      const a = snapshot.active;
      if (a === null) return null;
      // Pick the column with the lowest stack; keep rotation as-is.
      let bestX = a.posX;
      let bestH = Number.POSITIVE_INFINITY;
      for (let x = 0; x < snapshot.board.cols; x += 1) {
        let h = 0;
        for (let y = 0; y < snapshot.board.rows; y += 1) {
          const row = snapshot.board.grid[y];
          if (row !== undefined && (row[x] ?? 0) !== 0) {
            h = snapshot.board.rows - y;
            break;
          }
        }
        if (h < bestH) {
          bestH = h;
          bestX = x;
        }
      }
      return {
        targetX: Math.max(0, Math.min(bestX, snapshot.board.cols - 1)),
        targetRotation: a.rotation,
        useHold: false,
      };
    },
  };
}
