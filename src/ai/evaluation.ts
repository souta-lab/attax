import type { Board } from "../core/board.js";
import type { PieceKind } from "../core/pieces.js";
import type { ScoredPlacement } from "./search.js";
import type { FireWeights, Weights } from "./weights.js";

export interface BeamFireWeights extends FireWeights {
  readonly wellStep?: number | undefined;
  readonly tslotStep?: number | undefined;
}

export interface PlyContext {
  readonly ply: number;
  readonly combo: number;
  readonly b2b: boolean;
  readonly pending: number;
  readonly pendingAfter: number;
  readonly weights: Weights;
  readonly fire: BeamFireWeights;
  readonly piece?: PieceKind | undefined;
}

export type PlyScorer = (after: Board, lines: number, tspin: boolean, ctx: PlyContext) => number;

export type HardVeto = (after: Board, lines: number, tspin: boolean) => boolean;

export type ScoreAdjust = (after: Board, lines: number, tspin: boolean) => number;

export interface BeamRankInput {
  readonly placement: ScoredPlacement;
  readonly piece: PieceKind;
  readonly tspin: boolean;
  readonly context: PlyContext;
}

export interface BeamAfterstateInput {
  readonly after: Board;
  readonly lines: number;
  readonly tspin: boolean;
  readonly context: PlyContext;
}

export type BeamRanker = (input: BeamRankInput) => number;
export type BeamScorer = (input: BeamAfterstateInput) => number;
export type BeamVeto = (input: BeamAfterstateInput) => boolean;

export interface BeamEvaluation {
  readonly rank: BeamRanker;
  readonly score: BeamScorer;
  readonly veto: BeamVeto;
}

export interface BeamEvaluationDefinition {
  readonly rank?: BeamRanker;
  readonly score?: BeamScorer;
  readonly veto?: BeamVeto;
  readonly scorer?: PlyScorer;
  readonly scoreAdjust?: ScoreAdjust;
  readonly legacyVeto?: HardVeto;
}

export function createBeamEvaluation(definition: BeamEvaluationDefinition = {}): BeamEvaluation {
  const rank: BeamRanker =
    definition.rank ??
    ((input) =>
      input.placement.score +
      (definition.scorer?.(
        input.placement.after,
        input.placement.linesCleared,
        input.tspin,
        input.context,
      ) ?? 0));
  const score: BeamScorer =
    definition.score ??
    ((input) =>
      (definition.scoreAdjust?.(input.after, input.lines, input.tspin) ?? 0) +
      (definition.scorer?.(input.after, input.lines, input.tspin, input.context) ?? 0));
  const veto: BeamVeto =
    definition.veto ??
    ((input) => definition.legacyVeto?.(input.after, input.lines, input.tspin) ?? false);
  return { rank, score, veto };
}
