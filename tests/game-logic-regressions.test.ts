import { describe, expect, test } from "bun:test";
import { createEngine } from "../src/core/engine.js";

// random() => 0.999 makes the shuffle an identity, so bags are
// [I, O, T, S, Z, J, L] and the piece order is fully predictable.
const IDENTITY_SHUFFLE = () => 0.999;

describe("hard-drop scoring", () => {
  test("hardDrop adds 2 per cell fallen", () => {
    const engine = createEngine({ random: IDENTITY_SHUFFLE });
    const before = engine.getSnapshot();
    const active = before.active;
    const ghostY = before.ghostY;
    if (active === null || ghostY === null) throw new Error("expected an active piece");
    const distance = ghostY - active.posY;
    expect(distance).toBeGreaterThan(0);

    engine.hardDrop();

    expect(engine.getSnapshot().score - before.score).toBe(2 * distance);
  });

  test("hardDropAt adds 2 per cell fallen", () => {
    const engine = createEngine({ random: IDENTITY_SHUFFLE });
    const before = engine.getSnapshot();
    const active = before.active;
    const ghostY = before.ghostY;
    if (active === null || ghostY === null) throw new Error("expected an active piece");

    const placed = engine.hardDropAt?.(active.rotation, active.posX) ?? false;

    expect(placed).toBe(true);
    expect(engine.getSnapshot().score - before.score).toBe(2 * (ghostY - active.posY));
  });
});

describe("garbage overflow top-out", () => {
  test("discarding an occupied top row is a top-out", () => {
    const engine = createEngine({ random: IDENTITY_SHUFFLE });
    expect(engine.getSnapshot().active?.kind).toBe("I");

    // Horizontal I occupies row 0 only, leaving row 1 empty. The old shift
    // silently deleted the occupied row; it must now top out.
    expect(engine.placeMinoAt?.(0, 0, -1, 0)).toBe(true);
    expect(engine.getSnapshot().gameOver).toBe(false);

    engine.receiveGarbage?.(1);
    engine.hardDrop();

    expect(engine.getSnapshot().gameOver).toBe(true);
  });
});

describe("lock-out top-out", () => {
  test("locking entirely above the field tops out", () => {
    const engine = createEngine({ random: IDENTITY_SHUFFLE });

    expect(engine.placeMinoAt?.(0, 0, -3, 0)).toBe(true);

    expect(engine.getSnapshot().gameOver).toBe(true);
  });

  test("a fully visible lock does not top out", () => {
    const engine = createEngine({ random: IDENTITY_SHUFFLE });

    expect(engine.placeMinoAt?.(0, 0, 18, 0)).toBe(true);

    expect(engine.getSnapshot().gameOver).toBe(false);
  });
});

describe("native combo break", () => {
  test("negates a live combo on a no-clear lock (binary CalcAtk), 0 stays 0", () => {
    const engine = createEngine({ random: IDENTITY_SHUFFLE });
    const place = (rotation: number, x: number, topRow: number): boolean =>
      engine.placeMinoAt?.(rotation, x, topRow, 0) ?? false;

    expect(place(0, 0, 18)).toBe(true); // I -> bottom row cols 0-3
    expect(place(0, 3, 18)).toBe(true); // O -> cols 4-5
    expect(place(0, 6, 18)).toBe(true); // T -> cols 6-8
    expect(place(3, 8, 17)).toBe(true); // S -> col 9, completes the row

    const afterClear = engine.getSnapshot();
    expect(afterClear.lines).toBe(1);
    expect(afterClear.nativeCombo).toBe(1);

    expect(place(0, 0, 18)).toBe(true); // Z -> locks without clearing

    // Shipping exe `postmove` combo is `-1` here (the binary negates the live
    // combo); the next no-clear lock returns it to 0.
    expect(engine.getSnapshot().nativeCombo).toBe(-1);
    engine.hardDrop(); // second no-clear lock
    expect(engine.getSnapshot().nativeCombo).toBe(0);
  });
});
