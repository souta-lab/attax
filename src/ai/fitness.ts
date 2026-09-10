import type { GameSnapshot } from "../ui/types.js";
import {
  createVersusController,
  type SideState,
  VERSUS_DEFAULTS,
  type VersusFighter,
} from "../versus/controller.js";

export type FitnessFighter = Omit<VersusFighter, "color">;

export type FitnessFighterFactory = () => FitnessFighter;

export interface FitnessVectorIdentity {
  readonly vectorId: string;
  readonly configId: string;
}

export interface FitnessScenarioPair {
  readonly leftFactory: FitnessFighterFactory;
  readonly rightFactory: FitnessFighterFactory;
}

export interface FitnessScenarioSet {
  readonly S1: FitnessScenarioPair;
  readonly S3: FitnessScenarioPair;
}

export interface FitnessInput {
  readonly identity: FitnessVectorIdentity;
  readonly seeds: readonly number[];
  readonly maxTicks: number;
  readonly scenarios: FitnessScenarioSet;
}

export type FitnessWinner = "left" | "right" | "draw" | "cap";

export interface FitnessSideMetrics {
  readonly lines: number;
  readonly sent: number;
  readonly tsd: number;
  readonly tetris: number;
  readonly maxPending: number;
  readonly maxHeight: number;
  readonly holes: number;
  readonly executionSourceMismatches?: number;
  readonly executionExpectedBoardFailures?: number;
}

export interface FitnessMatchResult {
  readonly label: "S1" | "S3";
  readonly seed: number;
  readonly winner: FitnessWinner;
  readonly reason: string;
  readonly ticks: number;
  readonly pieces: number;
  readonly left: FitnessSideMetrics;
  readonly right: FitnessSideMetrics;
}

export interface FitnessScenarioResult {
  readonly label: "S1" | "S3";
  readonly matches: readonly FitnessMatchResult[];
}

export interface FitnessResult {
  readonly identity: FitnessVectorIdentity;
  readonly seeds: readonly number[];
  readonly maxTicks: number;
  readonly scenarios: readonly [FitnessScenarioResult, FitnessScenarioResult];
}

export const FITNESS_TICK_MS = 16 as const;

interface MutableSideMetrics {
  lines: number;
  sent: number;
  tsd: number;
  tetris: number;
  maxPending: number;
  maxHeight: number;
  holes: number;
  executionSourceMismatches: number;
  executionExpectedBoardFailures: number;
  previousLines: number;
}

export interface FitnessScenarioInput {
  readonly factories: FitnessScenarioPair;
  readonly seeds: readonly number[];
  readonly maxTicks: number;
}

interface ScenarioRunInput extends FitnessScenarioInput {
  readonly label: "S1" | "S3";
}

interface MatchRunInput {
  readonly label: "S1" | "S3";
  readonly factories: FitnessScenarioPair;
  readonly seed: number;
  readonly maxTicks: number;
}

export function runFitness(input: FitnessInput): FitnessResult {
  const s1 = runScenario({
    label: "S1",
    factories: input.scenarios.S1,
    seeds: input.seeds,
    maxTicks: input.maxTicks,
  });
  const s3 = runScenario({
    label: "S3",
    factories: input.scenarios.S3,
    seeds: input.seeds,
    maxTicks: input.maxTicks,
  });
  return {
    identity: {
      vectorId: input.identity.vectorId,
      configId: input.identity.configId,
    },
    seeds: [...input.seeds],
    maxTicks: input.maxTicks,
    scenarios: [s1, s3],
  };
}

export function runFitnessScenario(input: FitnessScenarioInput): FitnessScenarioResult {
  return runScenario({
    label: "S3",
    factories: input.factories,
    seeds: input.seeds,
    maxTicks: input.maxTicks,
  });
}

function runScenario(input: ScenarioRunInput): FitnessScenarioResult {
  return {
    label: input.label,
    matches: input.seeds.map((seed) => runMatch({ ...input, seed })),
  };
}

function runMatch(input: MatchRunInput): FitnessMatchResult {
  const leftFighter = controllerFighter(input.factories.leftFactory(), "fitness-left");
  const rightFighter = controllerFighter(input.factories.rightFactory(), "fitness-right");
  const controller = createVersusController(leftFighter, rightFighter, input.seed);
  const leftMetrics = createMetrics();
  const rightMetrics = createMetrics();
  let ticks = 0;

  while (controller.result === null && ticks < input.maxTicks) {
    controller.tick(FITNESS_TICK_MS, VERSUS_DEFAULTS);
    ticks += 1;
    sampleSide(controller.left, leftMetrics);
    sampleSide(controller.right, rightMetrics);
  }

  const leftSnapshot = controller.left.core.getSnapshot();
  const rightSnapshot = controller.right.core.getSnapshot();
  const result = controller.result;
  return {
    label: input.label,
    seed: input.seed,
    winner: result?.winner ?? "cap",
    reason: result?.reason ?? "max-ticks",
    ticks,
    pieces: result?.pieces ?? controller.pieces,
    left: finishMetrics(controller.left, leftSnapshot, leftMetrics),
    right: finishMetrics(controller.right, rightSnapshot, rightMetrics),
  };
}

function controllerFighter(fighter: FitnessFighter, color: string): VersusFighter {
  return { ...fighter, color };
}

function createMetrics(): MutableSideMetrics {
  return {
    lines: 0,
    sent: 0,
    tsd: 0,
    tetris: 0,
    maxPending: 0,
    maxHeight: 0,
    holes: 0,
    executionSourceMismatches: 0,
    executionExpectedBoardFailures: 0,
    previousLines: 0,
  };
}

function sampleSide(side: SideState, metrics: MutableSideMetrics): void {
  const snapshot = side.core.getSnapshot();
  const debug = side.fighter.getDebug?.() ?? null;
  metrics.lines = snapshot.lines;
  metrics.sent = side.sentTotal;
  metrics.maxPending = Math.max(metrics.maxPending, snapshot.pendingGarbage);
  metrics.maxHeight = Math.max(metrics.maxHeight, stackHeight(snapshot.board.grid));
  metrics.holes = Math.max(metrics.holes, countHoles(snapshot.board.grid));
  metrics.executionSourceMismatches = side.executionSourceMismatches;
  metrics.executionExpectedBoardFailures = side.executionExpectedBoardFailures;
  if (snapshot.lines > metrics.previousLines) {
    if (debug?.isTspin === true && debug.linesCleared === 2) metrics.tsd += 1;
    if (debug?.linesCleared === 4) metrics.tetris += 1;
  }
  metrics.previousLines = snapshot.lines;
}

function finishMetrics(
  side: SideState,
  snapshot: GameSnapshot,
  metrics: MutableSideMetrics,
): FitnessSideMetrics {
  sampleSide(side, metrics);
  return {
    lines: snapshot.lines,
    sent: side.sentTotal,
    tsd: metrics.tsd,
    tetris: metrics.tetris,
    maxPending: metrics.maxPending,
    maxHeight: metrics.maxHeight,
    holes: metrics.holes,
    ...(metrics.executionSourceMismatches === 0
      ? {}
      : { executionSourceMismatches: metrics.executionSourceMismatches }),
    ...(metrics.executionExpectedBoardFailures === 0
      ? {}
      : { executionExpectedBoardFailures: metrics.executionExpectedBoardFailures }),
  };
}

function stackHeight(grid: GameSnapshot["board"]["grid"]): number {
  for (let rowIndex = 0; rowIndex < grid.length; rowIndex += 1) {
    if (grid[rowIndex]?.some((cell) => cell !== 0) === true) return grid.length - rowIndex;
  }
  return 0;
}

function countHoles(grid: GameSnapshot["board"]["grid"]): number {
  let holes = 0;
  for (let column = 0; column < 10; column += 1) {
    let blockSeen = false;
    for (const row of grid) {
      const filled = (row?.[column] ?? 0) !== 0;
      if (filled) blockSeen = true;
      else if (blockSeen) holes += 1;
    }
  }
  return holes;
}

export function serializeFitness(result: FitnessResult): string {
  return JSON.stringify({
    identity: {
      vectorId: result.identity.vectorId,
      configId: result.identity.configId,
    },
    seeds: result.seeds,
    maxTicks: result.maxTicks,
    scenarios: result.scenarios.map((scenario) => ({
      label: scenario.label,
      matches: scenario.matches.map((match) => ({
        label: match.label,
        seed: match.seed,
        winner: match.winner,
        reason: match.reason,
        ticks: match.ticks,
        pieces: match.pieces,
        left: {
          lines: match.left.lines,
          sent: match.left.sent,
          tsd: match.left.tsd,
          tetris: match.left.tetris,
          maxPending: match.left.maxPending,
          maxHeight: match.left.maxHeight,
          holes: match.left.holes,
          ...(match.left.executionSourceMismatches === undefined
            ? {}
            : { executionSourceMismatches: match.left.executionSourceMismatches }),
          ...(match.left.executionExpectedBoardFailures === undefined
            ? {}
            : { executionExpectedBoardFailures: match.left.executionExpectedBoardFailures }),
        },
        right: {
          lines: match.right.lines,
          sent: match.right.sent,
          tsd: match.right.tsd,
          tetris: match.right.tetris,
          maxPending: match.right.maxPending,
          maxHeight: match.right.maxHeight,
          holes: match.right.holes,
          ...(match.right.executionSourceMismatches === undefined
            ? {}
            : { executionSourceMismatches: match.right.executionSourceMismatches }),
          ...(match.right.executionExpectedBoardFailures === undefined
            ? {}
            : { executionExpectedBoardFailures: match.right.executionExpectedBoardFailures }),
        },
      })),
    })),
  });
}

export function fingerprintFitness(result: FitnessResult): string {
  const serialized = serializeFitness(result);
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
