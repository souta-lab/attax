/**
 * Teacher oracle & referee legal-action builder for Canonical §D imitation logging.
 *
 * Wraps the shipping champion binary (cold_clear_2_s2.wasm, Soldier / CC2+F14)
 * via S2 lab contracts:
 *   - Supports both persistent session (tree_reuse_floor=256) and fresh session probes
 *   - Enables diagnostics.rootValues + diagnostics.rootChildValues
 *   - Verifies every decision via champion.resolveChampionDecision
 *   - Builds deduplicated S2 semantic legal action sets via referee move-generation + projection
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Weights } from "../../../src/ai/bot/weights.js";
import type { PieceKind } from "../../../src/core/pieces.js";
import { projectAttax } from "../attax-player.js";
import {
  champion,
  createS2AmountOnlyDecisionState,
  fullStateKey,
  lab,
  labRoot,
  resolvePlacementRules,
} from "../lab.mjs";
import type { SearchInput } from "../search.js";
import { type DriverVariant, runVariantSearch, weightsToVector24 } from "./s2-variants.js";
import {
  buildVariantAnnotation,
  classifyStratification,
  type DatasetSource,
  type DecisionRecord,
  type LegalActionEntry,
  type PublicObservationRecord,
  splitForSeed,
  type TeacherLabel,
  type TeacherRankedCandidate,
  type TeacherReuseStats,
  type TeacherRootChild,
  type VariantAnnotation,
  type WitnessRecord,
} from "./schema.js";

const { createCc2WasmSession } = await lab("src-js/cc2-wasm-engine.mjs");
const { generateReachablePlacements } = await lab("src-js/triangle/move-generation.mjs");
const { placementGeometry } = await lab("src-js/triangle/placement-geometry.mjs");
const { projectS2AmountOnlyLock } = await lab("src-js/s2-amount-only-lock-projection.mjs");
const { assessS2AmountOnlySolvency } = await lab("src-js/s2-amount-only-post-tank-solvency.mjs");
const { cc2MoveToCanonicalPlacement } = await lab("src-js/cc2-s2-adapter.mjs");
const { defaultBotParameters } = await lab("src-js/bot-parameters.mjs");

export interface CanonicalPlacement {
  readonly piece: string;
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

export interface CanonicalState {
  readonly rulesetId: string;
  readonly board: {
    readonly width: number;
    readonly height: number;
    readonly visibleHeight?: number;
    readonly cells: string;
    readonly fidelity?: string;
  };
  pieces: {
    readonly current: PieceKind;
    readonly known: readonly PieceKind[];
    readonly hold: PieceKind | null;
    readonly holdAvailable: boolean;
    readonly fidelity?: string;
  };
  readonly chain: {
    readonly combo: number;
    readonly b2b: number;
    readonly fidelity?: string;
  };
  readonly garbage: {
    readonly packets: readonly Record<string, unknown>[];
    readonly generatorState?: Record<string, unknown>;
    readonly capState?: Record<string, unknown>;
    readonly fidelity?: string;
  };
  readonly time: {
    readonly logicalFrame: number;
    readonly piecesPlaced?: number;
    readonly fidelity?: string;
    readonly frameSemantics?: string;
  };
  readonly [key: string]: unknown;
}

export interface PlacementGeometryMap {
  readonly blocks: Record<string, Record<string, ReadonlyArray<readonly [number, number]>>>;
}

export interface F14RankedCandidateRaw {
  readonly cc2Rank?: number;
  readonly s2Score?: number;
  readonly selectionScore?: number;
  readonly solvency?: number;
  readonly solvent?: boolean;
  readonly conversionBranch?: string;
  readonly conversionUnits?: number;
}

export interface F14Response {
  readonly status?: string;
  readonly reason?: string;
  readonly profileId?: string;
  readonly search?: {
    readonly reuse?: {
      readonly reused?: boolean;
      readonly inherited?: number;
      readonly credited?: number;
      readonly newSelections?: number;
      readonly reason?: string;
    };
  };
  readonly ranking?: {
    readonly identities?: readonly string[];
    readonly returnedIdentities?: readonly string[];
    readonly candidates?: readonly F14RankedCandidateRaw[];
    readonly rescueApplied?: boolean;
    readonly selectedCc2Rank?: number;
  };
  readonly diagnostics?: {
    readonly rootValues?: readonly number[];
    readonly rootChildValues?: {
      readonly children?: readonly {
        readonly identity?: string;
        readonly value?: number;
        readonly draws?: number;
      }[];
    };
  };
}

export interface ChampionTransitionResult {
  readonly legality?: { readonly legal?: boolean; readonly reason?: string };
  readonly nextState: CanonicalState | null;
  readonly tankResult?: { readonly toppedOut?: boolean };
  readonly lockResult?: Record<string, unknown> | null;
  readonly cancelResult?: Record<string, unknown>;
  readonly attackStages?: Record<string, unknown>;
}

export interface ChampionResolvedResult {
  readonly placement: CanonicalPlacement;
  readonly transition: ChampionTransitionResult;
  readonly positionFingerprint: string;
}

interface Cc2WasmSession {
  decideF14(args: {
    readonly request: Record<string, unknown>;
    readonly profile: Record<string, unknown>;
  }): Promise<F14Response>;
  close(): Promise<void>;
}

export const CHAMPION_WASM_PATH = resolve(
  labRoot,
  "bot/cold-clear-2-s2/target/wasm32-unknown-unknown/release/cold_clear_2_s2.wasm",
);

let cachedWasmBytes: Uint8Array | null = null;
let cachedWasmSha256: string | null = null;

export function getChampionWasmBytes(): { wasmBytes: Uint8Array; wasmSha256: string } {
  if (cachedWasmBytes === null || cachedWasmSha256 === null) {
    const buf = readFileSync(CHAMPION_WASM_PATH);
    cachedWasmBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    cachedWasmSha256 = createHash("sha256").update(buf).digest("hex");
  }
  return { wasmBytes: cachedWasmBytes, wasmSha256: cachedWasmSha256 };
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalCellsKey(blocks: ReadonlyArray<readonly [number, number]>): string {
  return blocks
    .map(([x, y]) => `${x},${y}`)
    .sort()
    .join(";");
}

function witnessPoseKey(placement: CanonicalPlacement): string {
  return `${placement.piece}:${placement.rotation}:${placement.x},${placement.y}:${placement.usedHold ? 1 : 0}:${placement.rotationEvidence.lastInputWasRotation ? 1 : 0}:${placement.rotationEvidence.kickIndex ?? ""}`;
}

export function mapCc2Spin(spin: string): "none" | "mini" | "normal" {
  if (spin === "full" || spin === "normal") return "normal";
  if (spin === "mini") return "mini";
  return "none";
}

function occupiedHeightFromCells(cells: string): number {
  let maxRow = 0;
  for (let y = 0; y < 40; y += 1) {
    const base = y * 10;
    for (let x = 0; x < 10; x += 1) {
      if (cells[base + x] !== "_") {
        maxRow = y + 1;
        break;
      }
    }
  }
  return maxRow;
}

export function canonicalToGuiState(state: CanonicalState): Record<string, unknown> {
  const { width, height, cells } = state.board;
  return {
    board: Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => {
        const cell = cells[y * width + x];
        return cell === "_" ? null : cell;
      }),
    ),
    queue: [state.pieces.current, ...state.pieces.known].filter((piece) => piece !== null),
    hold: state.pieces.hold,
    combo: state.chain.combo,
    back_to_back: state.chain.b2b > 0,
    randomizer: { type: "seven_bag", bag_state: [] },
    s2: {
      b2b: state.chain.b2b,
      garbage: structuredClone(state.garbage),
      time: structuredClone(state.time),
      movement: structuredClone(state.movement),
      clock: {
        kind: "synthetic-fixed-lock-step",
        framesPerLock: 24,
      },
    },
  };
}

export function publicObservationFromState(
  canonicalState: CanonicalState,
): PublicObservationRecord {
  const decision = createS2AmountOnlyDecisionState(canonicalState);
  return {
    rulesetId: canonicalState.rulesetId,
    stateKey: fullStateKey(canonicalState),
    board: {
      width: canonicalState.board.width,
      height: canonicalState.board.height,
      cells: canonicalState.board.cells,
    },
    pieces: {
      current: decision.pieces.current as PieceKind,
      known: [...(decision.pieces.known as PieceKind[])].slice(0, 13),
      hold: (decision.pieces.hold ?? null) as PieceKind | null,
      holdAvailable: decision.pieces.holdAvailable === true,
    },
    chain: {
      combo: canonicalState.chain.combo,
      b2b: canonicalState.chain.b2b,
    },
    incoming: {
      pendingRows: decision.incoming.pendingRows as number,
      dueThisLockRows: decision.incoming.dueThisLockRows as number,
    },
    lockTime: {
      logicalFrame: canonicalState.time.logicalFrame,
    },
  };
}

/**
 * Reconstructs canonical state from a logged PublicObservationRecord for
 * referee verification or `projectAttax`.
 */
export function canonicalStateFromObservation(obs: PublicObservationRecord): CanonicalState {
  const packets: Array<Record<string, unknown>> = [];
  const logicalFrame = obs.lockTime.logicalFrame;
  if (obs.incoming.dueThisLockRows > 0) {
    packets.push({
      packetId: 1,
      sourceGameId: 2,
      amount: obs.incoming.dueThisLockRows,
      holeSize: 1,
      arrivalFrame: Math.max(0, logicalFrame - 600),
      confirmed: true,
      order: 0,
    });
  }
  const delayed = obs.incoming.pendingRows - obs.incoming.dueThisLockRows;
  if (delayed > 0) {
    packets.push({
      packetId: 2,
      sourceGameId: 2,
      amount: delayed,
      holeSize: 1,
      arrivalFrame: logicalFrame + 40,
      confirmed: true,
      order: packets.length,
    });
  }
  return {
    rulesetId: obs.rulesetId,
    board: {
      width: obs.board.width,
      height: obs.board.height,
      visibleHeight: 20,
      cells: obs.board.cells,
      fidelity: "exact",
    },
    pieces: {
      current: obs.pieces.current,
      hold: obs.pieces.hold,
      known: [...obs.pieces.known],
      holdAvailable: obs.pieces.holdAvailable,
      fidelity: "exact",
    },
    chain: {
      combo: obs.chain.combo,
      b2b: obs.chain.b2b,
      fidelity: "exact",
    },
    garbage: {
      packets,
      generatorState: {
        rngState: 1,
        lastTankFrame: 0,
        lastHoleColumn: -1,
        sentForOpener: 0,
        holeChanged: false,
        receivedCountSinceReset: 0,
      },
      capState: { consumedThisTick: 0 },
      fidelity: "exact",
    },
    time: {
      fidelity: "exact",
      logicalFrame,
      piecesPlaced: 0,
      frameSemantics: "fixed",
    },
  };
}

export function searchInputFromObservation(obs: PublicObservationRecord): SearchInput {
  const canonical = canonicalStateFromObservation(obs);
  const decision = createS2AmountOnlyDecisionState(canonical);
  return projectAttax(decision);
}

export interface LegalActionsBuildResult {
  readonly legalActions: LegalActionEntry[];
  readonly indexBySemantic: Map<string, number>;
  readonly indexByCell: Map<string, number>;
  readonly no180SemanticSet: Set<string>;
}

interface ActionAccum {
  readonly semanticKey: string;
  readonly cellKey: string;
  readonly piece: PieceKind;
  readonly usedHold: boolean;
  reachableWithout180: boolean;
  readonly witnesses: WitnessRecord[];
  readonly referee: LegalActionEntry["referee"];
}

function toWitnessRecord(p: CanonicalPlacement): WitnessRecord {
  return {
    rotation: p.rotation,
    x: p.x,
    y: p.y,
    usedHold: Boolean(p.usedHold),
    rotationEvidence: {
      lastInputWasRotation: Boolean(p.rotationEvidence.lastInputWasRotation),
      kickIndex: p.rotationEvidence.kickIndex ?? null,
      kickId: p.rotationEvidence.kickId ?? null,
      kickOffset: p.rotationEvidence.kickOffset
        ? ([p.rotationEvidence.kickOffset[0], p.rotationEvidence.kickOffset[1]] as const)
        : null,
    },
  };
}

function pieceBlocksAtPose(
  geometry: PlacementGeometryMap,
  p: CanonicalPlacement,
): ReadonlyArray<readonly [number, number]> {
  const rotMap = geometry.blocks[p.piece];
  const offsets = rotMap?.[p.rotation] ?? [];
  return offsets.map(([dx, dy]) => [p.x + dx, p.y + dy] as const);
}

/**
 * Generates every referee-reachable root action under SRS+ with `allow180: true`,
 * deduplicates by `(piece, usedHold, spin, cells)` while retaining all witnesses,
 * and marks exact reachability under `allow180: false`.
 */
export function buildLegalActions(canonicalState: CanonicalState): LegalActionsBuildResult {
  const rules = resolvePlacementRules(canonicalState.rulesetId);
  const geometry = placementGeometry(rules) as PlacementGeometryMap;
  const incoming = createS2AmountOnlyDecisionState(canonicalState).incoming;

  const placements180 = generateReachablePlacements(canonicalState, {
    kickTable: rules.kickTable,
    allow180: true,
  }) as CanonicalPlacement[];
  const placementsNo180 = generateReachablePlacements(canonicalState, {
    kickTable: rules.kickTable,
    allow180: false,
  }) as CanonicalPlacement[];

  const no180PoseKeys = new Set<string>();
  for (const p of placementsNo180) {
    no180PoseKeys.add(witnessPoseKey(p));
  }

  const accBySemantic = new Map<string, ActionAccum>();
  const matchedNo180PoseKeys = new Set<string>();

  for (const p of placements180) {
    const blocks = pieceBlocksAtPose(geometry, p);
    const cKey = canonicalCellsKey(blocks);
    const fullCellKey = `${p.piece}:${p.usedHold ? 1 : 0}:${cKey}`;
    const witness = toWitnessRecord(p);
    const wPoseKey = witnessPoseKey(p);
    const isNo180 = no180PoseKeys.has(wPoseKey);
    if (isNo180) matchedNo180PoseKeys.add(wPoseKey);

    if (!witness.rotationEvidence.lastInputWasRotation) {
      const nonSpinKey = `${p.piece}:${p.usedHold ? 1 : 0}:none:${cKey}`;
      const existingNonSpin = accBySemantic.get(nonSpinKey);
      if (existingNonSpin !== undefined) {
        existingNonSpin.witnesses.push(witness);
        if (isNo180) existingNonSpin.reachableWithout180 = true;
        continue;
      }
    }

    const projection = projectS2AmountOnlyLock(
      canonicalState,
      { kind: "placement", placement: p },
      incoming,
    );
    const spin = projection.spin as "none" | "mini" | "normal";
    const sKey = `${p.piece}:${p.usedHold ? 1 : 0}:${spin}:${cKey}`;

    const existing = accBySemantic.get(sKey);
    if (existing !== undefined) {
      existing.witnesses.push(witness);
      if (isNo180) existing.reachableWithout180 = true;
    } else {
      const solvency = assessS2AmountOnlySolvency(projection);
      accBySemantic.set(sKey, {
        semanticKey: sKey,
        cellKey: fullCellKey,
        piece: p.piece as PieceKind,
        usedHold: Boolean(p.usedHold),
        reachableWithout180: isNo180,
        witnesses: [witness],
        referee: {
          lines: projection.lines,
          spin,
          comboAfter: projection.comboAfter,
          b2bAfter: projection.b2bAfter,
          cancelledRows: projection.cancelledRows,
          tankRows: projection.tankRows,
          remainingRows: projection.remainingRows,
          outgoingBeforeCancel: projection.outgoingBeforeCancel,
          outgoingAfterCancel: projection.outgoingAfterCancel,
          surgeSent: projection.surgeSent,
          occupiedHeightAfterLock: projection.occupiedHeightAfterLock,
          visibleMarginAfterLock: projection.visibleMarginAfterLock,
          solvency: solvency.solvency,
          amountToppedOut: projection.amountToppedOut,
          solvent: solvency.solvent,
        },
      });
    }
  }

  // Handle cases where allow180:false reached a pose not emitted as the first BFS witness in placements180.
  const no180SemanticSet = new Set<string>();
  for (const acc of accBySemantic.values()) {
    if (acc.reachableWithout180) no180SemanticSet.add(acc.semanticKey);
  }
  for (const p of placementsNo180) {
    if (matchedNo180PoseKeys.has(witnessPoseKey(p))) continue;
    const blocks = pieceBlocksAtPose(geometry, p);
    const cKey = canonicalCellsKey(blocks);
    const fullCellKey = `${p.piece}:${p.usedHold ? 1 : 0}:${cKey}`;
    const projection = projectS2AmountOnlyLock(
      canonicalState,
      { kind: "placement", placement: p },
      incoming,
    );
    const spin = projection.spin as "none" | "mini" | "normal";
    const sKey = `${p.piece}:${p.usedHold ? 1 : 0}:${spin}:${cKey}`;
    no180SemanticSet.add(sKey);
    const entry = accBySemantic.get(sKey);
    if (entry !== undefined) {
      entry.reachableWithout180 = true;
    } else {
      const solvency = assessS2AmountOnlySolvency(projection);
      accBySemantic.set(sKey, {
        semanticKey: sKey,
        cellKey: fullCellKey,
        piece: p.piece as PieceKind,
        usedHold: Boolean(p.usedHold),
        reachableWithout180: true,
        witnesses: [toWitnessRecord(p)],
        referee: {
          lines: projection.lines,
          spin,
          comboAfter: projection.comboAfter,
          b2bAfter: projection.b2bAfter,
          cancelledRows: projection.cancelledRows,
          tankRows: projection.tankRows,
          remainingRows: projection.remainingRows,
          outgoingBeforeCancel: projection.outgoingBeforeCancel,
          outgoingAfterCancel: projection.outgoingAfterCancel,
          surgeSent: projection.surgeSent,
          occupiedHeightAfterLock: projection.occupiedHeightAfterLock,
          visibleMarginAfterLock: projection.visibleMarginAfterLock,
          solvency: solvency.solvency,
          amountToppedOut: projection.amountToppedOut,
          solvent: solvency.solvent,
        },
      });
    }
  }

  const sortedEntries = [...accBySemantic.values()].sort((a, b) =>
    a.semanticKey.localeCompare(b.semanticKey, "en"),
  );

  const legalActions: LegalActionEntry[] = [];
  const indexBySemantic = new Map<string, number>();
  const indexByCell = new Map<string, number>();

  for (let idx = 0; idx < sortedEntries.length; idx += 1) {
    const item = sortedEntries[idx] as ActionAccum;
    legalActions.push({
      actionIndex: idx,
      semanticKey: item.semanticKey,
      cellKey: item.cellKey,
      piece: item.piece,
      usedHold: item.usedHold,
      reachableWithout180: item.reachableWithout180,
      witnesses: item.witnesses,
      referee: item.referee,
    });
    indexBySemantic.set(item.semanticKey, idx);
    if (!indexByCell.has(item.cellKey)) {
      indexByCell.set(item.cellKey, idx);
    }
  }

  return { legalActions, indexBySemantic, indexByCell, no180SemanticSet };
}

function resolveIdentityToActionIndex(
  canonicalState: CanonicalState,
  geometry: PlacementGeometryMap,
  identityStr: string,
  legal: LegalActionsBuildResult,
): { actionIndex: number; semanticKey: string } {
  const parsed = JSON.parse(identityStr) as {
    location?: { type: string; orientation: string; x: number; y: number };
    spin?: string;
  };
  if (parsed.location === undefined) {
    return { actionIndex: -1, semanticKey: identityStr };
  }
  const placement = cc2MoveToCanonicalPlacement(
    { queue: [canonicalState.pieces.current] },
    parsed,
  ) as CanonicalPlacement;
  const blocks = pieceBlocksAtPose(geometry, placement);
  const cKey = canonicalCellsKey(blocks);
  const spin = mapCc2Spin(parsed.spin ?? "none");
  const primarySemantic = `${placement.piece}:${placement.usedHold ? 1 : 0}:${spin}:${cKey}`;
  const exactIdx = legal.indexBySemantic.get(primarySemantic);
  if (exactIdx !== undefined) {
    return { actionIndex: exactIdx, semanticKey: primarySemantic };
  }
  const cellKey0 = `${placement.piece}:${placement.usedHold ? 1 : 0}:${cKey}`;
  const cellIdx0 = legal.indexByCell.get(cellKey0);
  if (cellIdx0 !== undefined) {
    const matched = legal.legalActions[cellIdx0] as LegalActionEntry;
    return { actionIndex: cellIdx0, semanticKey: matched.semanticKey };
  }
  if (!placement.usedHold && canonicalState.pieces.holdAvailable) {
    const sem1 = `${placement.piece}:1:${spin}:${cKey}`;
    const idx1 = legal.indexBySemantic.get(sem1);
    if (idx1 !== undefined) {
      return { actionIndex: idx1, semanticKey: sem1 };
    }
    const cellIdx1 = legal.indexByCell.get(`${placement.piece}:1:${cKey}`);
    if (cellIdx1 !== undefined) {
      const matched = legal.legalActions[cellIdx1] as LegalActionEntry;
      return { actionIndex: cellIdx1, semanticKey: matched.semanticKey };
    }
  }
  return { actionIndex: -1, semanticKey: primarySemantic };
}

export interface TeacherEngineOptions {
  readonly botType?: string;
  readonly selectionLimit?: number;
  readonly seed?: string;
}

export interface ChampionEvalSuccess {
  readonly ok: true;
  readonly resolved: ChampionResolvedResult;
  readonly request: Record<string, unknown>;
  readonly response: F14Response;
  readonly label: TeacherLabel;
  readonly latencyMs: number;
}

export interface ChampionEvalNoMove {
  readonly ok: false;
  readonly status: string;
  readonly reason: string | null;
}

export type ChampionEvalOutcome = ChampionEvalSuccess | ChampionEvalNoMove;

function buildTeacherLabelFromResponse(args: {
  readonly botType: string;
  readonly profileId: string;
  readonly configHash: string;
  readonly sessionMode: "persistent" | "fresh";
  readonly canonicalState: CanonicalState;
  readonly legal: LegalActionsBuildResult;
  readonly resolved: ChampionResolvedResult;
  readonly response: F14Response;
}): TeacherLabel {
  const { botType, profileId, configHash, sessionMode, canonicalState, legal, resolved, response } =
    args;
  const rules = resolvePlacementRules(canonicalState.rulesetId);
  const geometry = placementGeometry(rules) as PlacementGeometryMap;
  const incoming = createS2AmountOnlyDecisionState(canonicalState).incoming;

  const selPlacement = resolved.placement;
  const selProj = projectS2AmountOnlyLock(
    canonicalState,
    { kind: "placement", placement: selPlacement },
    incoming,
  );
  const selBlocks = pieceBlocksAtPose(geometry, selPlacement);
  const selectedSemanticKey = `${selPlacement.piece}:${selPlacement.usedHold ? 1 : 0}:${selProj.spin}:${canonicalCellsKey(selBlocks)}`;
  let selectedActionIndex = legal.indexBySemantic.get(selectedSemanticKey) ?? -1;
  if (selectedActionIndex < 0) {
    selectedActionIndex =
      legal.indexByCell.get(
        `${selPlacement.piece}:${selPlacement.usedHold ? 1 : 0}:${canonicalCellsKey(selBlocks)}`,
      ) ?? -1;
  }

  const ranking = response.ranking ?? {};
  const identities = ranking.identities ?? [];
  const returnedIdentities = ranking.returnedIdentities ?? [];
  const rootValuesArr = response.diagnostics?.rootValues ?? null;
  const rawCandidates = ranking.candidates ?? [];

  const candByIdentity = new Map<string, F14RankedCandidateRaw>();
  for (const c of rawCandidates) {
    if (typeof c.cc2Rank === "number" && returnedIdentities[c.cc2Rank]) {
      candByIdentity.set(returnedIdentities[c.cc2Rank] as string, c);
    }
  }

  const ranked: TeacherRankedCandidate[] = [];
  const seenRankedActions = new Set<number>();
  for (let rank = 0; rank < identities.length; rank += 1) {
    const idStr = identities[rank] as string;
    const cand = candByIdentity.get(idStr) ?? rawCandidates[rank];
    const cc2Rank = typeof cand?.cc2Rank === "number" ? cand.cc2Rank : rank;
    const mapped = resolveIdentityToActionIndex(canonicalState, geometry, idStr, legal);
    if (mapped.actionIndex >= 0 && seenRankedActions.has(mapped.actionIndex)) {
      continue;
    }
    if (mapped.actionIndex >= 0) seenRankedActions.add(mapped.actionIndex);
    const rv =
      rootValuesArr !== null && typeof rootValuesArr[cc2Rank] === "number"
        ? (rootValuesArr[cc2Rank] as number)
        : null;
    ranked.push({
      rank,
      cc2Rank,
      actionIndex: mapped.actionIndex,
      semanticKey: mapped.semanticKey,
      s2Score: typeof cand?.s2Score === "number" ? cand.s2Score : 0,
      selectionScore: typeof cand?.selectionScore === "number" ? cand.selectionScore : 0,
      rootValue: rv,
      solvency: typeof cand?.solvency === "number" ? cand.solvency : 0,
      solvent: Boolean(cand?.solvent),
      conversionBranch:
        typeof cand?.conversionBranch === "string" ? cand.conversionBranch : "other",
      conversionUnits: typeof cand?.conversionUnits === "number" ? cand.conversionUnits : 0,
    });
  }

  const rootChildren: TeacherRootChild[] = [];
  const seenRootChildActions = new Set<number>();
  const rawRootChildren = response.diagnostics?.rootChildValues?.children ?? [];
  for (const child of rawRootChildren) {
    if (typeof child.identity !== "string") continue;
    const mapped = resolveIdentityToActionIndex(canonicalState, geometry, child.identity, legal);
    if (mapped.actionIndex >= 0 && seenRootChildActions.has(mapped.actionIndex)) {
      continue;
    }
    if (mapped.actionIndex >= 0) seenRootChildActions.add(mapped.actionIndex);
    rootChildren.push({
      actionIndex: mapped.actionIndex,
      semanticKey: mapped.semanticKey,
      value: typeof child.value === "number" ? child.value : 0,
      draws: typeof child.draws === "number" ? child.draws : 0,
    });
  }

  const rankZeroEntry = ranked[0];
  const rankZeroActionIndex = rankZeroEntry?.actionIndex ?? selectedActionIndex;
  const rankZeroSemanticKey = rankZeroEntry?.semanticKey ?? selectedSemanticKey;

  const rootValueTop1 = rankZeroEntry?.rootValue ?? null;
  const rootValueSecond = ranked[1]?.rootValue ?? null;
  const rootValueMargin12 =
    rootValueTop1 !== null && rootValueSecond !== null ? rootValueTop1 - rootValueSecond : null;

  const selectionTop1 = rankZeroEntry?.selectionScore ?? null;
  const selectionSecond = ranked[1]?.selectionScore ?? null;
  const selectionMargin12 =
    selectionTop1 !== null && selectionSecond !== null ? selectionTop1 - selectionSecond : null;

  const rawReuse = response.search?.reuse;
  const reuse: TeacherReuseStats | null =
    rawReuse !== undefined
      ? {
          reused: Boolean(rawReuse.reused),
          inherited: Number(rawReuse.inherited ?? 0),
          credited: Number(rawReuse.credited ?? 0),
          newSelections: Number(rawReuse.newSelections ?? 0),
          reason: String(rawReuse.reason ?? ""),
        }
      : null;

  const selectedActionObj =
    selectedActionIndex >= 0 ? legal.legalActions[selectedActionIndex] : undefined;

  return {
    botId: botType,
    profileId,
    configHash,
    sessionMode,
    reuse,
    selectedActionIndex,
    selectedSemanticKey,
    selectedInAllow180False: selectedActionObj?.reachableWithout180 ?? false,
    rankZeroActionIndex,
    rankZeroSemanticKey,
    rescueApplied: Boolean(ranking.rescueApplied),
    rootValueTop1,
    rootValueMargin12,
    selectionMargin12,
    ranked,
    rootChildren,
  };
}

const EMPTY_LEGAL_RESULT: LegalActionsBuildResult = {
  legalActions: [],
  indexBySemantic: new Map(),
  indexByCell: new Map(),
  no180SemanticSet: new Set(),
};

/**
 * Manages a single persistent WASM champion driver session and isolated fresh-session probes.
 */
export class TeacherOracle {
  readonly botType: string;
  readonly params: Record<string, unknown>;
  readonly profile: Record<string, unknown>;
  readonly configHash: string;
  readonly wasmSha256: string;
  private readonly wasmBytes: Uint8Array;
  private persistentSession: Cc2WasmSession | null = null;
  private reqCounter = 0;

  constructor(options: TeacherEngineOptions = {}) {
    this.botType = options.botType ?? "cc2-s2-champion";
    const baseParams = defaultBotParameters(this.botType) as Record<string, unknown>;
    this.params =
      options.selectionLimit !== undefined
        ? { ...baseParams, selectionLimit: options.selectionLimit }
        : baseParams;
    this.profile = champion.createChampionProfile(this.params, this.botType) as Record<
      string,
      unknown
    >;
    const { wasmBytes, wasmSha256 } = getChampionWasmBytes();
    this.wasmBytes = wasmBytes;
    this.wasmSha256 = wasmSha256;
    this.configHash = sha256Json({
      botType: this.botType,
      profile: this.profile,
      wasmSha256,
    });
  }

  private async ensurePersistentSession(): Promise<Cc2WasmSession> {
    if (this.persistentSession === null) {
      this.persistentSession = (await createCc2WasmSession({
        wasmBytes: this.wasmBytes,
      })) as Cc2WasmSession;
    }
    return this.persistentSession;
  }

  private async evaluateWithSession(
    session: Cc2WasmSession,
    sessionMode: "persistent" | "fresh",
    canonicalState: CanonicalState,
    legal: LegalActionsBuildResult | undefined,
    guiOverride?: Record<string, unknown>,
  ): Promise<ChampionEvalOutcome> {
    const t0 = performance.now();
    const gui = guiOverride ?? canonicalToGuiState(canonicalState);
    this.reqCounter += 1;
    const baseRequest = champion.createChampionRequest(canonicalState, this.params, {
      requestId: `${sessionMode}-${this.botType}-${this.reqCounter}`,
      generation: this.reqCounter,
      type: this.botType,
    }) as Record<string, unknown>;
    const skipLabel = legal === undefined;
    const requestWithDiagnostics = skipLabel
      ? baseRequest
      : {
          ...baseRequest,
          diagnostics: { rootValues: true, rootChildValues: true },
        };
    const response = await session.decideF14({
      request: requestWithDiagnostics,
      profile: this.profile,
    });
    if (response.status !== "move") {
      return {
        ok: false,
        status: String(response.status ?? "unknown"),
        reason: typeof response.reason === "string" ? response.reason : null,
      };
    }
    const resolved = champion.resolveChampionDecision({
      state: canonicalState,
      gui,
      request: baseRequest,
      response,
      parameters: this.params,
      type: this.botType,
    }) as ChampionResolvedResult;
    const label = buildTeacherLabelFromResponse({
      botType: this.botType,
      profileId: String(this.profile.profileId ?? ""),
      configHash: this.configHash,
      sessionMode,
      canonicalState,
      legal: legal ?? EMPTY_LEGAL_RESULT,
      resolved,
      response,
    });
    return {
      ok: true,
      resolved,
      request: baseRequest,
      response,
      label,
      latencyMs: performance.now() - t0,
    };
  }

  async decidePersistent(
    canonicalState: CanonicalState,
    legal: LegalActionsBuildResult | undefined,
    guiOverride?: Record<string, unknown>,
  ): Promise<ChampionEvalOutcome> {
    const session = await this.ensurePersistentSession();
    return this.evaluateWithSession(session, "persistent", canonicalState, legal, guiOverride);
  }

  async decideFresh(
    canonicalState: CanonicalState,
    legal: LegalActionsBuildResult,
    guiOverride?: Record<string, unknown>,
  ): Promise<ChampionEvalOutcome> {
    const freshSession = (await createCc2WasmSession({
      wasmBytes: this.wasmBytes,
    })) as Cc2WasmSession;
    try {
      return await this.evaluateWithSession(
        freshSession,
        "fresh",
        canonicalState,
        legal,
        guiOverride,
      );
    } finally {
      await freshSession.close();
    }
  }

  async resetPersistentTree(): Promise<void> {
    if (this.persistentSession !== null) {
      await this.persistentSession.close();
      this.persistentSession = null;
    }
  }

  async close(): Promise<void> {
    await this.resetPersistentTree();
  }
}

/**
 * Computes VariantAnnotation (`existing` or `corrected`) on a canonical observation.
 */
export function annotateRecordVariant(args: {
  readonly observation: PublicObservationRecord;
  readonly legalActions: readonly LegalActionEntry[];
  readonly teacher: TeacherLabel;
  readonly variant: Exclude<DriverVariant, "corrected_augmented">;
  readonly weights: Weights;
  readonly weightsId: string;
  readonly width?: number;
  readonly augmentedWeights?: readonly number[];
}): VariantAnnotation {
  const input = searchInputFromObservation(args.observation);
  const width = args.width ?? 48;
  const report = runVariantSearch(input, args.variant, {
    weights: args.weights,
    width,
    augmentedWeights: args.augmentedWeights,
    completePrunedRoots: true,
  });
  const bestStep = report.searchResult?.best ?? null;
  const bestCandidate =
    bestStep !== null
      ? report.candidates.find(
          (c) =>
            c.placement.kind === bestStep.placement.kind &&
            c.placement.rotation === bestStep.placement.rotation &&
            c.placement.x === bestStep.placement.x &&
            c.placement.y === bestStep.placement.y &&
            c.usedHold === bestStep.usedHold,
        )
      : undefined;
  return buildVariantAnnotation({
    weightsId: args.weightsId,
    width,
    depth: report.depth,
    nodes: report.nodes,
    bestSemanticKey: bestCandidate?.semanticKey ?? null,
    rootCandidates: report.candidates,
    legalActions: args.legalActions,
    teacher: args.teacher,
  });
}

export interface AssembleDecisionRecordArgs {
  readonly source: DatasetSource;
  readonly gameId: string;
  readonly seed: number;
  readonly ply: number;
  readonly actorSeat: string;
  readonly actorBot: string;
  readonly opponentBot: string;
  readonly tacticalTag: string | null;
  readonly canonicalState: CanonicalState;
  readonly legal: LegalActionsBuildResult;
  readonly teacher: TeacherLabel;
  readonly freshTeacher: TeacherLabel | null;
  readonly existingAnnotation?: VariantAnnotation;
  readonly correctedAnnotation?: VariantAnnotation;
}

export function assembleDecisionRecord(args: AssembleDecisionRecordArgs): DecisionRecord {
  const observation = publicObservationFromState(args.canonicalState);
  const maxHeightRoot = occupiedHeightFromCells(observation.board.cells);
  const stratification = classifyStratification({
    maxHeightRoot,
    pendingRows: observation.incoming.pendingRows,
    dueThisLockRows: observation.incoming.dueThisLockRows,
    b2b: observation.chain.b2b,
    combo: observation.chain.combo,
    legalActions: args.legal.legalActions,
    rescueActivated: args.teacher.rescueApplied,
  });
  const freshAgreement =
    args.freshTeacher !== null
      ? {
          agreesSelected:
            args.freshTeacher.selectedActionIndex === args.teacher.selectedActionIndex,
          agreesRankZero:
            args.freshTeacher.rankZeroActionIndex === args.teacher.rankZeroActionIndex,
        }
      : null;

  return {
    schema: "attax-s2-imitation/1",
    recordId: `${args.source}:s${args.seed}:${args.gameId}:p${args.ply}`,
    source: args.source,
    gameId: args.gameId,
    seed: args.seed,
    split: splitForSeed(args.seed),
    ply: args.ply,
    actorSeat: args.actorSeat,
    actorBot: args.actorBot,
    opponentBot: args.opponentBot,
    tacticalTag: args.tacticalTag,
    observation,
    legalActions: args.legal.legalActions,
    teacher: args.teacher,
    freshTeacher: args.freshTeacher,
    freshAgreement,
    stratification,
    annotations: {
      ...(args.existingAnnotation ? { existing: args.existingAnnotation } : {}),
      ...(args.correctedAnnotation ? { corrected: args.correctedAnnotation } : {}),
    },
  };
}

export { weightsToVector24 };
