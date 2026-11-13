/**
 * Canvas drawing for one playfield plus its hold and preview columns. Pieces are drawn in
 * the owning fighter's palette (shades of one hue, distinguishable by piece) rather than a
 * seven-colour scheme, so each board reads at a glance as "whose" board it is.
 */
import type { PieceKind } from "../core/pieces.js";
import { type CellValue, COLS, ROWS, SPAWN_SHAPES } from "../core/types.js";

export interface Palette {
  /** Shades for piece values 1..7 (I, O, T, S, Z, J, L). */
  readonly pieces: readonly string[];
  readonly accent: string;
}

export const PALETTES = {
  bot: {
    accent: "#2450d6",
    pieces: ["#3a63e0", "#7b97ee", "#2340a8", "#5a7de6", "#9db1f2", "#2c52c4", "#6c89ea"],
  },
  rival: {
    accent: "#d4532b",
    pieces: ["#e0663f", "#efa184", "#b2421f", "#e7835f", "#f3b79f", "#c94e27", "#eb916f"],
  },
  ink: {
    accent: "#1f2328",
    pieces: ["#3b4048", "#8a9099", "#22262b", "#5c636d", "#a4aab2", "#2f343a", "#737a84"],
  },
} as const satisfies Record<string, Palette>;

const GARBAGE = "#b9bcc2";
const GRID_LINE = "#e6e3dc";
const FIELD = "#fbfaf7";
const KIND_INDEX: Readonly<Record<PieceKind, number>> = {
  I: 0,
  O: 1,
  T: 2,
  S: 3,
  Z: 4,
  J: 5,
  L: 6,
};

export interface BoardScene {
  readonly grid: readonly (readonly CellValue[])[];
  readonly active?: {
    readonly kind: PieceKind;
    readonly cells: readonly (readonly [number, number])[];
  } | null;
  /** Translucent landing preview of the active piece. */
  readonly ghost?: readonly (readonly [number, number])[] | null;
  /** Outlined candidate placements, best first. */
  readonly candidates?: readonly (readonly (readonly [number, number])[])[];
  readonly dimmed?: boolean;
}

function fitCanvas(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
): CanvasRenderingContext2D {
  const ratio = window.devicePixelRatio || 1;
  const w = Math.round(cssWidth * ratio);
  const h = Math.round(cssHeight * ratio);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
  }
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return ctx;
}

function cellColor(value: CellValue, palette: Palette): string {
  if (value === 8) return GARBAGE;
  return palette.pieces[value - 1] ?? GARBAGE;
}

function block(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
): void {
  const gap = Math.max(1, size * 0.08);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x + gap / 2, y + gap / 2, size - gap, size - gap, size * 0.18);
  ctx.fill();
}

/** Draw a 10x20 field into `canvas`, `cell` CSS pixels per cell. */
export function drawBoard(
  canvas: HTMLCanvasElement,
  scene: BoardScene,
  palette: Palette,
  cell: number,
): void {
  const ctx = fitCanvas(canvas, COLS * cell, ROWS * cell);
  ctx.fillStyle = FIELD;
  ctx.fillRect(0, 0, COLS * cell, ROWS * cell);
  ctx.strokeStyle = GRID_LINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 1; x < COLS; x += 1) {
    ctx.moveTo(x * cell + 0.5, 0);
    ctx.lineTo(x * cell + 0.5, ROWS * cell);
  }
  for (let y = 1; y < ROWS; y += 1) {
    ctx.moveTo(0, y * cell + 0.5);
    ctx.lineTo(COLS * cell, y * cell + 0.5);
  }
  ctx.stroke();

  for (let y = 0; y < ROWS; y += 1) {
    const row = scene.grid[y];
    if (row === undefined) continue;
    for (let x = 0; x < COLS; x += 1) {
      const v = row[x] ?? 0;
      if (v !== 0) block(ctx, x * cell, y * cell, cell, cellColor(v, palette));
    }
  }

  // Candidate placements the AI weighed: best one dashed-bold, the runners-up thin.
  const candidates = scene.candidates ?? [];
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const cells = candidates[i] ?? [];
    ctx.strokeStyle = palette.accent;
    ctx.globalAlpha = i === 0 ? 0.95 : 0.4;
    ctx.lineWidth = i === 0 ? 2 : 1.25;
    ctx.setLineDash(i === 0 ? [] : [3, 3]);
    for (const [x, y] of cells) {
      if (y < 0) continue;
      ctx.strokeRect(x * cell + 2, y * cell + 2, cell - 4, cell - 4);
    }
  }
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  if (scene.ghost) {
    ctx.globalAlpha = 0.18;
    for (const [x, y] of scene.ghost)
      if (y >= 0) block(ctx, x * cell, y * cell, cell, palette.accent);
    ctx.globalAlpha = 1;
  }
  if (scene.active) {
    const color = palette.pieces[KIND_INDEX[scene.active.kind]] ?? palette.accent;
    for (const [x, y] of scene.active.cells)
      if (y >= 0) block(ctx, x * cell, y * cell, cell, color);
  }
  if (scene.dimmed === true) {
    ctx.fillStyle = "rgba(251, 250, 247, 0.72)";
    ctx.fillRect(0, 0, COLS * cell, ROWS * cell);
  }
}

/** Draw a vertical list of pieces (hold box or preview queue). */
export function drawQueue(
  canvas: HTMLCanvasElement,
  pieces: readonly (PieceKind | null)[],
  palette: Palette,
  cell: number,
  slots: number,
  muted = false,
): void {
  const slotH = cell * 3;
  const width = cell * 4.5;
  const ctx = fitCanvas(canvas, width, slotH * slots);
  ctx.clearRect(0, 0, width, slotH * slots);
  pieces.slice(0, slots).forEach((kind, i) => {
    if (kind === null) return;
    const shape = SPAWN_SHAPES[kind];
    let maxX = 0;
    let maxY = 0;
    for (const c of shape) {
      maxX = Math.max(maxX, c.x);
      maxY = Math.max(maxY, c.y);
    }
    const size = i === 0 ? cell : cell * 0.8;
    const ox = (width - (maxX + 1) * size) / 2;
    const oy = i * slotH + (slotH - (maxY + 1) * size) / 2;
    ctx.globalAlpha = muted ? 0.35 : 1;
    const color = palette.pieces[KIND_INDEX[kind]] ?? palette.accent;
    for (const c of shape) block(ctx, ox + c.x * size, oy + c.y * size, size, color);
    ctx.globalAlpha = 1;
  });
}
