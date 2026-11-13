/**
 * Solo play: the same engine the AIs use, driven by the keyboard (or touch buttons).
 * Arrows move, Up/X rotate clockwise, Z rotates counter-clockwise, Space hard-drops,
 * C/Shift holds, P pauses, R restarts.
 */
import { createEngine } from "../core/engine.js";
import { cellsFor } from "../core/pieces.js";
import type { CorePort, GameSnapshot } from "../core/types.js";
import { drawBoard, drawQueue, PALETTES } from "./board-view.js";
import { boardCell, h } from "./dom.js";

const DAS_MS = 150;
const ARR_MS = 40;
const SOFT_MS = 35;
const LOCK_DELAY_MS = 500;

function gravityMs(level: number): number {
  return Math.max(60, 800 * 0.85 ** (level - 1));
}

type Action = "left" | "right" | "down" | "cw" | "ccw" | "drop" | "hold";

const KEYS: Readonly<Record<string, Action>> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowDown: "down",
  ArrowUp: "cw",
  KeyX: "cw",
  KeyZ: "ccw",
  Space: "drop",
  KeyC: "hold",
  ShiftLeft: "hold",
  ShiftRight: "hold",
};

export function createPlayView(): HTMLElement {
  const board = h("canvas", { class: "board" });
  const hold = h("canvas", { class: "queue" });
  const next = h("canvas", { class: "queue" });
  const score = h("strong", { text: "0" });
  const lines = h("strong", { text: "0" });
  const level = h("strong", { text: "1" });
  const status = h("p", {
    class: "play-status",
    text: "Click the board or press any key to start.",
  });
  const pauseBtn = h("button", { text: "Pause", attrs: { type: "button" } });
  const restartBtn = h("button", { text: "Restart", attrs: { type: "button" } });

  const touch = (label: string, action: Action): HTMLButtonElement => {
    const b = h("button", {
      class: "touch",
      text: label,
      attrs: { type: "button", "aria-label": action },
    });
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      focusGame();
      perform(action);
    });
    return b;
  };

  const surface = h(
    "div",
    {
      class: "play-surface",
      attrs: { tabindex: "0", "aria-label": "Game board — use the keyboard to play" },
    },
    [
      h("div", { class: "field" }, [
        h("div", { class: "side-col" }, [h("span", { class: "label", text: "Hold" }), hold]),
        h("div", { class: "board-wrap" }, [board]),
        h("div", { class: "side-col" }, [h("span", { class: "label", text: "Next" }), next]),
      ]),
    ],
  );
  const root = h("div", { class: "play" }, [
    surface,
    h("div", { class: "play-side" }, [
      h("div", { class: "stats" }, [
        h("div", { class: "stat" }, [h("span", { text: "Score" }), score]),
        h("div", { class: "stat" }, [h("span", { text: "Lines" }), lines]),
        h("div", { class: "stat" }, [h("span", { text: "Level" }), level]),
      ]),
      status,
      h("div", { class: "group" }, [pauseBtn, restartBtn]),
      h("dl", { class: "keys" }, [
        h("dt", { text: "← →" }),
        h("dd", { text: "move" }),
        h("dt", { text: "↓" }),
        h("dd", { text: "soft drop" }),
        h("dt", { text: "Space" }),
        h("dd", { text: "hard drop" }),
        h("dt", { text: "↑ / X, Z" }),
        h("dd", { text: "rotate right, left" }),
        h("dt", { text: "C / Shift" }),
        h("dd", { text: "hold" }),
        h("dt", { text: "P, R" }),
        h("dd", { text: "pause, restart" }),
      ]),
      h("div", { class: "touch-pad" }, [
        touch("⟲", "ccw"),
        touch("⟳", "cw"),
        touch("Hold", "hold"),
        touch("←", "left"),
        touch("↓", "down"),
        touch("→", "right"),
        touch("Drop", "drop"),
      ]),
    ]),
  ]);

  let engine: CorePort = createEngine();
  let started = false;
  let paused = false;
  let fallAcc = 0;
  let groundedFor = 0;
  let last = 0;
  const held = new Map<Action, { since: number; lastRepeat: number }>();

  function snapshot(): GameSnapshot {
    return engine.getSnapshot();
  }

  function focusGame(): void {
    surface.focus({ preventScroll: true });
    if (!started) {
      started = true;
      status.textContent = "";
    }
  }

  function perform(action: Action): void {
    const s = snapshot();
    if (s.gameOver || paused || !started) return;
    switch (action) {
      case "left":
        engine.moveLeft();
        break;
      case "right":
        engine.moveRight();
        break;
      case "down":
        if (s.active !== null && s.ghostY !== s.active.posY) engine.softDrop();
        break;
      case "cw":
        engine.rotateCW();
        break;
      case "ccw":
        engine.rotateCCW();
        break;
      case "drop":
        engine.hardDrop();
        fallAcc = 0;
        break;
      case "hold":
        engine.hold();
        break;
    }
    if (action !== "drop" && action !== "down") groundedFor = 0; // moving resets lock delay
  }

  function restart(): void {
    engine = createEngine();
    paused = false;
    started = true;
    fallAcc = 0;
    groundedFor = 0;
    pauseBtn.textContent = "Pause";
    status.textContent = "";
    surface.focus({ preventScroll: true });
  }

  function togglePause(): void {
    if (snapshot().gameOver) return;
    paused = !paused;
    pauseBtn.textContent = paused ? "Resume" : "Pause";
    status.textContent = paused ? "Paused." : "";
  }

  surface.addEventListener("keydown", (e) => {
    if (e.code === "KeyP" || e.code === "Escape") {
      togglePause();
      e.preventDefault();
      return;
    }
    if (e.code === "KeyR") {
      restart();
      e.preventDefault();
      return;
    }
    const action = KEYS[e.code];
    if (action === undefined) {
      focusGame();
      return;
    }
    e.preventDefault();
    focusGame();
    if (e.repeat) return;
    perform(action);
    if (action === "left" || action === "right" || action === "down") {
      held.set(action, { since: performance.now(), lastRepeat: performance.now() });
    }
  });
  surface.addEventListener("keyup", (e) => {
    const action = KEYS[e.code];
    if (action !== undefined) held.delete(action);
  });
  surface.addEventListener("blur", () => held.clear());
  surface.addEventListener("pointerdown", focusGame);
  pauseBtn.addEventListener("click", togglePause);
  restartBtn.addEventListener("click", restart);

  function tick(now: number): void {
    requestAnimationFrame(tick);
    const dt = last === 0 ? 0 : Math.min(100, now - last);
    last = now;
    let s = snapshot();
    if (started && !paused && !s.gameOver) {
      for (const [action, state] of held) {
        const delay = action === "down" ? SOFT_MS : DAS_MS;
        const repeat = action === "down" ? SOFT_MS : ARR_MS;
        if (now - state.since >= delay && now - state.lastRepeat >= repeat) {
          state.lastRepeat = now;
          perform(action);
        }
      }
      s = snapshot();
      const grounded = s.active !== null && s.ghostY === s.active.posY;
      if (grounded) {
        groundedFor += dt;
        if (groundedFor >= LOCK_DELAY_MS) {
          engine.gravityTick();
          groundedFor = 0;
          fallAcc = 0;
        }
      } else {
        groundedFor = 0;
        fallAcc += dt;
        const interval = gravityMs(s.level);
        while (fallAcc >= interval) {
          fallAcc -= interval;
          engine.gravityTick();
        }
      }
      s = snapshot();
      if (s.gameOver) status.textContent = `Game over — ${s.lines} lines. Press R to play again.`;
    }
    render(s);
  }

  function render(s: GameSnapshot): void {
    const cell = boardCell();
    const active = s.active;
    const activeCells =
      active === null
        ? null
        : active.cells.map((c) => [active.posX + c.x, active.posY + c.y] as const);
    const ghost =
      active === null || s.ghostY === null
        ? null
        : cellsFor(active.kind, active.rotation).map(
            (c) => [active.posX + c.x, (s.ghostY ?? 0) + c.y] as const,
          );
    drawBoard(
      board,
      {
        grid: s.board.grid,
        active: active === null ? null : { kind: active.kind, cells: activeCells ?? [] },
        ghost,
        dimmed: s.gameOver || paused,
      },
      PALETTES.ink,
      cell,
    );
    drawQueue(hold, [s.hold], PALETTES.ink, cell * 0.7, 1, !s.canHold);
    drawQueue(next, s.next, PALETTES.ink, cell * 0.7, 5);
    score.textContent = s.score.toLocaleString();
    lines.textContent = String(s.lines);
    level.textContent = String(s.level);
  }

  requestAnimationFrame(tick);
  return root;
}
