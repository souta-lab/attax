import type { PieceKind } from "../../../src/core/pieces.js";
import type { TspinKind } from "../../../src/core/tspin.js";
import type { RootCandidateReport } from "./s2-variants.js";

export type DatasetSource =
  | "attax_vs_champion"
  | "champion_selfplay"
  | "champion_vs_historical"
  | "corrected_attax_vs_champion"
  | "targeted_tactical";

export type SplitKind = "train" | "val" | "test";
export type HeightBucket = "0-8" | "9-13" | "14+";
export type B2bBucket = "0" | "1-4" | "5+";
export type ReleaseVsCharge = "release_opportunity" | "charge_opportunity" | "none";

export interface PublicObservationRecord {
  readonly rulesetId: string;
  readonly stateKey: string;
  readonly board: {
    readonly width: number;
    readonly height: number;
    readonly cells: string;
  };
  readonly pieces: {
    readonly current: PieceKind;
    readonly known: readonly PieceKind[];
    readonly hold: PieceKind | null;
    readonly holdAvailable: boolean;
  };
  readonly chain: {
    readonly combo: number;
    readonly b2b: number;
  };
  readonly incoming: {
    readonly pendingRows: number;
    readonly dueThisLockRows: number;
  };
  readonly lockTime: {
    readonly logicalFrame: number;
  };
}

export interface WitnessRecord {
  readonly rotation: string;
  readonly x: number;
  readonly y: number;
  readonly usedHold: boolean;
  readonly rotationEvidence: {
    readonly lastInputWasRotation: boolean;
    readonly kickIndex: number | null;
    readonly kickId: string | null;
    readonly kickOffset: readonly [number, number] | null;
  };
}

export interface RefereeActionOutcome {
  readonly lines: number;
  readonly spin: "none" | "mini" | "normal";
  readonly comboAfter: number;
  readonly b2bAfter: number;
  readonly cancelledRows: number;
  readonly tankRows: number;
  readonly remainingRows: number;
  readonly outgoingBeforeCancel: number;
  readonly outgoingAfterCancel: number;
  readonly surgeSent: number;
  readonly occupiedHeightAfterLock: number;
  readonly visibleMarginAfterLock: number;
  readonly solvency: number;
  readonly amountToppedOut: boolean;
  readonly solvent: boolean;
}

export interface LegalActionEntry {
  readonly actionIndex: number;
  readonly semanticKey: string;
  readonly cellKey: string;
  readonly piece: PieceKind;
  readonly usedHold: boolean;
  readonly reachableWithout180: boolean;
  readonly witnesses: readonly WitnessRecord[];
  readonly referee: RefereeActionOutcome;
}

export interface TeacherRankedCandidate {
  readonly rank: number;
  readonly cc2Rank: number;
  readonly actionIndex: number;
  readonly semanticKey: string;
  readonly s2Score: number;
  readonly selectionScore: number;
  readonly rootValue: number | null;
  readonly solvency: number;
  readonly solvent: boolean;
  readonly conversionBranch: string;
  readonly conversionUnits: number;
}

export interface TeacherRootChild {
  readonly actionIndex: number;
  readonly semanticKey: string;
  readonly value: number;
  readonly draws: number;
}

export interface TeacherReuseStats {
  readonly reused: boolean;
  readonly inherited: number;
  readonly credited: number;
  readonly newSelections: number;
  readonly reason: string;
}

export interface TeacherLabel {
  readonly botId: string;
  readonly profileId: string;
  readonly configHash: string;
  readonly sessionMode: "persistent" | "fresh";
  readonly reuse: TeacherReuseStats | null;
  readonly selectedActionIndex: number;
  readonly selectedSemanticKey: string;
  readonly selectedInAllow180False: boolean;
  readonly rankZeroActionIndex: number;
  readonly rankZeroSemanticKey: string;
  readonly rescueApplied: boolean;
  readonly rootValueTop1: number | null;
  readonly rootValueMargin12: number | null;
  readonly selectionMargin12: number | null;
  readonly ranked: readonly TeacherRankedCandidate[];
  readonly rootChildren: readonly TeacherRootChild[];
}

export interface AnnotatedCandidate {
  readonly actionIndex: number;
  readonly semanticKey: string;
  readonly inMovegen: boolean;
  readonly survivedBeam: boolean;
  readonly pruningDepth: number;
  readonly fatalAtRoot: boolean;
  readonly fatalOnBestPath: boolean;
  readonly rootSolvencyMargin: number;
  readonly minSolvencyMargin: number;
  readonly beamValue: number | null;
  readonly completeValue: number;
  readonly stepCount: number;
  readonly phi34: readonly number[];
}

export interface VariantAnnotation {
  readonly weightsId: string;
  readonly width: number;
  readonly depth: number;
  readonly nodes: number;
  readonly bestActionIndex: number;
  readonly teacherSelectedInMovegen: boolean;
  readonly teacherSelectedSurvivedBeam: boolean;
  readonly teacherSelectedPruningDepth: number;
  readonly teacherRankZeroInMovegen: boolean;
  readonly teacherRankZeroSurvivedBeam: boolean;
  readonly teacherRankZeroPruningDepth: number;
  readonly candidates: readonly AnnotatedCandidate[];
}

export interface StratificationMeta {
  readonly maxHeightRoot: number;
  readonly heightBucket: HeightBucket;
  readonly pendingRows: number;
  readonly dueThisLockRows: number;
  readonly hasPressure: boolean;
  readonly b2b: number;
  readonly b2bBucket: B2bBucket;
  readonly combo: number;
  readonly activeRen: boolean;
  readonly nonTSpinClearOpportunity: boolean;
  readonly nonTSpinAnyOpportunity: boolean;
  readonly rescueActivated: boolean;
  readonly hasAvoidableDeath: boolean;
  readonly releaseVsCharge: ReleaseVsCharge;
}

export interface DecisionRecord {
  readonly schema: "attax-s2-imitation/1";
  readonly recordId: string;
  readonly source: DatasetSource;
  readonly gameId: string;
  readonly seed: number;
  readonly split: SplitKind;
  readonly ply: number;
  readonly actorSeat: string;
  readonly actorBot: string;
  readonly opponentBot: string;
  readonly tacticalTag: string | null;
  readonly observation: PublicObservationRecord;
  readonly legalActions: readonly LegalActionEntry[];
  readonly teacher: TeacherLabel;
  readonly freshTeacher: TeacherLabel | null;
  readonly freshAgreement: {
    readonly agreesSelected: boolean;
    readonly agreesRankZero: boolean;
  } | null;
  readonly stratification: StratificationMeta;
  readonly annotations: {
    readonly existing?: VariantAnnotation;
    readonly corrected?: VariantAnnotation;
  };
}

/** Deterministic whole-seed split (70% train / 15% val / 15% test). */
export function splitForSeed(seed: number): SplitKind {
  // Golden-ratio Weyl mix gives uniform distribution even on consecutive seed blocks,
  // while strictly mapping every position from the same game/seed to the same split.
  const h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) >>> 0;
  const bucket = h % 20;
  if (bucket < 14) return "train";
  if (bucket < 17) return "val";
  return "test";
}

export function normalizeSpinLabel(spin: string): TspinKind {
  if (spin === "normal") return "full";
  if (spin === "mini") return "mini";
  return "none";
}

export function classifyStratification(args: {
  readonly maxHeightRoot: number;
  readonly pendingRows: number;
  readonly dueThisLockRows: number;
  readonly b2b: number;
  readonly combo: number;
  readonly legalActions: readonly LegalActionEntry[];
  readonly rescueActivated: boolean;
}): StratificationMeta {
  const { maxHeightRoot, pendingRows, dueThisLockRows, b2b, combo, legalActions, rescueActivated } =
    args;

  const heightBucket: HeightBucket =
    maxHeightRoot <= 8 ? "0-8" : maxHeightRoot <= 13 ? "9-13" : "14+";
  const hasPressure = pendingRows > 0 || dueThisLockRows > 0;
  const b2bBucket: B2bBucket = b2b === 0 ? "0" : b2b <= 4 ? "1-4" : "5+";
  const activeRen = combo > 0;

  let nonTSpinClearOpportunity = false;
  let nonTSpinAnyOpportunity = false;
  let hasSolventOrAlive = false;
  let hasUnsafeOrFatal = false;
  let hasReleaseAction = false;
  let hasChargeAction = false;

  for (const a of legalActions) {
    if (a.piece !== "T" && a.referee.spin !== "none") {
      nonTSpinAnyOpportunity = true;
      if (a.referee.lines > 0) nonTSpinClearOpportunity = true;
    }
    if (!a.referee.amountToppedOut && a.referee.solvent) {
      hasSolventOrAlive = true;
    } else {
      hasUnsafeOrFatal = true;
    }
    if (a.referee.surgeSent > 0) hasReleaseAction = true;
    if (b2b >= 1 && a.referee.b2bAfter > b2b) hasChargeAction = true;
  }

  const hasAvoidableDeath = hasSolventOrAlive && hasUnsafeOrFatal;
  const releaseVsCharge: ReleaseVsCharge = hasReleaseAction
    ? "release_opportunity"
    : b2b >= 1 && hasChargeAction
      ? "charge_opportunity"
      : "none";

  return {
    maxHeightRoot,
    heightBucket,
    pendingRows,
    dueThisLockRows,
    hasPressure,
    b2b,
    b2bBucket,
    combo,
    activeRen,
    nonTSpinClearOpportunity,
    nonTSpinAnyOpportunity,
    rescueActivated,
    hasAvoidableDeath,
    releaseVsCharge,
  };
}

/** Collapses per-witness search candidates to 1 unique entry per semantic legal action. */
export function buildVariantAnnotation(args: {
  readonly weightsId: string;
  readonly width: number;
  readonly depth: number;
  readonly nodes: number;
  readonly bestSemanticKey: string | null;
  readonly rootCandidates: readonly RootCandidateReport[];
  readonly legalActions: readonly LegalActionEntry[];
  readonly teacher: TeacherLabel;
}): VariantAnnotation {
  const indexBySemantic = new Map<string, number>();
  for (const act of args.legalActions) {
    indexBySemantic.set(act.semanticKey, act.actionIndex);
  }

  const byAction = new Map<number, AnnotatedCandidate>();
  for (const rc of args.rootCandidates) {
    const actionIndex = indexBySemantic.get(rc.semanticKey);
    if (actionIndex === undefined) continue;
    const entry: AnnotatedCandidate = {
      actionIndex,
      semanticKey: rc.semanticKey,
      inMovegen: true,
      survivedBeam: rc.survivedBeam,
      pruningDepth: rc.pruningDepth,
      fatalAtRoot: rc.fatalAtRoot,
      fatalOnBestPath: rc.fatalOnBestPath,
      rootSolvencyMargin: rc.rootSolvencyMargin,
      minSolvencyMargin: rc.minSolvencyMargin,
      beamValue: rc.beamValue,
      completeValue: rc.completeValue,
      stepCount: rc.stepCount,
      phi34: rc.phi34,
    };
    const prev = byAction.get(actionIndex);
    if (
      prev === undefined ||
      Number(entry.survivedBeam) > Number(prev.survivedBeam) ||
      (entry.survivedBeam === prev.survivedBeam && entry.completeValue > prev.completeValue)
    ) {
      byAction.set(actionIndex, entry);
    }
  }

  const selCand = byAction.get(args.teacher.selectedActionIndex);
  const rzCand = byAction.get(args.teacher.rankZeroActionIndex);
  const bestActionIndex =
    args.bestSemanticKey !== null ? (indexBySemantic.get(args.bestSemanticKey) ?? -1) : -1;

  return {
    weightsId: args.weightsId,
    width: args.width,
    depth: args.depth,
    nodes: args.nodes,
    bestActionIndex,
    teacherSelectedInMovegen: selCand !== undefined,
    teacherSelectedSurvivedBeam: selCand?.survivedBeam ?? false,
    teacherSelectedPruningDepth: selCand?.pruningDepth ?? 0,
    teacherRankZeroInMovegen: rzCand !== undefined,
    teacherRankZeroSurvivedBeam: rzCand?.survivedBeam ?? false,
    teacherRankZeroPruningDepth: rzCand?.pruningDepth ?? 0,
    candidates: [...byAction.values()].sort((a, b) => a.actionIndex - b.actionIndex),
  };
}
