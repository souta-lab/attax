import {
  type BoardView,
  type CellValue,
  COLS,
  type GameSnapshot,
  type PieceKind,
  ROWS,
} from "./types.js";

export interface RendererHandle {
  render(snapshot: GameSnapshot): void;
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
] as const;

function colorFor(cell: CellValue): PaletteEntry {
  const entry = PALETTE[cell];
  if (entry === undefined) return PALETTE[0] as PaletteEntry;
  return entry;
}

/** View-only mini shapes for hold/next previews (display only, no rules). */
const MINI_CELLS: Record<PieceKind, readonly (readonly [number, number])[]> = {
  I: [
    [0, 1],
    [1, 1],
    [2, 1],
    [3, 1],
  ],
  O: [
    [1, 0],
    [2, 0],
    [1, 1],
    [2, 1],
  ],
  T: [
    [1, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ],
  S: [
    [1, 0],
    [2, 0],
    [0, 1],
    [1, 1],
  ],
  Z: [
    [0, 0],
    [1, 0],
    [1, 1],
    [2, 1],
  ],
  J: [
    [0, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ],
  L: [
    [2, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ],
};

function setupCanvas(
  canvas: HTMLCanvasElement,
  w: number,
  h: number,
): CanvasRenderingContext2D | null {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function drawCell(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  size: number,
  fill: string,
  edge: string,
  ghost: boolean,
): void {
  if (ghost) {
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(px + 1.5, py + 1.5, size - 3, size - 3);
    return;
  }
  ctx.fillStyle = fill;
  ctx.fillRect(px + 1, py + 1, size - 2, size - 2);
  ctx.strokeStyle = edge;
  ctx.lineWidth = 1;
  ctx.strokeRect(px + 1.5, py + 1.5, size - 3, size - 3);
  // neon top highlight (cheap, no shadowBlur for 60fps)
  ctx.fillStyle = "rgba(255,255,255,0.25)";
  ctx.fillRect(px + 2, py + 2, size - 4, 3);
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
      const v = row[x] ?? 0;
      const px = originX + x * cell;
      const py = originY + y * cell;
      if (v === 0) {
        ctx.fillStyle = "rgba(255,255,255,0.03)";
        ctx.fillRect(px + 1, py + 1, cell - 2, cell - 2);
      } else {
        const c = colorFor(v);
        drawCell(ctx, px, py, cell, c.fill, c.edge, false);
      }
    }
  }
}

function drawMini(
  ctx: CanvasRenderingContext2D,
  kind: PieceKind | null,
  w: number,
  h: number,
  dimmed: boolean,
): void {
  ctx.clearRect(0, 0, w, h);
  if (kind === null) {
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.font = "11px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("—", w / 2, h / 2 + 4);
    return;
  }
  const cells = MINI_CELLS[kind];
  const s = 14;
  const ox = w / 2 - 2 * s;
  const oy = h / 2 - s;
  const c = colorFor(pieceKindToCell(kind));
  ctx.globalAlpha = dimmed ? 0.3 : 1;
  for (const [cx, cy] of cells) {
    drawCell(ctx, ox + cx * s, oy + cy * s, s, c.fill, c.edge, false);
  }
  ctx.globalAlpha = 1;
}

function pieceKindToCell(kind: PieceKind): CellValue {
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

export function createBoardOnlyRenderer(
  boardCanvas: HTMLCanvasElement,
  cell = 22,
): {
  renderBoard(snapshot: GameSnapshot): void;
} {
  const boardW = COLS * cell;
  const boardH = ROWS * cell;
  const ctx = setupCanvas(boardCanvas, boardW, boardH);
  if (ctx === null) throw new Error("Canvas 2D context unavailable");
  const boardCtx: CanvasRenderingContext2D = ctx;
  return {
    renderBoard(snapshot: GameSnapshot): void {
      boardCtx.fillStyle = "#0b1020";
      boardCtx.fillRect(0, 0, boardW, boardH);
      drawBoard(boardCtx, snapshot.board, cell, 0, 0);
      const active = snapshot.active;
      if (active !== null) {
        const c = colorFor(pieceKindToCell(active.kind));
        if (snapshot.ghostY !== null) {
          for (const cellPos of active.cells) {
            const gx = active.posX + cellPos.x;
            const gy = snapshot.ghostY + cellPos.y;
            if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS) continue;
            drawCell(boardCtx, gx * cell, gy * cell, cell, c.fill, c.edge, true);
          }
        }
        for (const cellPos of active.cells) {
          const ax = active.posX + cellPos.x;
          const ay = active.posY + cellPos.y;
          if (ax < 0 || ax >= COLS || ay < 0 || ay >= ROWS) continue;
          drawCell(boardCtx, ax * cell, ay * cell, cell, c.fill, c.edge, false);
        }
      }
      boardCtx.strokeStyle = "rgba(148,163,184,0.08)";
      boardCtx.lineWidth = 1;
      boardCtx.beginPath();
      for (let x = 1; x < COLS; x += 1) {
        boardCtx.moveTo(x * cell + 0.5, 0);
        boardCtx.lineTo(x * cell + 0.5, boardH);
      }
      for (let y = 1; y < ROWS; y += 1) {
        boardCtx.moveTo(0, y * cell + 0.5);
        boardCtx.lineTo(boardW, y * cell + 0.5);
      }
      boardCtx.stroke();
      if (snapshot.gameOver) {
        boardCtx.fillStyle = "rgba(2,6,23,0.72)";
        boardCtx.fillRect(0, 0, boardW, boardH);
        boardCtx.fillStyle = "#f87171";
        boardCtx.font = "bold 20px system-ui";
        boardCtx.textAlign = "center";
        boardCtx.fillText("DEAD", boardW / 2, boardH / 2);
      }
    },
  };
}

export function createRenderer(
  boardCanvas: HTMLCanvasElement,
  holdCanvas: HTMLCanvasElement,
  nextCanvas: HTMLCanvasElement,
): RendererHandle {
  const CELL = 28;
  const boardW = COLS * CELL;
  const boardH = ROWS * CELL;
  const sideW = 96;
  const sideH = 64;

  const bctx = setupCanvas(boardCanvas, boardW, boardH);
  const hctx = setupCanvas(holdCanvas, sideW, sideH);
  const nctx = setupCanvas(nextCanvas, sideW, sideH * 2);

  if (bctx === null || hctx === null || nctx === null) {
    throw new Error("Canvas 2D context unavailable");
  }
  const boardCtx: CanvasRenderingContext2D = bctx;
  const holdCtx: CanvasRenderingContext2D = hctx;
  const nextCtx: CanvasRenderingContext2D = nctx;

  return {
    render(snapshot: GameSnapshot): void {
      // board bg
      boardCtx.fillStyle = "#0b1020";
      boardCtx.fillRect(0, 0, boardW, boardH);
      drawBoard(boardCtx, snapshot.board, CELL, 0, 0);

      const active = snapshot.active;
      if (active !== null) {
        const c = colorFor(pieceKindToCell(active.kind));
        // ghost
        if (snapshot.ghostY !== null) {
          for (const cellPos of active.cells) {
            const gx = active.posX + cellPos.x;
            const gy = snapshot.ghostY + cellPos.y;
            if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS) continue;
            drawCell(boardCtx, gx * CELL, gy * CELL, CELL, c.fill, c.edge, true);
          }
        }
        // active
        for (const cellPos of active.cells) {
          const ax = active.posX + cellPos.x;
          const ay = active.posY + cellPos.y;
          if (ax < 0 || ax >= COLS || ay < 0 || ay >= ROWS) continue;
          drawCell(boardCtx, ax * CELL, ay * CELL, CELL, c.fill, c.edge, false);
        }
      }

      // grid lines (cheap)
      boardCtx.strokeStyle = "rgba(148,163,184,0.08)";
      boardCtx.lineWidth = 1;
      boardCtx.beginPath();
      for (let x = 1; x < COLS; x += 1) {
        boardCtx.moveTo(x * CELL + 0.5, 0);
        boardCtx.lineTo(x * CELL + 0.5, boardH);
      }
      for (let y = 1; y < ROWS; y += 1) {
        boardCtx.moveTo(0, y * CELL + 0.5);
        boardCtx.lineTo(boardW, y * CELL + 0.5);
      }
      boardCtx.stroke();

      if (snapshot.gameOver) {
        boardCtx.fillStyle = "rgba(2,6,23,0.72)";
        boardCtx.fillRect(0, 0, boardW, boardH);
        boardCtx.fillStyle = "#f87171";
        boardCtx.font = "bold 22px system-ui";
        boardCtx.textAlign = "center";
        boardCtx.fillText("GAME OVER", boardW / 2, boardH / 2);
      }

      // hold
      holdCtx.fillStyle = "#0b1020";
      holdCtx.fillRect(0, 0, sideW, sideH);
      drawMini(holdCtx, snapshot.hold, sideW, sideH, !snapshot.canHold);

      // next (up to 3 stacked)
      nextCtx.fillStyle = "#0b1020";
      nextCtx.fillRect(0, 0, sideW, sideH * 2);
      const shown = snapshot.next.slice(0, 3);
      shown.forEach((kind, i) => {
        const cells = MINI_CELLS[kind];
        const s = 12;
        const ox = sideW / 2 - 2 * s;
        const oy = 8 + i * 38;
        const cc = colorFor(pieceKindToCell(kind));
        for (const [cx, cy] of cells) {
          drawCell(nextCtx, ox + cx * s, oy + cy * s, s, cc.fill, cc.edge, false);
        }
      });
    },
  };
}
