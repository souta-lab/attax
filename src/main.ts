import "./style.css";
import { createDeepSeekTetris } from "./ai/deepseek.js";
import { createHoiko } from "./ai/hoiko.js";
import { createApp, resolveCore } from "./ui/app.js";
import { attachInput } from "./ui/input.js";
import { createBoardOnlyRenderer, createRenderer } from "./ui/renderer.js";
import type { AiDebug, GameSnapshot, PlayMode } from "./ui/types.js";
import {
  createVersusController,
  VERSUS_DEFAULTS,
  type VersusController,
  type VersusFighter,
} from "./versus/controller.js";

function requireElement(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`missing #${id}`);
  return el;
}

function buildShell(root: HTMLElement): {
  board: HTMLCanvasElement;
  hold: HTMLCanvasElement;
  next: HTMLCanvasElement;
  score: HTMLElement;
  lines: HTMLElement;
  level: HTMLElement;
  aiThink: HTMLElement;
  hudBody: HTMLElement;
  hud2Body: HTMLElement;
  logList: HTMLElement;
  logWrap: HTMLElement;
  csvButton: HTMLButtonElement;
  clearLogButton: HTMLButtonElement;
  singleView: HTMLElement;
  versusView: HTMLElement;
  vsLogSlot: HTMLElement;
  vsBoardL: HTMLCanvasElement;
  vsBoardR: HTMLCanvasElement;
  vsMeterL: HTMLElement;
  vsMeterR: HTMLElement;
  vsPopL: HTMLElement;
  vsPopR: HTMLElement;
  vsHudL: HTMLElement;
  vsHudR: HTMLElement;
  vsBanner: HTMLElement;
  vsNameL: HTMLElement;
  vsNameR: HTMLElement;
  vsRematch: HTMLButtonElement;
  vsSpeeds: HTMLButtonElement[];
  modeButtons: Record<PlayMode, HTMLButtonElement>;
  speedButtons: HTMLButtonElement[];
  instantButton: HTMLButtonElement;
  pauseButton: HTMLButtonElement;
  stepButton: HTMLButtonElement;
} {
  root.innerHTML = "";
  const singleView = document.createElement("div");
  singleView.id = "single-view";
  const layout = document.createElement("div");
  layout.className = "layout";

  const left = document.createElement("div");
  left.className = "side";
  left.innerHTML = `<div class="panel-title">HOLD</div>`;
  const hold = document.createElement("canvas");
  hold.className = "panel-canvas";
  left.append(hold);
  const stats = document.createElement("div");
  stats.className = "stats";
  stats.innerHTML = `<div>SCORE <span id="st-score">0</span></div><div>LINES <span id="st-lines">0</span></div><div>LEVEL <span id="st-level">1</span></div><div>AI <span id="st-ai">-</span></div>`;
  left.append(stats);
  const hud = document.createElement("div");
  hud.className = "hud";
  hud.innerHTML = `<div class="hud-title">AI INSIDE</div><div id="hud-body">-</div>`;
  left.append(hud);

  const center = document.createElement("div");
  center.className = "center";
  const board = document.createElement("canvas");
  board.id = "board";
  const controls = document.createElement("div");
  controls.className = "controls";
  const controls2 = document.createElement("div");
  controls2.className = "controls";
  const speedRow = document.createElement("div");
  speedRow.className = "controls";
  const hint = document.createElement("div");
  hint.className = "hint";
  hint.textContent =
    "←→移動 ↓ソフトドロップ ↑/X回転 Z逆回転 Spaceハードドロップ Cホールド / 見るだけ=ゆっくり再生がおすすめ";
  center.append(board, controls, controls2, speedRow, hint);

  const right = document.createElement("div");
  right.className = "side";
  right.innerHTML = `<div class="panel-title">NEXT</div>`;
  const next = document.createElement("canvas");
  next.className = "panel-canvas";
  right.append(next);
  const hud2 = document.createElement("div");
  hud2.className = "hud hud-right";
  hud2.innerHTML = `<div class="hud-title">RIVAL / EVO</div><div id="hud2-body">-</div>`;
  right.append(hud2);

  const versusView = document.createElement("div");
  versusView.id = "versus-view";
  versusView.className = "versus-hidden";
  const arena = document.createElement("div");
  arena.className = "arena";
  arena.id = "arena";
  const mkBoard = (name: string, meterId: string): HTMLCanvasElement => {
    const col = document.createElement("div");
    col.className = "arena-col";
    const title = document.createElement("div");
    title.className = "panel-title";
    title.id = `${meterId}-name`;
    title.textContent = name;
    col.append(title);
    const meter = document.createElement("div");
    meter.className = "meter";
    const fill = document.createElement("div");
    fill.className = "meter-fill";
    fill.id = meterId;
    meter.append(fill);
    col.append(meter);
    const pop = document.createElement("div");
    pop.className = "attack-pop";
    pop.id = `${meterId}-pop`;
    col.append(pop);
    const canvas = document.createElement("canvas");
    canvas.className = "panel-canvas arena-board";
    col.append(canvas);
    const hud = document.createElement("div");
    hud.className = "hud";
    const hudBody = document.createElement("div");
    hudBody.id = `${meterId}-hud`;
    hudBody.textContent = "-";
    hud.append(hudBody);
    col.append(hud);
    arena.append(col);
    return canvas;
  };
  const boardL = mkBoard("🛡️ SCORE AI", "meter-l");
  const boardR = mkBoard("🔥 VERSUS AI", "meter-r");
  const versusBanner = document.createElement("div");
  versusBanner.className = "versus-banner";
  versusBanner.id = "versus-banner";
  versusBanner.textContent = "VS";
  const rematchButton = document.createElement("button");
  rematchButton.textContent = "すぐ再戦";
  rematchButton.id = "vs-rematch";
  const vsSpeeds: HTMLButtonElement[] = [];
  const vsSpeedRow = document.createElement("div");
  vsSpeedRow.className = "controls";
  for (const [label, ms] of [
    ["ゆっくり", 300],
    ["ふつう", 120],
    ["高速", 45],
  ] as const) {
    const b = document.createElement("button");
    b.textContent = label;
    b.dataset["ms"] = String(ms);
    vsSpeedRow.append(b);
    vsSpeeds.push(b);
  }
  versusView.append(arena, versusBanner, rematchButton, vsSpeedRow);

  const logWrap = document.createElement("div");
  logWrap.className = "side log-side";
  logWrap.innerHTML = `<div class="panel-title">BATTLE LOG</div>`;
  const logList = document.createElement("div");
  logList.className = "battle-log";
  logList.id = "battle-log";
  logWrap.append(logList);
  const logButtons = document.createElement("div");
  logButtons.className = "controls log-controls";
  const csvButton = document.createElement("button");
  csvButton.textContent = "CSV保存";
  const clearLogButton = document.createElement("button");
  clearLogButton.textContent = "クリア";
  logButtons.append(csvButton, clearLogButton);
  logWrap.append(logButtons);

  layout.append(left, center, right, logWrap);
  singleView.append(layout);
  root.append(singleView, versusView);

  const modes: readonly PlayMode[] = ["human", "ai", "spectate", "versus"];
  const labels: Record<PlayMode, string> = {
    human: "人間",
    ai: "スコアAI",
    spectate: "観戦高速",
    versus: "⚔️ AI対戦",
  };
  const modeButtons = {} as Record<PlayMode, HTMLButtonElement>;
  for (const m of modes) {
    const b = document.createElement("button");
    b.textContent = labels[m];
    b.addEventListener("click", () => setActive(m));
    controls.append(b);
    modeButtons[m] = b;
  }
  const reset = document.createElement("button");
  reset.textContent = "リセット";
  reset.id = "btn-reset";
  controls.append(reset);

  const instantButton = document.createElement("button");
  instantButton.textContent = "瞬間配置:ON";
  controls2.append(instantButton);
  const pauseButton = document.createElement("button");
  pauseButton.textContent = "一時停止";
  controls2.append(pauseButton);
  const stepButton = document.createElement("button");
  stepButton.textContent = "1手進める";
  controls2.append(stepButton);

  const speeds: ReadonlyArray<{ readonly label: string; readonly ms: number }> = [
    { label: "0.5手/秒", ms: 2000 },
    { label: "1手/秒", ms: 1000 },
    { label: "2手/秒", ms: 500 },
    { label: "5手/秒", ms: 200 },
    { label: "高速", ms: 45 },
  ];
  const speedButtons: HTMLButtonElement[] = [];
  for (const s of speeds) {
    const b = document.createElement("button");
    b.textContent = s.label;
    b.dataset["ms"] = String(s.ms);
    speedRow.append(b);
    speedButtons.push(b);
  }

  function setActive(_m: PlayMode): void {
    // replaced after app creation
  }

  return {
    board,
    hold,
    next,
    score: stats.querySelector("#st-score") as HTMLElement,
    lines: stats.querySelector("#st-lines") as HTMLElement,
    level: stats.querySelector("#st-level") as HTMLElement,
    aiThink: stats.querySelector("#st-ai") as HTMLElement,
    hudBody: hud.querySelector("#hud-body") as HTMLElement,
    hud2Body: hud2.querySelector("#hud2-body") as HTMLElement,
    logList,
    logWrap,
    csvButton,
    clearLogButton,
    singleView,
    versusView,
    vsLogSlot: logWrap,
    vsBoardL: boardL,
    vsBoardR: boardR,
    vsMeterL: versusView.querySelector("#meter-l") as HTMLElement,
    vsMeterR: versusView.querySelector("#meter-r") as HTMLElement,
    vsPopL: versusView.querySelector("#meter-l-pop") as HTMLElement,
    vsPopR: versusView.querySelector("#meter-r-pop") as HTMLElement,
    vsHudL: versusView.querySelector("#meter-l-hud") as HTMLElement,
    vsHudR: versusView.querySelector("#meter-r-hud") as HTMLElement,
    vsBanner: versusBanner,
    vsNameL: versusView.querySelector("#meter-l-name") as HTMLElement,
    vsNameR: versusView.querySelector("#meter-r-name") as HTMLElement,
    vsRematch: rematchButton,
    vsSpeeds,
    modeButtons,
    speedButtons,
    instantButton,
    pauseButton,
    stepButton,
  };
}

// no-excuse-ok: catch — top-level entry boundary
async function boot(): Promise<void> {
  try {
    const root = requireElement("app");
    const shell = buildShell(root);
    const core = await resolveCore();
    const deepseek = createDeepSeekTetris();
    const hoiko = createHoiko();
    const renderer = createRenderer(shell.board, shell.hold, shell.next);
    const vsRenderL = createBoardOnlyRenderer(shell.vsBoardL, 22);
    const vsRenderR = createBoardOnlyRenderer(shell.vsBoardR, 22);
    let thinkTotal = 0;
    let thinkCount = 0;
    const timedAi = {
      name: deepseek.name,
      findBestMove: (s: GameSnapshot) => {
        const t0 = performance.now();
        const mv = deepseek.findBestMove(s);
        thinkTotal += performance.now() - t0;
        thinkCount += 1;
        return mv;
      },
      getDebug: () => deepseek.getDebug(),
    };
    const timedVersus = {
      name: hoiko.name,
      findBestMove: (s: GameSnapshot) => {
        const t0 = performance.now();
        const mv = hoiko.findBestMove(s);
        thinkTotal += performance.now() - t0;
        thinkCount += 1;
        return mv;
      },
      getDebug: () => hoiko.getDebug?.() ?? null,
    };
    const scoreFighter: VersusFighter = {
      name: "DEEPSEEK",
      color: "#38bdf8",
      findBestMove: (s) => deepseek.findBestMove(s),
      getDebug: () => deepseek.getDebug(),
    };
    const versusFighter: VersusFighter = {
      name: hoiko.name,
      color: hoiko.color,
      findBestMove: (s) => timedVersus.findBestMove(s),
      getDebug: () => timedVersus.getDebug(),
    };
    let versusCtrl: VersusController | null = null;
    let versusRaf = 0;
    let versusLast = 0;
    let versusOptions = { ...VERSUS_DEFAULTS };
    const syncSpeeds = (): void => {
      for (const b of shell.vsSpeeds) {
        b.classList.toggle("active", Number(b.dataset["ms"]) === versusOptions.stepIntervalMs);
      }
    };
    syncSpeeds();
    let versusMatchNo = 0;
    let versusLastResult: VersusController["result"] = null;
    interface VersusBattleRow {
      readonly no: number;
      readonly winner: string;
      readonly reason: string;
      readonly pieces: number;
      readonly lines: string;
      readonly sent: string;
      readonly wins: string;
    }
    const versusRows: VersusBattleRow[] = [];
    let versusPopTextL: string | null = null;
    let versusPopTextR: string | null = null;
    let versusPopLUntil = 0;
    let versusPopRUntil = 0;
    const MAX_LOG_ROWS = 60;
    const logList = shell.logList;
    const showVersus = (show: boolean): void => {
      shell.singleView.classList.toggle("versus-hidden", show);
      shell.versusView.classList.toggle("versus-hidden", !show);
      shell.logWrap.classList.toggle("versus-hidden", show);
      shell.vsLogSlot.classList.toggle("versus-hidden", !show);
    };
    const stopVersusLoop = (): void => {
      cancelAnimationFrame(versusRaf);
      versusRaf = 0;
      versusCtrl = null;
      versusLastResult = null;
    };
    const startVersusLoop = (): void => {
      stopVersusLoop();
      versusCtrl = createVersusController(scoreFighter, versusFighter, Date.now() | 0);
      versusMatchNo = 0;
      versusRows.length = 0;
      renderVersusLog(logList, versusRows);
      shell.vsPopL.dataset["last"] = "-1";
      shell.vsPopR.dataset["last"] = "-1";
      versusLast = performance.now();
      const frame = (now: number): void => {
        versusRaf = requestAnimationFrame(frame);
        const dt = Math.min(now - versusLast, 250);
        versusLast = now;
        const ctrl = versusCtrl;
        if (ctrl === null) return;
        if (!app.isPaused()) ctrl.tick(dt, versusOptions);
        const snapL = ctrl.left.core.getSnapshot();
        const snapR = ctrl.right.core.getSnapshot();
        vsRenderL.renderBoard(snapL);
        vsRenderR.renderBoard(snapR);
        paintMeter(shell.vsMeterL, snapL.pendingGarbage);
        paintMeter(shell.vsMeterR, snapR.pendingGarbage);
        paintAttackPop(shell.vsPopL, snapL, now, "L");
        paintAttackPop(shell.vsPopR, snapR, now, "R");
        shell.vsHudL.innerHTML = versusHudHtml(ctrl.left, snapL);
        shell.vsHudR.innerHTML = versusHudHtml(ctrl.right, snapR);
        if (ctrl.result !== null && ctrl.result !== versusLastResult) {
          versusLastResult = ctrl.result;
          versusMatchNo += 1;
          versusRows.unshift({
            no: versusMatchNo,
            winner:
              ctrl.result.winner === "draw"
                ? "引分"
                : ctrl.result.winner === "left"
                  ? scoreFighter.name
                  : versusFighter.name,
            reason: ctrl.result.reason,
            pieces: ctrl.result.pieces,
            lines: `${ctrl.result.linesLeft}-${ctrl.result.linesRight}`,
            sent: `${ctrl.result.sentLeft}-${ctrl.result.sentRight}`,
            wins: `${ctrl.left.wins}-${ctrl.right.wins}`,
          });
          if (versusRows.length > MAX_LOG_ROWS) versusRows.length = MAX_LOG_ROWS;
          renderVersusLog(logList, versusRows);
        }
        shell.vsBanner.textContent =
          ctrl.result === null
            ? `VS — ${ctrl.pieces}pcs`
            : ctrl.result.winner === "draw"
              ? `DRAW (${ctrl.result.reason})`
              : ctrl.result.winner === "left"
                ? `🛡️ SCORE WIN (${ctrl.result.reason})`
                : `🔥 VERSUS WIN (${ctrl.result.reason})`;
      };
      versusRaf = requestAnimationFrame(frame);
    };
    const paintAttackPop = (
      el: HTMLElement,
      snap: { readonly lastAttack: number },
      now: number,
      tag: string,
    ): void => {
      const last = Number(el.dataset["last"] ?? -1);
      if (snap.lastAttack > 0 && snap.lastAttack !== last) {
        el.dataset["last"] = String(snap.lastAttack);
        if (tag === "L") {
          versusPopTextL = `+${snap.lastAttack}`;
          versusPopLUntil = now + 1200;
        } else {
          versusPopTextR = `+${snap.lastAttack}`;
          versusPopRUntil = now + 1200;
        }
      }
      const text = tag === "L" ? versusPopTextL : versusPopTextR;
      const until = tag === "L" ? versusPopLUntil : versusPopRUntil;
      el.textContent = now < until && text !== null ? text : "";
      el.classList.toggle("show", now < until && text !== null);
    };
    const app = createApp({
      core,
      renderer,
      ai: timedAi,
      mode: "ai",
      aiInstant: false,
      aiStepIntervalMs: 500,
      onStats: (s) => {
        shell.score.textContent = String(s.score);
        shell.lines.textContent = String(s.lines);
        shell.level.textContent = String(s.level);
        shell.aiThink.textContent =
          thinkCount === 0 ? "-" : `${(thinkTotal / thinkCount).toFixed(1)}ms`;
        const cur = app.getMode();
        const brain = cur === "versus" ? timedVersus : timedAi;
        const debug =
          brain !== null && typeof brain.getDebug === "function"
            ? (brain.getDebug() as AiDebug | null)
            : null;
        shell.hudBody.innerHTML = hudHtml("SCORE🛡️", debug);
        shell.hud2Body.innerHTML = `MODE ${cur}<br>脳 ${app.getAiName()}`;
      },
    });
    attachInput(window, core);
    const btns = shell.modeButtons;
    const sync = (): void => {
      const cur = app.getMode();
      (Object.keys(btns) as PlayMode[]).forEach((k) =>
        btns[k]?.classList.toggle("active", k === cur),
      );
      shell.instantButton.textContent = app.isAiInstant() ? "瞬間配置:ON" : "ゆっくり再生:ON";
      shell.instantButton.classList.toggle("active", !app.isAiInstant());
      shell.pauseButton.textContent = app.isPaused() ? "再開" : "一時停止";
      shell.pauseButton.classList.toggle("active", app.isPaused());
      for (const b of shell.speedButtons) {
        b.classList.toggle("active", Number(b.dataset["ms"]) === app.getStepIntervalMs());
      }
    };
    (Object.keys(btns) as PlayMode[]).forEach((k) =>
      btns[k]?.addEventListener("click", () => {
        const next = k;
        if (next === "versus") {
          showVersus(true);
          startVersusLoop();
          renderVersusLog(logList, versusRows);
          app.setMode(next);
          sync();
          return;
        }
        showVersus(false);
        stopVersusLoop();
        app.setAi(timedAi);
        app.setMode(next);
        sync();
      }),
    );
    document.getElementById("btn-reset")?.addEventListener("click", () => {
      thinkTotal = 0;
      thinkCount = 0;
      if (app.getMode() === "versus" && versusCtrl !== null) {
        versusCtrl.resetMatch((Date.now() ^ (Math.random() * 1e9)) | 0);
        versusLastResult = null;
        return;
      }
      app.reset();
    });
    shell.instantButton.addEventListener("click", () => {
      app.setAiInstant(!app.isAiInstant());
      sync();
    });
    shell.pauseButton.addEventListener("click", () => {
      app.setPaused(!app.isPaused());
      sync();
    });
    shell.stepButton.addEventListener("click", () => {
      app.stepOnce();
      sync();
    });
    for (const b of shell.speedButtons) {
      b.addEventListener("click", () => {
        app.setAiInstant(false);
        app.setStepIntervalMs(Number(b.dataset["ms"]));
        app.setPaused(false);
        sync();
      });
    }
    shell.vsRematch.addEventListener("click", () => {
      if (versusCtrl !== null) {
        versusCtrl.resetMatch((Date.now() ^ (Math.random() * 1e9)) | 0);
        versusLastResult = null;
      }
    });
    for (const b of shell.vsSpeeds) {
      b.addEventListener("click", () => {
        versusOptions = { ...versusOptions, stepIntervalMs: Number(b.dataset["ms"]) };
        app.setPaused(false);
        syncSpeeds();
      });
    }
    shell.csvButton.addEventListener("click", () => {
      const header = "no,winner,reason,pieces,lines,sent,wins";
      const lines = versusRows.map((r) =>
        [r.no, r.winner, r.reason, r.pieces, r.lines, r.sent, r.wins].join(","),
      );
      const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "versus-log.csv";
      a.click();
      URL.revokeObjectURL(url);
    });
    shell.clearLogButton.addEventListener("click", () => {
      versusRows.length = 0;
      versusMatchNo = 0;
      renderVersusLog(logList, versusRows);
    });
    sync();
    (root as HTMLElement & { __app?: unknown }).__app = app;
  } catch (e) {
    document.getElementById("app")?.replaceChildren(document.createTextNode(String(e)));
    throw e;
  }
}

void boot();

void boot();
function hudHtml(title: string, debug: AiDebug | null): string {
  if (debug === null) return `${title}<br>-`;
  const rows: string[] = [
    title,
    `eval <b>${debug.score.toFixed(0)}</b>`,
    `fire <b>${debug.fireScore.toFixed(0)}</b>`,
    `lines+${debug.linesCleared}${debug.isTspin ? " TSPIN!" : ""}`,
    debug.opener === null ? "" : `opener ${debug.opener}`,
    `holes ${debug.topHoles} / h${debug.topMaxHeight}`,
    `think ${debug.thinkMs.toFixed(1)}ms`,
  ];
  return rows.filter((r) => r !== "").join("<br>");
}

function paintMeter(el: HTMLElement, pending: number): void {
  const pct = Math.min(100, (pending / 12) * 100);
  el.style.width = `${pct}%`;
  el.textContent = pending > 0 ? `${pending}` : "";
  el.classList.toggle("hot", pending >= 6);
}

function versusHudHtml(
  side: import("./versus/controller.js").VersusController["left"],
  snap: import("./ui/types.js").GameSnapshot,
): string {
  const avg = side.thinkCount === 0 ? "-" : `${(side.thinkMs / side.thinkCount).toFixed(1)}ms`;
  const debug = side.fighter.getDebug?.() ?? null;
  const fire = debug === null ? "" : `<br>fire ${debug.fireScore.toFixed(0)}`;
  const tspin = debug?.isTspin === true ? " TSPIN!" : "";
  const opener = debug?.opener == null ? "" : `<br>${debug.opener}`;
  return (
    `${side.fighter.name}<br>` +
    `wins ${side.wins}<br>` +
    `lines ${snap.lines} / sent ${side.sentTotal}${fire}${tspin}${opener}<br>` +
    `combo ${snap.combo} ${snap.b2b ? "B2B" : ""} / 予告 ${snap.pendingGarbage}<br>` +
    `think ${avg}`
  );
}

function renderVersusLog(
  list: HTMLElement,
  rows: ReadonlyArray<{
    readonly no: number;
    readonly winner: string;
    readonly reason: string;
    readonly pieces: number;
    readonly lines: string;
    readonly sent: string;
    readonly wins: string;
  }>,
): void {
  list.innerHTML = "";
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "log-row";
    row.innerHTML =
      `<span class="log-gen">#${r.no}</span> ` +
      `<span class="log-win">${r.winner}</span> ` +
      `<span class="log-detail">${r.reason}</span><br>` +
      `<span class="log-detail">lines ${r.lines} / sent ${r.sent} / ${r.pieces}pcs</span><br>` +
      `<span class="log-detail">通算 ${r.wins}</span>`;
    list.append(row);
  }
  if (rows.length === 0) {
    list.textContent = "AI対戦を開始。おじゃまを送り合ってKO勝ちを狙え。";
  }
}
