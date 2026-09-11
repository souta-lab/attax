import { describe, expect, test } from "bun:test";
import { advanceSearchQueue, type SearchQueueState } from "../src/ai/hoiko-search.js";

describe("Hoiko search queue transitions", () => {
  test("keeps the current piece after swapping a non-empty hold", () => {
    const root: SearchQueueState = { queueIndex: 0, nextPieceOverride: null };
    const afterSwap = advanceSearchQueue(root, "swapHold", "T");

    expect(afterSwap).toEqual({ queueIndex: 1, nextPieceOverride: "T" });
    expect(advanceSearchQueue(afterSwap, "normal", "T")).toEqual({
      queueIndex: 1,
      nextPieceOverride: null,
    });
  });

  test("consumes current and next when filling an empty hold", () => {
    const root: SearchQueueState = { queueIndex: 0, nextPieceOverride: null };

    expect(advanceSearchQueue(root, "emptyHold", "T")).toEqual({
      queueIndex: 2,
      nextPieceOverride: null,
    });
  });
});
