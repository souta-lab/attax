/**
 * The live arena section: both AIs on the same seed, rendered from frames posted by the
 * arena worker, with the bot's candidate moves and evaluation shown as it plays.
 */
import { BRAND } from "../brand.js";
import { RESULTS } from "../data/results.js";
import type { ArenaFrame, Side, SideFrame } from "../sim/arena.js";
import type { ArenaCommand } from "./arena-worker.js";
import { drawBoard, drawQueue, PALETTES, type Palette } from "./board-view.js";
import { actionLabel, boardCell, fixed, h } from "./dom.js";

const FEATURE_LABELS: Readonly<Record<string, string>> = {
  maxHeight: "Stack height",
  danger: "Danger zone",
  holes: "Holes",
  holeCover: "Blocks over holes",
  holeRows: "Rows with holes",
  bumpiness: "Bumpiness",
  bumpinessSq: "Jaggedness",
  rowTransitions: "Row transitions",
  wellDepth: "Well depth",
  extraWells: "Extra wells",
  tSlot: "T-slot ready",
};

const SPEEDS: readonly { label: string; value: number }[] = [
  { label: "½×", value: 0.5 },
  { label: "1×", value: 1 },
  { label: "2×", value: 2 },
  { label: "Max", value: 0 },
];

interface FighterDom {
  readonly root: HTMLElement;
  readonly name: HTMLElement;
  readonly seat: HTMLElement;
  readonly board: HTMLCanvasElement;
  readonly hold: HTMLCanvasElement;
  readonly next: HTMLCanvasElement;
  readonly meter: HTMLElement;
  readonly toast: HTMLElement;
  readonly sent: HTMLElement;
  readonly lines: HTMLElement;
  readonly app: HTMLElement;
  readonly ms: HTMLElement;
  lastPieces: number;
}

function fighterDom(palette: "bot" | "rival"): FighterDom {
  const board = h("canvas", { class: "board" });
  const hold = h("canvas", { class: "queue" });
  const next = h("canvas", { class: "queue" });
  const meter = h("div", { class: "meter-fill" });
  const toast = h("div", { class: "toast" });
  const name = h("span", { class: "fighter-name" });
  const seat = h("span", { class: "seat" });
  const stat = (label: string): [HTMLElement, HTMLElement] => {
    const value = h("strong", { text: "0" });
    return [h("div", { class: "stat" }, [h("span", { text: label }), value]), value];
  };
  const [sentBox, sent] = stat("Sent");
  const [linesBox, lines] = stat("Lines");
  const [appBox, app] = stat("Attack / piece");
  const [msBox, ms] = stat("ms / move");
  const root = h("div", { class: `fighter ${palette}` }, [
    h("div", { class: "fighter-head" }, [name, seat]),
    h("div", { class: "field" }, [
      h("div", { class: "side-col" }, [h("span", { class: "label", text: "Hold" }), hold]),
      h("div", { class: "board-wrap" }, [board, toast]),
      h("div", { class: "meter", attrs: { title: "Incoming garbage" } }, [meter]),
      h("div", { class: "side-col" }, [h("span", { class: "label", text: "Next" }), next]),
    ]),
    h("div", { class: "stats" }, [sentBox, linesBox, appBox, msBox]),
  ]);
  return { root, name, seat, board, hold, next, meter, toast, sent, lines, app, ms, lastPieces: 0 };
}

function renderFighter(
  dom: FighterDom,
  f: SideFrame,
  palette: Palette,
  cell: number,
  botSeat: boolean,
  over: boolean,
): void {
  const candidates = !over && f.thinking !== null ? f.thinking.candidates.map((c) => c.cells) : [];
  drawBoard(
    dom.board,
    { grid: f.grid, active: over ? null : f.active, candidates, dimmed: f.gameOver },
    palette,
    cell,
  );
  drawQueue(dom.hold, [f.hold], palette, cell * 0.7, 1);
  drawQueue(dom.next, f.next, palette, cell * 0.7, 5);
  dom.sent.textContent = String(f.sent);
  dom.lines.textContent = String(f.lines);
  dom.app.textContent = f.pieces > 0 ? fixed(f.sent / f.pieces) : "–";
  dom.ms.textContent = f.msPerMove > 0 ? f.msPerMove.toFixed(0) : "–";
  dom.meter.style.height = `${Math.min(100, (f.pending / 12) * 100)}%`;
  dom.seat.textContent = botSeat ? "the bot" : "the rival";
  if (f.pieces !== dom.lastPieces) {
    dom.lastPieces = f.pieces;
    const label = actionLabel(f.lastAction);
    if (label !== "" && f.lastAction !== "Single") {
      dom.toast.textContent = f.lastAttack > 0 ? `${label} · ${f.lastAttack}` : label;
      dom.toast.classList.remove("show");
      void dom.toast.offsetWidth;
      dom.toast.classList.add("show");
    }
  }
}

export interface ArenaView {
  readonly root: HTMLElement;
  /** Load a seed (and the bot's seat) into the arena and start playing it. */
  load(seed: number, botSide: Side): void;
}

export function createArenaView(): ArenaView {
  const worker = new Worker(new URL("./arena-worker.ts", import.meta.url), { type: "module" });
  const bot = fighterDom("bot");
  const rival = fighterDom("rival");
  bot.name.textContent = BRAND.botName;
  rival.name.textContent = BRAND.rivalName;

  const tugBot = h("div", { class: "tug-bot" });
  const tugRival = h("div", { class: "tug-rival" });
  const scoreBot = h("strong", { class: "bot-ink", text: "0" });
  const scoreRival = h("strong", { class: "rival-ink", text: "0" });
  const piece = h("span", { class: "piece-count", text: "Piece 0" });
  const banner = h("div", { class: "banner" });
  const center = h("div", { class: "center" }, [
    h("span", { class: "label", text: "Garbage sent" }),
    h("div", { class: "tally" }, [scoreBot, h("span", { text: "–" }), scoreRival]),
    h("div", { class: "tug" }, [tugBot, tugRival]),
    piece,
    banner,
  ]);

  // "Watch it think" panel.
  const thinkHead = h("p", { class: "think-head" });
  const candidateList = h("ol", { class: "candidates" });
  const breakdown = h("div", { class: "breakdown" });
  const thinking = h("aside", { class: "thinking" }, [
    h("h3", { text: `How ${BRAND.botName} chose this move` }),
    thinkHead,
    h("p", {
      class: "fine",
      text: "Outlined on its board: the chosen placement (solid) and the next-best two (dashed). Value = best line found starting with that move.",
    }),
    candidateList,
    h("p", { class: "fine", text: "Board terms after the move (weighted points):" }),
    breakdown,
  ]);

  // Controls.
  const seedLabel = h("span", { class: "seed" });
  const record = h("p", { class: "record" });
  const prev = h("button", { text: "← Prev game", attrs: { type: "button" } });
  const nextBtn = h("button", { text: "Next game →", attrs: { type: "button" } });
  const random = h("button", { text: "Fresh seed", attrs: { type: "button" } });
  const swap = h("button", { text: "Swap seats", attrs: { type: "button" } });
  const pause = h("button", { text: "Pause", attrs: { type: "button" } });
  const restart = h("button", { text: "Restart", attrs: { type: "button" } });
  const speedButtons = SPEEDS.map((s) => {
    const b = h("button", { text: s.label, attrs: { type: "button", "aria-pressed": "false" } });
    b.addEventListener("click", () => setSpeed(s.value));
    return b;
  });
  const controls = h("div", { class: "controls" }, [
    h("div", { class: "group" }, [prev, seedLabel, nextBtn, random]),
    h("div", { class: "group" }, [swap, pause, restart]),
    h("div", { class: "group speed" }, [
      h("span", { class: "label", text: "Speed" }),
      ...speedButtons,
    ]),
  ]);

  const boards = h("div", { class: "boards" });
  const root = h("div", { class: "arena" }, [controls, boards, record, thinking]);

  let seed = RESULTS.games[0]?.[0] ?? 1001;
  let botSide: Side = "left";
  let speed = 1;
  let paused = false;
  let latest: ArenaFrame | null = null;
  let drawn: ArenaFrame | null = null;

  function layout(): void {
    boards.replaceChildren(
      botSide === "left" ? bot.root : rival.root,
      center,
      botSide === "left" ? rival.root : bot.root,
    );
  }

  function recorded(): (typeof RESULTS.games)[number] | undefined {
    const seat = botSide === "left" ? 0 : 1;
    return RESULTS.games.find((g) => g[0] === seed && g[1] === seat);
  }

  function describeRecord(frame: ArenaFrame | null): void {
    const r = recorded();
    if (r === undefined) {
      record.textContent = `Seed ${seed} is not part of the benchmark — a fresh game.`;
      record.className = "record";
      return;
    }
    const outcome =
      r[2] === 1 ? `${BRAND.botName} won` : r[2] === 0 ? `${BRAND.rivalName} won` : "draw";
    const base = `Benchmark record for this game: ${outcome} at tick ${r[3]} (garbage ${r[4]}–${r[5]}).`;
    if (frame === null || frame.winner === null) {
      record.textContent = `${base} Watch it replay live.`;
      record.className = "record";
      return;
    }
    const botWon = frame.winner === botSide;
    const liveResult = frame.winner === "draw" ? 2 : botWon ? 1 : 0;
    const match = liveResult === r[2] && frame.ticks === r[3];
    record.textContent = match
      ? `${base} Live replay: identical — same winner, same tick.`
      : `${base} Live replay ended differently (tick ${frame.ticks}).`;
    record.className = match ? "record ok" : "record warn";
  }

  function start(): void {
    paused = false;
    pause.textContent = "Pause";
    latest = null;
    drawn = null;
    bot.lastPieces = 0;
    rival.lastPieces = 0;
    seedLabel.textContent = `Seed ${seed} · ${BRAND.botName} ${botSide === "left" ? "left" : "right"}`;
    layout();
    describeRecord(null);
    const command: ArenaCommand = { type: "start", seed, botSide, speed };
    worker.postMessage(command);
  }

  function setSpeed(value: number): void {
    speed = value;
    SPEEDS.forEach((s, i) =>
      speedButtons[i]?.setAttribute("aria-pressed", String(s.value === value)),
    );
    worker.postMessage({ type: "speed", speed } satisfies ArenaCommand);
  }

  function step(delta: number): void {
    const index = RESULTS.games.findIndex(
      (g) => g[0] === seed && g[1] === (botSide === "left" ? 0 : 1),
    );
    const list = RESULTS.games;
    if (list.length === 0) return;
    const nextIndex = index < 0 ? 0 : (index + delta + list.length) % list.length;
    const g = list[nextIndex];
    if (g === undefined) return;
    seed = g[0];
    botSide = g[1] === 0 ? "left" : "right";
    start();
  }

  prev.addEventListener("click", () => step(-1));
  nextBtn.addEventListener("click", () => step(1));
  random.addEventListener("click", () => {
    seed = 100000 + Math.floor(Math.random() * 900000);
    start();
  });
  swap.addEventListener("click", () => {
    botSide = botSide === "left" ? "right" : "left";
    start();
  });
  restart.addEventListener("click", start);
  pause.addEventListener("click", () => {
    paused = !paused;
    pause.textContent = paused ? "Resume" : "Pause";
    worker.postMessage({ type: "pause", paused } satisfies ArenaCommand);
  });

  worker.onmessage = (event: MessageEvent<{ type: "frame"; frame: ArenaFrame }>) => {
    latest = event.data.frame;
    if (latest.winner !== null) describeRecord(latest);
  };

  function renderThinking(f: SideFrame): void {
    const t = f.thinking;
    if (t === null) return;
    thinkHead.textContent = `Searched ${t.nodes.toLocaleString()} positions, ${t.depth} pieces deep.`;
    candidateList.replaceChildren(
      ...t.candidates.map((c, i) =>
        h("li", { class: i === 0 ? "chosen" : "" }, [
          h("span", { text: i === 0 ? "Chosen" : `Option ${i + 1}` }),
          h("strong", { text: c.value.toFixed(0) }),
        ]),
      ),
    );
    const terms = Object.entries(t.breakdown)
      .filter(([, v]) => Math.abs(v) >= 0.5)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, 6);
    const max = Math.max(1, ...terms.map(([, v]) => Math.abs(v)));
    breakdown.replaceChildren(
      ...terms.map(([k, v]) =>
        h("div", { class: "term" }, [
          h("span", { text: FEATURE_LABELS[k] ?? k }),
          h("div", { class: "bar" }, [
            h("i", {
              class: v >= 0 ? "pos" : "neg",
              attrs: { style: `width:${((Math.abs(v) / max) * 100).toFixed(1)}%` },
            }),
          ]),
          h("strong", { text: v.toFixed(0) }),
        ]),
      ),
    );
  }

  function frameLoop(): void {
    requestAnimationFrame(frameLoop);
    if (latest === null || latest === drawn) return;
    drawn = latest;
    const f = latest;
    const cell = boardCell();
    const over = f.winner !== null;
    const botFrame = botSide === "left" ? f.left : f.right;
    const rivalFrame = botSide === "left" ? f.right : f.left;
    renderFighter(bot, botFrame, PALETTES.bot, cell, true, over);
    renderFighter(rival, rivalFrame, PALETTES.rival, cell, false, over);
    renderThinking(botFrame);
    scoreBot.textContent = String(botFrame.sent);
    scoreRival.textContent = String(rivalFrame.sent);
    const total = botFrame.sent + rivalFrame.sent;
    const share = total === 0 ? 0.5 : botFrame.sent / total;
    tugBot.style.flexGrow = String(share);
    tugRival.style.flexGrow = String(1 - share);
    piece.textContent = `Piece ${Math.max(botFrame.pieces, rivalFrame.pieces)} · tick ${f.ticks}`;
    if (f.winner === null) {
      banner.textContent = "";
      banner.className = "banner";
    } else {
      const botWon = f.winner === botSide;
      banner.textContent =
        f.winner === "draw" ? "Draw" : `${botWon ? BRAND.botName : BRAND.rivalName} wins`;
      banner.className = `banner show ${f.winner === "draw" ? "" : botWon ? "bot" : "rival"}`;
    }
  }

  setSpeed(1);
  requestAnimationFrame(frameLoop);
  window.addEventListener("resize", () => {
    drawn = null;
  });

  return {
    root,
    load(nextSeed: number, nextSide: Side): void {
      seed = nextSeed;
      botSide = nextSide;
      start();
    },
  };
}
