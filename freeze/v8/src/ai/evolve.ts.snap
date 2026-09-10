import { type Board, cloneBoard, collides, dropY, lockAndClear } from "../core/board.js";
import {
  attackForClear,
  cancelPending,
  genGarbageHoles,
  type PendingChunk,
  pushIncoming,
  tickPending,
} from "../core/garbage.js";
import { bottomCellsOf, type PieceKind } from "../core/pieces.js";
import { extractFeatures, extractFireFeatures } from "./features.js";
import {
  DU_WEIGHTS,
  FIRE_WEIGHTS,
  type FireWeights,
  scoreFire,
  scorePlacement,
  type Weights,
} from "./weights.js";

export interface Genome {
  readonly weights: Weights;
  readonly fire: FireWeights;
}

export interface EvolveState {
  readonly generation: number;
  readonly population: readonly Genome[];
  readonly elo: readonly number[];
  readonly champion: number;
  readonly matchesPlayed: number;
}

export interface MatchResult {
  readonly winner: 0 | 1;
  readonly playerA: number;
  readonly playerB: number;
  readonly linesA: number;
  readonly linesB: number;
  readonly attackA: number;
  readonly attackB: number;
  readonly pieces: number;
  readonly seed: number;
}

export interface BattleEntry {
  readonly generation: number;
  readonly playerA: number;
  readonly playerB: number;
  readonly winner: 0 | 1;
  readonly linesA: number;
  readonly linesB: number;
  readonly attackA: number;
  readonly attackB: number;
  readonly pieces: number;
  readonly seed: number;
  readonly eloA: number;
  readonly eloB: number;
  readonly adoptedFrom: number;
  readonly adoptedDelta: number;
}

export interface EvolveOutcome {
  readonly state: EvolveState;
  readonly entry: BattleEntry;
}

const POPULATION = 4;
const STORAGE_KEY = "tetris-evolve-v1";
const MAX_PIECES_PER_MATCH = 150;

export function defaultGenome(): Genome {
  return { weights: DU_WEIGHTS, fire: FIRE_WEIGHTS };
}

export function initialState(): EvolveState {
  const population: Genome[] = [defaultGenome()];
  for (let i = 1; i < POPULATION; i += 1) {
    population.push(mutate(defaultGenome(), 0.35 + i * 0.15));
  }
  return {
    generation: 0,
    population,
    elo: population.map(() => 1500),
    champion: 0,
    matchesPlayed: 0,
  };
}

export function loadState(): EvolveState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return initialState();
    const parsed = JSON.parse(raw) as Partial<EvolveState>;
    if (!Array.isArray(parsed.population) || parsed.population.length !== POPULATION) {
      return initialState();
    }
    return {
      generation: typeof parsed.generation === "number" ? parsed.generation : 0,
      population: parsed.population,
      elo: Array.isArray(parsed.elo) ? parsed.elo : parsed.population.map(() => 1500),
      champion: typeof parsed.champion === "number" ? parsed.champion : 0,
      matchesPlayed: typeof parsed.matchesPlayed === "number" ? parsed.matchesPlayed : 0,
    };
  } catch {
    return initialState();
  }
}

export function saveState(state: EvolveState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    return;
  }
}

export function resetState(): EvolveState {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    return initialState();
  }
  return initialState();
}

function randn(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function mutate(genome: Genome, scale: number): Genome {
  const w = genome.weights;
  const f = genome.fire;
  const j = (v: number, rel: number): number =>
    v + randn() * Math.abs(v) * rel * scale + randn() * scale;
  return {
    weights: {
      landingHeight: j(w.landingHeight, 0.2),
      erodedCells: j(w.erodedCells, 0.2),
      rowTransitions: j(w.rowTransitions, 0.2),
      colTransitions: j(w.colTransitions, 0.2),
      holes: j(w.holes, 0.2),
      wells: j(w.wells, 0.2),
      holeDepth: j(w.holeDepth, 0.2),
      rowsWithHoles: j(w.rowsWithHoles, 0.2),
      bumpiness: j(w.bumpiness, 0.2),
      maxHeight: j(w.maxHeight, 0.2),
      linesCleared: j(w.linesCleared, 0.2),
    },
    fire: {
      tetris: j(f.tetris, 0.3),
      tspin: j(f.tspin, 0.3),
      tspinSingle: j(f.tspinSingle, 0.5),
      tspinDouble: j(f.tspinDouble, 0.3),
      tspinTriple: j(f.tspinTriple, 0.3),
      b2bBonus: j(f.b2bBonus, 0.3),
      comboStep: j(f.comboStep, 0.3),
      perfectClear: f.perfectClear,
    },
  };
}

export function attackOf(lines: number, tspinLines: number, combo: number, b2b: boolean): number {
  if (tspinLines === 3) return 6;
  if (tspinLines === 2) return 4;
  if (tspinLines === 1) return lines >= 1 ? 2 : 0;
  if (lines === 4) return b2b ? 5 : 4;
  if (lines === 3) return 2;
  if (lines === 2) return 1;
  if (combo >= 2) return 1;
  return 0;
}

interface SimSide {
  board: Board;
  queue: PieceKind[];
  hold: PieceKind | null;
  canHold: boolean;
  combo: number;
  b2b: boolean;
  lines: number;
  sent: number;
  blocked: number;
  pending: PendingChunk[];
  prevHole: number;
  dead: boolean;
}

function shuffled(seedRef: { s: number }): PieceKind[] {
  const bag: PieceKind[] = ["I", "O", "T", "S", "Z", "J", "L"];
  for (let i = bag.length - 1; i > 0; i -= 1) {
    seedRef.s = (seedRef.s * 1103515245 + 12345) % 2147483648;
    const j = Math.floor((seedRef.s / 2147483648) * (i + 1));
    const a = bag[i];
    const b = bag[j];
    if (a === undefined || b === undefined) continue;
    bag[i] = b;
    bag[j] = a;
  }
  return bag;
}

function pickMove(
  board: Board,
  piece: PieceKind,
  genome: Genome,
  combo: number,
  b2b: boolean,
): { readonly rotation: number; readonly x: number } | null {
  const r = genomeBestMove(board, piece, genome, combo, b2b);
  if (r === null) return null;
  return { rotation: r.rotation, x: r.x };
}

export interface GenomeMove {
  readonly rotation: number;
  readonly x: number;
  readonly score: number;
  readonly linesCleared: number;
  readonly holes: number;
}

export function genomeBestMove(
  board: Board,
  piece: PieceKind,
  genome: Genome,
  combo = -1,
  b2b = false,
): GenomeMove | null {
  let best: GenomeMove | null = null;
  const rots = piece === "O" ? 1 : 4;
  for (let r = 0; r < rots; r += 1) {
    const cells = bottomCellsOf(piece, r);
    let minX = 0;
    let maxX = 0;
    for (const c of cells) {
      if (c.x < minX) minX = c.x;
      if (c.x > maxX) maxX = c.x;
    }
    for (let px = -minX; px < 10 - maxX; px += 1) {
      if (collides(board, cells, px, board.length + 4)) continue;
      const y = dropY(board, cells, px, board.length + 4);
      const test = cloneBoard(board);
      if (collides(test, cells, px, y)) continue;
      const info = lockAndClear(test, cells, px, y);
      if (info.topOut && info.linesCleared === 0) continue;
      const avgLanding = cells.reduce((s, c) => s + (y + c.y + 1), 0) / cells.length;
      const feat = extractFeatures(
        test,
        avgLanding,
        info.linesCleared * info.pieceCellsInClearedRows,
      );
      const fire = extractFireFeatures({
        linesCleared: info.linesCleared,
        tspin: false,
        tspinLines: 0,
        b2bActive: b2b,
        combo: info.linesCleared > 0 ? combo + 1 : -1,
        perfectClear: false,
      });
      const score =
        scorePlacement(feat, info.linesCleared, genome.weights) + scoreFire(fire, genome.fire);
      if (best === null || score > best.score) {
        best = { rotation: r, x: px, score, linesCleared: info.linesCleared, holes: feat.holes };
      }
    }
  }
  return best;
}

export function playMatch(a: Genome, b: Genome, seed: number): MatchResult {
  const ref = { s: seed };
  const mkSide = (): SimSide => ({
    board: new Uint16Array(20),
    queue: [...shuffled(ref), ...shuffled(ref)],
    hold: null,
    canHold: true,
    combo: -1,
    b2b: false,
    lines: 0,
    sent: 0,
    blocked: 0,
    pending: [],
    prevHole: 4,
    dead: false,
  });
  const sideA = mkSide();
  const sideB = mkSide();
  sideB.queue = [...sideA.queue];
  let pieces = 0;
  for (let step = 0; step < MAX_PIECES_PER_MATCH; step += 1) {
    pieces = step + 1;
    const outgoing: Array<{ from: SimSide; to: SimSide; rows: number }> = [];
    for (const [side, genome] of [
      [sideA, a],
      [sideB, b],
    ] as const) {
      if (side.dead) continue;
      const cur = side.queue.shift();
      if (cur === undefined) {
        side.dead = true;
        continue;
      }
      if (side.queue.length < 7) side.queue.push(...shuffled(ref));
      const mv = pickMove(side.board, cur, genome, side.combo, side.b2b);
      if (mv === null) {
        side.dead = true;
        continue;
      }
      const cells = bottomCellsOf(cur, mv.rotation);
      const y = dropY(side.board, cells, mv.x, side.board.length + 4);
      if (collides(side.board, cells, mv.x, y)) {
        side.dead = true;
        continue;
      }
      const info = lockAndClear(side.board, cells, mv.x, y);
      if (info.topOut && info.linesCleared === 0) {
        side.dead = true;
        continue;
      }
      if (info.linesCleared > 0) {
        side.combo += 1;
        side.lines += info.linesCleared;
        const attack = attackForClear({
          lines: info.linesCleared,
          tspinLines: 0,
          combo: side.combo,
          b2bActive: side.b2b,
          perfectClear: isEmptyBoard(side.board),
        });
        const blocked = cancelPending(side.pending, attack);
        side.blocked += blocked;
        const sent = attack - blocked;
        side.sent += sent;
        if (sent > 0) {
          outgoing.push({ from: side, to: side === sideA ? sideB : sideA, rows: sent });
        }
        side.b2b = info.linesCleared === 4 ? true : false;
      } else {
        side.combo = -1;
      }
      const due = tickPending(side.pending);
      if (due > 0) spawnGarbage(side, due, ref);
      let maxH = 0;
      for (let yy = 19; yy >= 0; yy -= 1) {
        if ((side.board[yy] ?? 0) !== 0) {
          maxH = yy + 1;
          break;
        }
      }
      if (maxH >= 20) side.dead = true;
    }
    for (const o of outgoing) {
      if (o.to.dead) continue;
      pushIncoming(o.to.pending, o.rows);
    }
    if (sideA.dead || sideB.dead) break;
  }
  let winner: 0 | 1;
  if (sideA.dead && sideB.dead) {
    winner = sideA.sent === sideB.sent ? 0 : sideA.sent > sideB.sent ? 0 : 1;
  } else if (sideB.dead) {
    winner = 0;
  } else if (sideA.dead) {
    winner = 1;
  } else {
    winner =
      sideA.sent === sideB.sent
        ? sideA.lines >= sideB.lines
          ? 0
          : 1
        : sideA.sent > sideB.sent
          ? 0
          : 1;
  }
  return {
    winner,
    playerA: -1,
    playerB: -1,
    linesA: sideA.lines,
    linesB: sideB.lines,
    attackA: sideA.sent,
    attackB: sideB.sent,
    pieces,
    seed,
  };
}

function isEmptyBoard(board: Board): boolean {
  for (let y = 0; y < board.length; y += 1) {
    if ((board[y] ?? 0) !== 0) return false;
  }
  return true;
}

function spawnGarbage(side: SimSide, count: number, ref: { s: number }): void {
  const rand = (): number => {
    ref.s = (ref.s * 1103515245 + 12345) % 2147483648;
    return ref.s / 2147483648;
  };
  const { holes, prevHole } = genGarbageHoles(count, rand, side.prevHole);
  side.prevHole = prevHole;
  const rows = side.board.length;
  for (const hole of holes) {
    let bits = 0x3ff;
    bits &= ~(1 << hole);
    for (let y = rows - 1; y > 0; y -= 1) {
      side.board[y] = side.board[y - 1] ?? 0;
    }
    side.board[0] = bits;
  }
}

export function updateElo(eloA: number, eloB: number, winner: 0 | 1): readonly [number, number] {
  const k = 32;
  const expectedA = 1 / (1 + 10 ** ((eloB - eloA) / 400));
  const scoreA = winner === 0 ? 1 : 0;
  return [eloA + k * (scoreA - expectedA), eloB + k * (1 - scoreA - (1 - expectedA))];
}

export function evolveOneMatch(state: EvolveState, seed: number): EvolveOutcome {
  const n = state.population.length;
  const i = Math.floor(Math.random() * n);
  let j = Math.floor(Math.random() * n);
  if (j === i) j = (j + 1) % n;
  const genomeA = state.population[i];
  const genomeB = state.population[j];
  if (genomeA === undefined || genomeB === undefined) {
    return {
      state,
      entry: {
        generation: state.generation,
        playerA: i,
        playerB: j,
        winner: 0,
        linesA: 0,
        linesB: 0,
        attackA: 0,
        attackB: 0,
        pieces: 0,
        seed,
        eloA: state.elo[i] ?? 1500,
        eloB: state.elo[j] ?? 1500,
        adoptedFrom: -1,
        adoptedDelta: 0,
      },
    };
  }
  const raw = playMatch(genomeA, genomeB, seed);
  const result: MatchResult = { ...raw, playerA: i, playerB: j };
  const winnerIdx = result.winner === 0 ? i : j;
  const loserIdx = result.winner === 0 ? j : i;
  const elo = [...state.elo];
  const [nextI, nextJ] =
    result.winner === 0
      ? updateElo(elo[i] ?? 1500, elo[j] ?? 1500, 0)
      : updateElo(elo[i] ?? 1500, elo[j] ?? 1500, 1);
  elo[i] = nextI ?? 1500;
  elo[j] = nextJ ?? 1500;
  const winner = state.population[winnerIdx];
  const loser = state.population[loserIdx];
  const population = [...state.population];
  let adoptedDelta = 0;
  if (winner !== undefined && loser !== undefined) {
    const child = mutate(winner, 0.35);
    adoptedDelta = genomeDistance(loser, child);
    population[loserIdx] = child;
  }
  let champion = state.champion;
  let bestElo = elo[champion] ?? 1500;
  elo.forEach((e, idx) => {
    if ((e ?? 0) > bestElo) {
      bestElo = e ?? 0;
      champion = idx;
    }
  });
  const next: EvolveState = {
    generation: state.generation + 1,
    population,
    elo,
    champion,
    matchesPlayed: state.matchesPlayed + 1,
  };
  return {
    state: next,
    entry: {
      generation: next.generation,
      playerA: i,
      playerB: j,
      winner: result.winner,
      linesA: result.linesA,
      linesB: result.linesB,
      attackA: result.attackA,
      attackB: result.attackB,
      pieces: result.pieces,
      seed,
      eloA: elo[i] ?? 1500,
      eloB: elo[j] ?? 1500,
      adoptedFrom: winnerIdx,
      adoptedDelta,
    },
  };
}

function genomeDistance(a: Genome, b: Genome): number {
  const keys: ReadonlyArray<keyof Weights> = [
    "landingHeight",
    "erodedCells",
    "rowTransitions",
    "colTransitions",
    "holes",
    "wells",
    "holeDepth",
    "rowsWithHoles",
    "bumpiness",
    "maxHeight",
    "linesCleared",
  ];
  let sum = 0;
  for (const k of keys) {
    const d = b.weights[k] - a.weights[k];
    sum += d * d;
  }
  return Math.sqrt(sum);
}
