import { describe, expect, test } from "bun:test";
import type { Board } from "../src/core/board.js";
import type { PieceKind } from "../src/core/pieces.js";
import {
  beamBestMove,
  type BeamEvaluation,
  type BeamMove,
  type PlyContext,
} from "../src/ai/beam.js";
import { createBeamEvaluation } from "../src/ai/evaluation.js";
import { enumerateScored } from "../src/ai/search.js";
import { DU_WEIGHTS, FIRE_WEIGHTS } from "../src/ai/weights.js";

interface Fixture {
  readonly board: Board;
  readonly current: PieceKind;
  readonly queue: readonly PieceKind[];
  readonly pending: number;
}

function stackedFixture(): Board {
  const board = new Uint16Array(20);
  board[0] = 0x1ff;
  board[1] = 0x1df;
  board[2] = 0x1bf;
  board[3] = 0x1ff;
  return board;
}

function summarize(move: BeamMove | null): unknown {
  if (move === null) return null;
  return {
    rotation: move.rotation,
    x: move.x,
    useHold: move.useHold,
    score: move.score,
    after: Array.from(move.after),
    linesCleared: move.linesCleared,
    fireScore: move.fireScore,
    isTspin: move.isTspin,
  };
}

function rankContext(fixture: Fixture): PlyContext {
  return {
    ply: 0,
    combo: -1,
    b2b: false,
    pending: fixture.pending,
    pendingAfter: fixture.pending,
    weights: DU_WEIGHTS,
    fire: FIRE_WEIGHTS,
    redV7Piece: fixture.current,
  };
}

function rankOutputs(fixture: Fixture, evaluation: BeamEvaluation): readonly number[] {
  const context = rankContext(fixture);
  return enumerateScored(fixture.board, fixture.current, DU_WEIGHTS).map((placement) =>
    evaluation.rank({
      placement,
      piece: fixture.current,
      tspin: false,
      context: { ...context, pendingAfter: Math.max(0, fixture.pending - placement.linesCleared) },
    }),
  );
}

describe("arch-eval-pipeline", () => {
  test("legacy and forked evaluation remain parity-equivalent while Blue can diverge independently from Red", () => {
    const fixtures: readonly Fixture[] = [
      { board: new Uint16Array(20), current: "O", queue: ["I", "T"], pending: 0 },
      { board: stackedFixture(), current: "O", queue: ["I", "T"], pending: 2 },
    ];
    const scorer = (after: Board, lines: number, tspin: boolean, context: PlyContext): number =>
      (after[0] ?? 0) + lines * 17 + (tspin ? 31 : 0) + context.pendingAfter * 3;
    const scoreAdjust = (_after: Board, lines: number, tspin: boolean): number =>
      lines * 5 + (tspin ? 7 : 0);
    const veto = (_after: Board, lines: number, tspin: boolean): boolean => lines === 4 && tspin;
    const legacyEvaluation = createBeamEvaluation({ scorer, scoreAdjust, legacyVeto: veto });
    const forkedEvaluation = createBeamEvaluation({
      rank: ({ placement, tspin, context }) =>
        placement.score + scorer(placement.after, placement.linesCleared, tspin, context),
      score: ({ after, lines, tspin, context }) =>
        scoreAdjust(after, lines, tspin) + scorer(after, lines, tspin, context),
      veto: ({ after, lines, tspin }) => veto(after, lines, tspin),
    });

    for (const fixture of fixtures) {
      const options = {
        depth: 2,
        width: 8,
        topK: 8,
        useHold: false,
        useKick: false,
        pending: fixture.pending,
      } as const;
      const legacyMove = beamBestMove(
        fixture.board,
        fixture.current,
        fixture.queue,
        null,
        false,
        false,
        -1,
        { ...options, scorer, scoreAdjust, veto },
      );
      const forkedMove = beamBestMove(
        fixture.board,
        fixture.current,
        fixture.queue,
        null,
        false,
        false,
        -1,
        { ...options, evaluation: forkedEvaluation },
      );

      expect(summarize(forkedMove)).toEqual(summarize(legacyMove));
      expect(rankOutputs(fixture, forkedEvaluation)).toEqual(rankOutputs(fixture, legacyEvaluation));
    }

    const independenceFixture: Fixture = {
      board: new Uint16Array(20),
      current: "O",
      queue: ["I"],
      pending: 0,
    };
    const redPipeline = createBeamEvaluation({
      rank: ({ placement }) => placement.score + placement.x,
    });
    const blueBaseline = createBeamEvaluation();
    const blueChanged = createBeamEvaluation({
      rank: ({ placement }) => placement.score + (placement.x === 8 ? 1_000_000 : 0),
    });
    const beamOptions = { depth: 1, width: 1, topK: 9, useHold: false, useKick: false } as const;
    const redBefore = beamBestMove(
      independenceFixture.board,
      independenceFixture.current,
      independenceFixture.queue,
      null,
      false,
      false,
      -1,
      { ...beamOptions, evaluation: redPipeline },
    );
    const blueBefore = beamBestMove(
      independenceFixture.board,
      independenceFixture.current,
      independenceFixture.queue,
      null,
      false,
      false,
      -1,
      { ...beamOptions, evaluation: blueBaseline },
    );
    const blueAfter = beamBestMove(
      independenceFixture.board,
      independenceFixture.current,
      independenceFixture.queue,
      null,
      false,
      false,
      -1,
      { ...beamOptions, evaluation: blueChanged },
    );
    const redAfter = beamBestMove(
      independenceFixture.board,
      independenceFixture.current,
      independenceFixture.queue,
      null,
      false,
      false,
      -1,
      { ...beamOptions, evaluation: redPipeline },
    );

    expect(summarize(blueAfter)).not.toEqual(summarize(blueBefore));
    expect(summarize(redAfter)).toEqual(summarize(redBefore));
  });
});
