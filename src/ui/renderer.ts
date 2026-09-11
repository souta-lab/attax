import {
  type BoardView,
  type CellPos,
  type CellValue,
  COLS,
  type GameSnapshot,
  type PieceKind,
  pieceToCell,
  ROWS,
  SPAWN_SHAPES,
} from "./types.js";

export interface BoardRenderer {
  renderBoard(snapshot: GameSnapshot): void;
  dispose(): void;
}

export interface BoardRendererOptions {
  /** Draws the held piece when provided. */
  readonly holdCanvas?: HTMLCanvasElement | null;
  /** Draws the upcoming queue when provided. */
  readonly nextCanvas?: HTMLCanvasElement | null;
  /** Queue length to draw; defaults to 5. */
  readonly nextCount?: number;
}

interface PaletteEntry {
  readonly fill: string;
  readonly edge: string;
}

const PALETTE: readonly PaletteEntry[] = [
  { fill: "rgba(0,0,0,0)", edge: "rgba(0,0,0,0)" },
  { fill: "#22d3ee", edge: "#0e7490" },
  { fill: "#facc15", edge: "#a16207" },
  { fill: "#c084fc", edge: "#7e22ce" },
  { fill: "#4ade80", edge: "#15803d" },
  { fill: "#f87171", edge: "#b91c1c" },
  { fill: "#60a5fa", edge: "#1d4ed8" },
  { fill: "#fb923c", edge: "#c2410c" },
  { fill: "#64748b", edge: "#334155" },
] as const;

const GARBAGE_CELL: CellValue = 8;
const BOARD_BG = "#0b1020";
const MONO_FONT = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, "DejaVu Sans Mono", monospace';
const DEFAULT_NEXT_COUNT = 5;
const PREVIEW_COLS = 4;
const PREVIEW_ROWS = 3;

function colorFor(cell: CellValue): PaletteEntry {
  const entry = PALETTE[cell];
  if (entry === undefined) return PALETTE[0] as PaletteEntry;
  return entry;
}

interface CanvasSurface {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  readonly ratio: number;
  cssW: number;
  cssH: number;
  dpr: number;
  gen: number;
}

/** Backing-store size follows the element's CSS box and the live DPR. */
function createSurface(
  canvas: HTMLCanvasElement,
  ratio: number,
): { surface: CanvasSurface; cleanup: () => void } | null {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  const surface: CanvasSurface = { canvas, ctx, ratio, cssW: 0, cssH: 0, dpr: 0, gen: 0 };
  resizeSurface(surface, canvas.clientWidth, window.devicePixelRatio || 1);

  const observer = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (entry === undefined) return;
    resizeSurface(surface, entry.contentRect.width, window.devicePixelRatio || 1);
  });
  observer.observe(canvas);
  const onWindowResize = (): void => {
    resizeSurface(surface, canvas.clientWidth, window.devicePixelRatio || 1);
  };
  window.addEventListener("resize", onWindowResize);
  return {
    surface,
    cleanup: (): void => {
      observer.disconnect();
      window.removeEventListener("resize", onWindowResize);
    },
  };
}

function resizeSurface(surface: CanvasSurface, cssWidth: number, rawDpr: number): void {
  if (!(cssWidth > 0)) return;
  const dpr = Math.max(1, rawDpr);
  const cssW = cssWidth;
  const cssH = cssWidth * surface.ratio;
  const backingW = Math.max(1, Math.round(cssW * dpr));
  const backingH = Math.max(1, Math.round(cssH * dpr));
  if (
    backingW === surface.canvas.width &&
    backingH === surface.canvas.height &&
    cssW === surface.cssW &&
    dpr === surface.dpr
  ) {
    return;
  }
  surface.canvas.width = backingW;
  surface.canvas.height = backingH;
  surface.cssW = cssW;
  surface.cssH = cssH;
  surface.dpr = dpr;
  surface.gen += 1;
  surface.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function ensureSized(surface: CanvasSurface): void {
  if (surface.cssW > 0) return;
  resizeSurface(surface, surface.canvas.clientWidth, window.devicePixelRatio || 1);
}

function drawMino(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  size: number,
  fill: string,
  edge: string,
  ghost: boolean,
): void {
  const inset = Math.max(0.75, size * 0.08);
  const stroke = Math.max(0.75, Math.min(1.5, size * 0.07));
  if (ghost) {
    ctx.strokeStyle = edge;
    ctx.lineWidth = stroke;
    ctx.strokeRect(px + inset, py + inset, size - inset * 2, size - inset * 2);
    return;
  }
  ctx.fillStyle = fill;
  ctx.fillRect(px + inset, py + inset, size - inset * 2, size - inset * 2);
  ctx.strokeStyle = edge;
  ctx.lineWidth = stroke;
  ctx.strokeRect(px + inset, py + inset, size - inset * 2, size - inset * 2);
  const highlight = Math.max(1, size * 0.14);
  ctx.fillStyle = "rgba(255,255,255,0.25)";
  ctx.fillRect(px + inset * 2, py + inset * 2, size - inset * 4, highlight);
}

function drawGarbageHatch(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  size: number,
): void {
  const inset = Math.max(1.5, size * 0.16);
  ctx.strokeStyle = "rgba(226,232,240,0.28)";
  ctx.lineWidth = Math.max(0.75, size * 0.06);
  ctx.beginPath();
  ctx.moveTo(px + inset, py + size - inset);
  ctx.lineTo(px + size - inset, py + inset);
  ctx.moveTo(px + size * 0.52, py + size - inset);
  ctx.lineTo(px + size - inset, py + size * 0.52);
  ctx.moveTo(px + inset, py + size * 0.52);
  ctx.lineTo(px + size * 0.52, py + inset);
  ctx.stroke();
}

function drawBoard(
  ctx: CanvasRenderingContext2D,
  board: BoardView,
  cell: number,
  originX: number,
  originY: number,
): void {
  for (let y = 0; y < board.rows; y += 1) {
    const row = board.grid[y];
    if (row === undefined) continue;
    for (let x = 0; x < board.cols; x += 1) {
      const value = row[x] ?? 0;
      const px = originX + x * cell;
      const py = originY + y * cell;
      if (value === 0) {
        ctx.fillStyle = "rgba(255,255,255,0.03)";
        ctx.fillRect(px + 1, py + 1, cell - 2, cell - 2);
        continue;
      }
      const color = colorFor(value);
      drawMino(ctx, px, py, cell, color.fill, color.edge, false);
      if (value === GARBAGE_CELL) drawGarbageHatch(ctx, px, py, cell);
    }
  }
}

function drawGridLines(
  ctx: CanvasRenderingContext2D,
  cell: number,
  originX: number,
  originY: number,
  width: number,
  height: number,
): void {
  ctx.strokeStyle = "rgba(148,163,184,0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 1; x < COLS; x += 1) {
    ctx.moveTo(originX + x * cell + 0.5, originY);
    ctx.lineTo(originX + x * cell + 0.5, originY + height);
  }
  for (let y = 1; y < ROWS; y += 1) {
    ctx.moveTo(originX, originY + y * cell + 0.5);
    ctx.lineTo(originX + width, originY + y * cell + 0.5);
  }
  ctx.stroke();
}

function drawBoardSurface(surface: CanvasSurface, snapshot: GameSnapshot): void {
  const { ctx, cssW, cssH } = surface;
  const board = snapshot.board;
  const cell = Math.min(cssW / board.cols, cssH / board.rows);
  const width = cell * board.cols;
  const height = cell * board.rows;
  const originX = (cssW - width) / 2;
  const originY = (cssH - height) / 2;

  ctx.fillStyle = BOARD_BG;
  ctx.fillRect(0, 0, cssW, cssH);
  drawBoard(ctx, board, cell, originX, originY);

  const active = snapshot.active;
  if (active !== null) {
    const color = colorFor(pieceToCell(active.kind));
    if (snapshot.ghostY !== null) {
      for (const cellPos of active.cells) {
        const gx = active.posX + cellPos.x;
        const gy = snapshot.ghostY + cellPos.y;
        if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS) continue;
        drawMino(ctx, originX + gx * cell, originY + gy * cell, cell, color.fill, color.edge, true);
      }
    }
    for (const cellPos of active.cells) {
      const ax = active.posX + cellPos.x;
      const ay = active.posY + cellPos.y;
      if (ax < 0 || ax >= COLS || ay < 0 || ay >= ROWS) continue;
      drawMino(ctx, originX + ax * cell, originY + ay * cell, cell, color.fill, color.edge, false);
    }
  }

  drawGridLines(ctx, cell, originX, originY, width, height);

  if (snapshot.gameOver) {
    ctx.fillStyle = "rgba(2,6,23,0.74)";
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.fillStyle = "#f87171";
    const size = Math.max(14, Math.round(Math.min(cssW * 0.11, cell * 1.9)));
    ctx.font = `bold ${size}px ${MONO_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("DEAD", cssW / 2, cssH / 2);
  }
}

function boundsOf(cells: readonly CellPos[]): { w: number; h: number } {
  let maxX = 0;
  let maxY = 0;
  for (const cell of cells) {
    if (cell.x > maxX) maxX = cell.x;
    if (cell.y > maxY) maxY = cell.y;
  }
  return { w: maxX + 1, h: maxY + 1 };
}

function drawPreviewPiece(
  ctx: CanvasRenderingContext2D,
  kind: PieceKind,
  slotX: number,
  slotY: number,
  slotW: number,
  slotH: number,
  alpha: number,
): void {
  const cells = SPAWN_SHAPES[kind];
  const { w, h } = boundsOf(cells);
  const size = Math.min(slotW / PREVIEW_COLS, slotH / PREVIEW_ROWS);
  const originX = slotX + (slotW - w * size) / 2;
  const originY = slotY + (slotH - h * size) / 2;
  const color = colorFor(pieceToCell(kind));
  ctx.globalAlpha = alpha;
  for (const cell of cells) {
    drawMino(
      ctx,
      originX + cell.x * size,
      originY + cell.y * size,
      size,
      color.fill,
      color.edge,
      false,
    );
  }
  ctx.globalAlpha = 1;
}

function drawHoldSurface(surface: CanvasSurface, hold: PieceKind | null, canHold: boolean): void {
  const { ctx, cssW, cssH } = surface;
  ctx.clearRect(0, 0, cssW, cssH);
  if (hold === null) {
    ctx.fillStyle = "rgba(138,155,181,0.65)";
    ctx.font = `600 ${Math.max(9, Math.round(cssH * 0.32))}px ${MONO_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("—", cssW / 2, cssH / 2);
    return;
  }
  drawPreviewPiece(ctx, hold, 0, 0, cssW, cssH, canHold ? 1 : 0.32);
}

function drawNextSurface(surface: CanvasSurface, queue: readonly PieceKind[], count: number): void {
  const { ctx, cssW, cssH } = surface;
  ctx.clearRect(0, 0, cssW, cssH);
  const slotW = cssW / count;
  for (let index = 0; index < count; index += 1) {
    const kind = queue[index];
    if (kind === undefined) break;
    drawPreviewPiece(ctx, kind, index * slotW, 0, slotW, cssH, 1);
  }
}

function boardStateKey(snapshot: GameSnapshot): string {
  const rows: string[] = [];
  for (let y = 0; y < snapshot.board.rows; y += 1) {
    const row = snapshot.board.grid[y];
    let line = "";
    for (let x = 0; x < snapshot.board.cols; x += 1) {
      line += String(row?.[x] ?? 0);
    }
    rows.push(line);
  }
  const active = snapshot.active;
  const activeKey =
    active === null ? "none" : `${active.kind}${active.rotation}:${active.posX},${active.posY}`;
  return `${rows.join("/")}#${activeKey}#${snapshot.ghostY ?? "n"}#${snapshot.gameOver ? "x" : "o"}`;
}

export function createBoardOnlyRenderer(
  boardCanvas: HTMLCanvasElement,
  options: BoardRendererOptions = {},
): BoardRenderer {
  const boardTarget = createSurface(boardCanvas, ROWS / COLS);
  if (boardTarget === null) throw new Error("Canvas 2D context unavailable");
  const boardSurface = boardTarget.surface;

  const nextCount = Math.max(1, Math.floor(options.nextCount ?? DEFAULT_NEXT_COUNT));
  const holdTarget =
    options.holdCanvas == null
      ? null
      : createSurface(options.holdCanvas, PREVIEW_ROWS / PREVIEW_COLS);
  const nextTarget =
    options.nextCanvas == null
      ? null
      : createSurface(options.nextCanvas, PREVIEW_ROWS / (PREVIEW_COLS * nextCount));
  const holdSurface = holdTarget?.surface ?? null;
  const nextSurface = nextTarget?.surface ?? null;

  let lastBoardKey: string | null = null;
  let lastBoardGen = -1;
  let lastPreviewKey: string | null = null;
  let lastPreviewGen = -1;
  let lastHoldLabel: string | null = null;
  let lastNextLabel: string | null = null;

  return {
    renderBoard(snapshot: GameSnapshot): void {
      ensureSized(boardSurface);
      const boardGen = boardSurface.gen;
      const boardKey = boardStateKey(snapshot);
      if (boardKey !== lastBoardKey || boardGen !== lastBoardGen) {
        lastBoardKey = boardKey;
        lastBoardGen = boardGen;
        drawBoardSurface(boardSurface, snapshot);
      }

      if (holdSurface === null && nextSurface === null) return;
      if (holdSurface !== null) ensureSized(holdSurface);
      if (nextSurface !== null) ensureSized(nextSurface);
      const previewGen = (holdSurface?.gen ?? 0) * 31 + (nextSurface?.gen ?? 0);
      const previewKey = `${snapshot.hold ?? "-"}${snapshot.canHold ? "+" : "-"}|${snapshot.next
        .slice(0, nextCount)
        .join("")}`;
      if (previewKey !== lastPreviewKey || previewGen !== lastPreviewGen) {
        lastPreviewKey = previewKey;
        lastPreviewGen = previewGen;
        if (holdSurface !== null) drawHoldSurface(holdSurface, snapshot.hold, snapshot.canHold);
        if (nextSurface !== null) drawNextSurface(nextSurface, snapshot.next, nextCount);
      }

      if (holdSurface !== null) {
        const label = `hold: ${snapshot.hold ?? "empty"}${snapshot.canHold ? "" : " (locked)"}`;
        if (label !== lastHoldLabel) {
          lastHoldLabel = label;
          holdSurface.canvas.setAttribute("aria-label", label);
        }
      }
      if (nextSurface !== null) {
        const label = `next: ${snapshot.next.slice(0, nextCount).join(" ") || "empty"}`;
        if (label !== lastNextLabel) {
          lastNextLabel = label;
          nextSurface.canvas.setAttribute("aria-label", label);
        }
      }
    },
    dispose(): void {
      boardTarget.cleanup();
      holdTarget?.cleanup();
      nextTarget?.cleanup();
    },
  };
}
