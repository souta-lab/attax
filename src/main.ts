import "./style.css";
import { createDeepSeekTetris } from "./ai/deepseek.js";
import { createRustHoiko } from "./ai/hoiko-rust.js";
import { type BoardRenderer, createBoardOnlyRenderer } from "./ui/renderer.js";
import type { GameSnapshot } from "./ui/types.js";
import {
  createVersusController,
  type SideState,
  VERSUS_DEFAULTS,
  type VersusController,
  type VersusControllerOptions,
  type VersusResult,
} from "./versus/controller.js";

/** Spectator speed multipliers; 1x is the calibrated default. */
const SPEEDS = [0.5, 1, 2, 4] as const;
const MAX_LOG_ROWS = 6;
const GARBAGE_METER_MAX = 12;
const DEEPSEEK_COLOR = "#38bdf8";

type SpeedMultiplier = (typeof SPEEDS)[number];

function isSpeed(value: number): value is SpeedMultiplier {
  return (SPEEDS as readonly number[]).includes(value);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

interface SideView {
  readonly column: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly wins: HTMLElement;
  readonly lines: HTMLElement;
  readonly sent: HTMLElement;
  readonly combo: HTMLElement;
  readonly b2b: HTMLElement;
  readonly meter: HTMLElement;
  readonly meterFill: HTMLElement;
  readonly pop: HTMLElement;
  lastAttack: number;
  popUntil: number;
}

interface BattleRow {
  readonly no: number;
  readonly winner: string;
  readonly side: "left" | "right" | "draw";
  readonly reason: string;
  readonly lines: string;
  readonly sent: string;
  readonly wins: string;
}

interface Shell {
  readonly sideL: SideView;
  readonly sideR: SideView;
  readonly banner: HTMLElement;
  readonly bannerMain: HTMLElement;
  readonly bannerReason: HTMLElement;
  readonly bannerCount: HTMLElement;
  readonly logList: HTMLElement;
  readonly speedButtons: readonly HTMLButtonElement[];
  readonly pauseButton: HTMLButtonElement;
}

function statRow(label: string): { row: HTMLElement; value: HTMLElement } {
  const row = el("div");
  const value = el("dd", "stat-value", "0");
  row.append(el("dt", undefined, label), value);
  return { row, value };
}

function buildSide(side: "hoiko" | "deepseek", name: string): SideView {
  const column = el("section", "side");
  column.dataset["side"] = side;

  const head = el("header", "side-head");
  const wins = el("span", "wins-num", "0");
  const winsWrap = el("div", "side-wins");
  winsWrap.append(wins, el("span", "wins-label", "wins"));
  head.append(el("h2", "side-name", name), winsWrap);

  const meter = el("div", "meter");
  meter.setAttribute("role", "progressbar");
  meter.setAttribute("aria-label", `${name} incoming garbage`);
  meter.setAttribute("aria-valuemin", "0");
  meter.setAttribute("aria-valuemax", String(GARBAGE_METER_MAX));
  meter.setAttribute("aria-valuenow", "0");
  const meterFill = el("div", "meter-fill");
  meter.append(meterFill);

  const pop = el("div", "attack-pop");
  pop.setAttribute("aria-hidden", "true");

  const canvas = el("canvas", "arena-board");
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", `${name} board`);

  const stats = el("dl", "stats");
  const lines = statRow("lines");
  const sent = statRow("sent");
  const combo = statRow("combo");
  const b2b = statRow("b2b");
  stats.append(lines.row, sent.row, combo.row, b2b.row);

  column.append(head, meter, pop, canvas, stats);
  return {
    column,
    canvas,
    wins,
    lines: lines.value,
    sent: sent.value,
    combo: combo.value,
    b2b: b2b.value,
    meter,
    meterFill,
    pop,
    lastAttack: -1,
    popUntil: 0,
  };
}

function buildShell(root: HTMLElement): Shell {
  root.replaceChildren();
  const app = el("div", "app");

  const masthead = el("header", "masthead");
  const title = el("h1", "title");
  title.append(
    el("span", "t-hoiko", "HOIKO"),
    el("span", "t-vs", "vs"),
    el("span", "t-deepseek", "DEEPSEEK"),
    el("span", "t-tetris", "TETRIS"),
  );
  const controls = el("div", "controls");
  const speedButtons: HTMLButtonElement[] = [];
  for (const mult of SPEEDS) {
    const button = el("button", "ctl");
    button.type = "button";
    button.textContent = `${mult}x`;
    button.dataset["mult"] = String(mult);
    speedButtons.push(button);
  }
  const pauseButton = el("button", "ctl");
  pauseButton.type = "button";
  pauseButton.classList.add("ctl-pause");
  controls.append(...speedButtons, pauseButton);
  masthead.append(title, controls);

  const banner = el("div", "banner");
  banner.setAttribute("aria-live", "polite");
  const bannerMain = el("div", "banner-main");
  const bannerSub = el("div", "banner-sub");
  const bannerReason = el("span", "banner-reason");
  const bannerCount = el("span", "banner-count");
  bannerSub.append(bannerReason, bannerCount);
  banner.append(bannerMain, bannerSub);

  const arena = el("div", "arena");
  const sideL = buildSide("hoiko", "HOIKO");
  const sideR = buildSide("deepseek", "DEEPSEEK");
  arena.append(sideL.column, sideR.column);

  const log = el("section", "log");
  const logList = el("div", "log-list");
  log.append(el("h2", "log-title", "recent battles"), logList);

  app.append(masthead, banner, arena, log);
  root.append(app);

  return {
    sideL,
    sideR,
    banner,
    bannerMain,
    bannerReason,
    bannerCount,
    logList,
    speedButtons,
    pauseButton,
  };
}

function paintSide(view: SideView, side: SideState, snap: GameSnapshot, now: number): void {
  view.wins.textContent = String(side.wins);
  view.lines.textContent = String(snap.lines);
  view.sent.textContent = String(side.sentTotal);
  view.combo.textContent = snap.combo > 0 ? String(snap.combo) : "—";
  view.combo.classList.toggle("dim", snap.combo === 0);
  view.b2b.textContent = snap.b2b ? "on" : "—";
  view.b2b.classList.toggle("dim", !snap.b2b);

  const pct = Math.min(100, (snap.pendingGarbage / GARBAGE_METER_MAX) * 100);
  view.meterFill.style.width = `${pct}%`;
  view.meter.setAttribute("aria-valuenow", String(snap.pendingGarbage));
  view.meter.classList.toggle("hot", snap.pendingGarbage >= GARBAGE_METER_MAX / 2);

  if (snap.lastAttack > 0 && snap.lastAttack !== view.lastAttack) {
    view.lastAttack = snap.lastAttack;
    view.pop.textContent = `+${snap.lastAttack}`;
    view.popUntil = now + 1200;
  }
  view.pop.classList.toggle("show", now < view.popUntil);
}

function paintBanner(shell: Shell, controller: VersusController, paused: boolean): void {
  const result = controller.result;
  shell.banner.classList.toggle("live", result === null && !paused);
  shell.banner.classList.toggle("paused", result === null && paused);
  shell.banner.classList.toggle("winner-left", result?.winner === "left");
  shell.banner.classList.toggle("winner-right", result?.winner === "right");
  shell.banner.classList.toggle("winner-draw", result?.winner === "draw");

  if (result === null) {
    shell.bannerMain.textContent = paused ? "PAUSED" : "BATTLE IN PROGRESS";
    shell.bannerReason.textContent = `${controller.pieces} pieces placed`;
    shell.bannerCount.textContent = "";
    return;
  }
  shell.bannerMain.textContent =
    result.winner === "draw" ? "DRAW" : `${controller[result.winner].fighter.name} WINS`;
  shell.bannerReason.textContent = result.reason;
  const remaining = controller.rematchIn;
  shell.bannerCount.textContent =
    remaining === null || remaining <= 0
      ? "next battle starting"
      : `next battle in ${(remaining / 1000).toFixed(1)}s`;
}

function battleRow(no: number, result: VersusResult, controller: VersusController): BattleRow {
  const winner =
    result.winner === "draw"
      ? "DRAW"
      : result.winner === "left"
        ? controller.left.fighter.name
        : controller.right.fighter.name;
  return {
    no,
    winner,
    side: result.winner,
    reason: result.reason,
    lines: `${result.linesLeft}–${result.linesRight}`,
    sent: `${result.sentLeft}–${result.sentRight}`,
    wins: `${controller.left.wins}–${controller.right.wins}`,
  };
}

function renderLog(list: HTMLElement, rows: readonly BattleRow[]): void {
  list.replaceChildren();
  if (rows.length === 0) {
    list.append(el("div", "log-empty", "first battle starting…"));
    return;
  }
  for (const row of rows.slice(0, MAX_LOG_ROWS)) {
    const node = el("div", "log-row");
    node.dataset["side"] = row.side;
    node.append(
      el("span", "log-no", `#${row.no}`),
      el("span", "log-winner", row.winner),
      el("span", "log-reason", row.reason),
      el("span", "log-stat", `lines ${row.lines}`),
      el("span", "log-stat", `sent ${row.sent}`),
      el("span", "log-score", `score ${row.wins}`),
    );
    list.append(node);
  }
}

/** 1x is the untouched default; other speeds scale both AI step and gravity intervals. */
function speedOptions(multiplier: number): VersusControllerOptions {
  return {
    ...VERSUS_DEFAULTS,
    stepIntervalMs: VERSUS_DEFAULTS.stepIntervalMs / multiplier,
    gravityMs: VERSUS_DEFAULTS.gravityMs / multiplier,
  };
}

function nextSeed(): number {
  return (Date.now() ^ (Math.random() * 1e9)) | 0;
}

function boot(): void {
  const root = document.getElementById("app");
  if (root === null) throw new Error("missing #app");
  const shell = buildShell(root);

  const hoiko = createRustHoiko({ weightPreset: "we", beamSizeLimit: 500 });
  const deepseek = createDeepSeekTetris();
  const renderL: BoardRenderer = createBoardOnlyRenderer(shell.sideL.canvas);
  const renderR: BoardRenderer = createBoardOnlyRenderer(shell.sideR.canvas);

  let speed: SpeedMultiplier = 1;
  let options = speedOptions(speed);
  let paused = false;
  const controller = createVersusController(
    hoiko,
    {
      name: "DEEPSEEK",
      color: DEEPSEEK_COLOR,
      findBestMove: (snap) => deepseek.findBestMove(snap),
    },
    nextSeed(),
  );
  let seenResult: VersusResult | null = null;
  let matchNo = 0;
  const rows: BattleRow[] = [];
  let raf = 0;
  let last = performance.now();

  const syncControls = (): void => {
    for (const button of shell.speedButtons) {
      const active = Number(button.dataset["mult"]) === speed;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    shell.pauseButton.textContent = paused ? "resume" : "pause";
    shell.pauseButton.setAttribute("aria-pressed", String(paused));
    shell.pauseButton.classList.toggle("active", paused);
  };

  const frame = (now: number): void => {
    raf = requestAnimationFrame(frame);
    const dt = Math.min(now - last, 250);
    last = now;
    if (!paused) controller.tick(dt, options);

    const snapL = controller.left.core.getSnapshot();
    const snapR = controller.right.core.getSnapshot();
    renderL.renderBoard(snapL);
    renderR.renderBoard(snapR);
    paintSide(shell.sideL, controller.left, snapL, now);
    paintSide(shell.sideR, controller.right, snapR, now);
    paintBanner(shell, controller, paused);

    const result = controller.result;
    if (result !== null && result !== seenResult) {
      seenResult = result;
      matchNo += 1;
      rows.unshift(battleRow(matchNo, result, controller));
      if (rows.length > MAX_LOG_ROWS) rows.length = MAX_LOG_ROWS;
      renderLog(shell.logList, rows);
    }
  };

  for (const button of shell.speedButtons) {
    button.addEventListener("click", () => {
      const mult = Number(button.dataset["mult"]);
      if (!isSpeed(mult)) return;
      speed = mult;
      options = speedOptions(mult);
      paused = false;
      syncControls();
    });
  }
  shell.pauseButton.addEventListener("click", () => {
    paused = !paused;
    syncControls();
  });
  window.addEventListener("pagehide", () => cancelAnimationFrame(raf), { once: true });

  syncControls();
  raf = requestAnimationFrame(frame);
}

void boot();
