import { describe, expect, test } from "bun:test";
import { toBoard } from "../src/ai/deepseek.js";
import { createDeepSeekV2 } from "../src/ai/deepseek-v2.js";
import { bookBoardFingerprint, createOpeningBook } from "../src/ai/opening-book.js";
import { OPENING_BOOK_DATA } from "../src/ai/opening-book-data.js";
import { createBoard } from "../src/core/board.js";
import { createEngine } from "../src/core/engine.js";
import type { AiMove, CorePort } from "../src/ui/types.js";
import { seededRandom } from "../src/versus/controller.js";

const PCO_ROWS: readonly number[] = [0x38f, 0x3cf, 0x38f, 0x30f];

function mirrorRows(rows: readonly number[]): number[] {
  return rows.map((value) => {
    let out = 0;
    for (let x = 0; x < 10; x += 1) if ((value & (1 << x)) !== 0) out |= 1 << (9 - x);
    return out;
  });
}

function rowsFingerprint(rows: readonly number[]): string {
  const board = createBoard(20);
  for (let y = 0; y < rows.length; y += 1) board[y] = rows[y] ?? 0;
  return bookBoardFingerprint(board);
}

function firstBagKey(core: CorePort): string | null {
  const snapshot = core.getSnapshot();
  if (snapshot.active === null) return null;
  return [snapshot.active.kind, ...snapshot.next.slice(0, 6)].join("");
}

function findCoveredSeed(): number {
  for (let seed = 1; seed < 20000; seed += 1) {
    const core = createEngine({ random: seededRandom(seed) });
    const key = firstBagKey(core);
    if (key !== null && OPENING_BOOK_DATA[key] !== undefined) return seed;
  }
  throw new Error("no opening-book seed found");
}

function executeMove(core: CorePort, move: AiMove): void {
  if (move.useHold) {
    core.hold();
    return;
  }
  const plan = move.execution;
  if (plan === undefined) throw new Error("book place move without execution");
  for (const step of plan.steps) {
    switch (step.kind) {
      case "placeAt":
        if (core.placeMinoAt === undefined) throw new Error("core lacks placeMinoAt");
        core.placeMinoAt(step.rotation, step.x, step.topRow ?? 0, step.lastSrs ?? 0);
        break;
      case "hold":
        core.hold();
        break;
      case "drop":
        core.hardDrop();
        break;
      default:
        throw new Error(`unexpected book step ${step.kind}`);
    }
  }
}

describe("opening book", () => {
  test("engages on a covered first bag and assembles the PCO shape", () => {
    const seed = findCoveredSeed();
    const core = createEngine({ random: seededRandom(seed) });
    const book = createOpeningBook();
    let moves = 0;
    for (let guard = 0; guard < 16; guard += 1) {
      const snapshot = core.getSnapshot();
      const move = book.next(snapshot, toBoard(snapshot));
      if (move === null) break;
      moves += 1;
      executeMove(core, move);
    }
    expect(moves).toBeGreaterThan(0);
    expect(book.lastOpener()).not.toBeNull();
    const finalSnapshot = core.getSnapshot();
    expect(finalSnapshot.lines).toBe(0);
    expect([rowsFingerprint(PCO_ROWS), rowsFingerprint(mirrorRows(PCO_ROWS))]).toContain(
      bookBoardFingerprint(toBoard(finalSnapshot)),
    );
  });

  test("falls back and disables on any deviation", () => {
    const seed = findCoveredSeed();
    const core = createEngine({ random: seededRandom(seed) });
    const book = createOpeningBook();
    const first = core.getSnapshot();
    expect(book.next(first, toBoard(first))).not.toBeNull();
    core.moveLeft();
    core.moveLeft();
    core.hardDrop();
    const deviated = core.getSnapshot();
    expect(book.next(deviated, toBoard(deviated))).toBeNull();
    expect(book.next(deviated, toBoard(deviated))).toBeNull();
  });

  test("does not engage once the board is not empty", () => {
    const seed = findCoveredSeed();
    const core = createEngine({ random: seededRandom(seed) });
    core.hardDrop();
    const snapshot = core.getSnapshot();
    expect(createOpeningBook().next(snapshot, toBoard(snapshot))).toBeNull();
  });

  test("v2 with the book reports the opener through debug", () => {
    const seed = findCoveredSeed();
    const core = createEngine({ random: seededRandom(seed) });
    const snapshot = core.getSnapshot();
    const fighter = createDeepSeekV2({ openingBook: true });
    const move = fighter.findBestMove(snapshot);
    expect(move).not.toBeNull();
    expect(fighter.getDebug()?.opener).not.toBeNull();
  });

  test("v2 without the book never reports an opener", () => {
    const seed = findCoveredSeed();
    const core = createEngine({ random: seededRandom(seed) });
    const snapshot = core.getSnapshot();
    const fighter = createDeepSeekV2();
    fighter.findBestMove(snapshot);
    expect(fighter.getDebug()?.opener).toBeNull();
  });
});
