//! Painting helpers for the spectator window: boards, active/ghost pieces and
//! hold/next previews, using the web renderer's palette
//! (`src/ui/renderer.ts` `PALETTE`).

use eframe::egui::{
    self, Color32, CornerRadius, Painter, Rect, Sense, Stroke, StrokeKind, Ui, Vec2,
};
use game::{COLS, GameSnapshot, PieceKind, ROWS, cells_for, piece_cell_value};

/// Board cell size in points; the web renderer's canvas is 22 px per cell.
pub const CELL: f32 = 20.0;

const BOARD_BG: Color32 = Color32::from_rgb(0x0b, 0x10, 0x20);
const GRID_LINE: Color32 = Color32::from_rgb(0x18, 0x21, 0x38);
const GHOST: Color32 = Color32::from_rgba_premultiplied(0x60, 0x6c, 0x8c, 0x55);

fn rgb(hex: u32) -> Color32 {
    Color32::from_rgb((hex >> 16) as u8, (hex >> 8) as u8, hex as u8)
}

/// `src/ui/renderer.ts` `PALETTE` (fill, edge) by `CellValue`.
fn palette(value: u8) -> Option<(Color32, Color32)> {
    match value {
        1 => Some((rgb(0x22d3ee), rgb(0x0e7490))),
        2 => Some((rgb(0xfacc15), rgb(0xa16207))),
        3 => Some((rgb(0xc084fc), rgb(0x7e22ce))),
        4 => Some((rgb(0x4ade80), rgb(0x15803d))),
        5 => Some((rgb(0xf87171), rgb(0xb91c1c))),
        6 => Some((rgb(0x60a5fa), rgb(0x1d4ed8))),
        7 => Some((rgb(0xfb923c), rgb(0xc2410c))),
        8 => Some((rgb(0x64748b), rgb(0x334155))),
        _ => None,
    }
}

fn cell_rect(origin: egui::Pos2, x: i32, y: i32, size: f32) -> Rect {
    Rect::from_min_size(
        origin + Vec2::new(x as f32 * size, y as f32 * size),
        Vec2::splat(size),
    )
}

fn paint_mino(painter: &Painter, rect: Rect, value: u8) {
    let Some((fill, edge)) = palette(value) else {
        return;
    };
    let inner = rect.shrink(1.0);
    painter.rect_filled(inner, CornerRadius::same(2), fill);
    painter.rect_stroke(
        inner,
        CornerRadius::same(2),
        Stroke::new(1.0, edge),
        StrokeKind::Inside,
    );
}

/// One full playfield with active piece and ghost, sized [`COLS`] x [`ROWS`].
pub fn board(ui: &mut Ui, snapshot: &GameSnapshot) {
    let size = Vec2::new(COLS as f32 * CELL, ROWS as f32 * CELL);
    let (response, painter) = ui.allocate_painter(size, Sense::hover());
    let rect = response.rect;
    painter.rect_filled(rect, CornerRadius::same(4), BOARD_BG);

    for y in 0..ROWS {
        for x in 0..COLS {
            let value = snapshot.board.grid[y][x];
            if value != 0 {
                paint_mino(
                    &painter,
                    cell_rect(rect.min, x as i32, y as i32, CELL),
                    value,
                );
            }
        }
    }
    for x in 0..=COLS {
        let px = rect.min.x + x as f32 * CELL;
        painter.line_segment(
            [egui::pos2(px, rect.min.y), egui::pos2(px, rect.max.y)],
            Stroke::new(0.5, GRID_LINE),
        );
    }
    for y in 0..=ROWS {
        let py = rect.min.y + y as f32 * CELL;
        painter.line_segment(
            [egui::pos2(rect.min.x, py), egui::pos2(rect.max.x, py)],
            Stroke::new(0.5, GRID_LINE),
        );
    }

    let Some(active) = &snapshot.active else {
        return;
    };
    if let Some(ghost_y) = snapshot.ghost_y {
        for cell in active.cells {
            let gy = ghost_y + cell.y;
            if gy >= 0 {
                painter.rect_stroke(
                    cell_rect(rect.min, active.pos_x + cell.x, gy, CELL).shrink(1.0),
                    CornerRadius::same(2),
                    Stroke::new(1.0, GHOST),
                    StrokeKind::Inside,
                );
            }
        }
    }
    let value = piece_cell_value(active.kind);
    for cell in active.cells {
        let gy = active.pos_y + cell.y;
        if gy >= 0 {
            paint_mino(
                &painter,
                cell_rect(rect.min, active.pos_x + cell.x, gy, CELL),
                value,
            );
        }
    }
}

/// A single piece in its spawn rotation, centered in a fixed 4x3 box.
pub fn piece(ui: &mut Ui, kind: PieceKind, cell: f32) {
    let size = Vec2::new(cell * 4.0, cell * 3.0);
    let (response, painter) = ui.allocate_painter(size, Sense::hover());
    paint_piece(&painter, response.rect, kind, cell);
}

fn paint_piece(painter: &Painter, rect: Rect, kind: PieceKind, cell: f32) {
    let cells = cells_for(kind, 0);
    let mut min_x = i32::MAX;
    let mut max_x = i32::MIN;
    let mut min_y = i32::MAX;
    let mut max_y = i32::MIN;
    for c in cells {
        min_x = min_x.min(c.x);
        max_x = max_x.max(c.x);
        min_y = min_y.min(c.y);
        max_y = max_y.max(c.y);
    }
    let width = (max_x - min_x + 1) as f32 * cell;
    let height = (max_y - min_y + 1) as f32 * cell;
    let origin = rect.center() - Vec2::new(width / 2.0, height / 2.0);
    let value = piece_cell_value(kind);
    for c in cells {
        paint_mino(
            painter,
            cell_rect(origin, c.x - min_x, c.y - min_y, cell),
            value,
        );
    }
}

/// `HOLD` slot: the held piece, or an empty box.
pub fn hold(ui: &mut Ui, held: Option<PieceKind>) {
    match held {
        Some(kind) => piece(ui, kind, 14.0),
        None => empty_slot(ui, 14.0),
    }
}

/// Next-queue preview: up to `count` pieces, left to right.
pub fn next_queue(ui: &mut Ui, queue: &[PieceKind], count: usize) {
    for kind in queue.iter().take(count) {
        piece(ui, *kind, 12.0);
    }
}

fn empty_slot(ui: &mut Ui, cell: f32) {
    let size = Vec2::new(cell * 4.0, cell * 3.0);
    let (response, painter) = ui.allocate_painter(size, Sense::hover());
    painter.rect_stroke(
        response.rect.shrink(1.0),
        CornerRadius::same(2),
        Stroke::new(1.0, GRID_LINE),
        StrokeKind::Inside,
    );
}
