import type { Board } from "../core/board.js";
import { attackForClear } from "../core/garbage.js";
import type { PieceKind } from "../core/pieces.js";
import type { AiDebug, AiMove, GameSnapshot } from "../ui/types.js";
import { beamBestMove, createBeamEvaluation, type PlyContext } from "./beam.js";
import { extractFeatures } from "./features.js";
import {
  type V8Emerg,
  v8BumpExWell,
  v8Capped,
  v8CountHoles,
  v8CountTslots,
  v8Emergency,
  v8FloatWell,
  v8HeightPressure,
  v8Heights,
  v8High,
  v8Hopeless,
  v8MaxExWell,
  v8MaxOf,
  v8Veto,
  v8WastedI,
  v8WastedT,
  v8WellCol,
  v8WellDepth,
} from "./redV8-score.js";
import { v9SpawnPressure } from "./redV9-score.js";
import { ROWS } from "./types.js";
import { DU_WEIGHTS, FIRE_WEIGHTS, type Weights } from "./weights.js";

const RED_WEIGHTS: Weights = {
  ...DU_WEIGHTS,
  holes: -14.5,
  wells: -11.0,
  rowsWithHoles: -26.0,
  maxHeight: -3.6,
};

const ATK_W = 142;
const TSPIN_EXEC = 215;
const TETRIS_EXEC = 340;
const B2B_CHAIN = 140;
const B2B_BREAK_PEN = 130;
const HOLE_EXTRA = 18;
const CAVITY_STEP = 25;
const OPENING_N = 30;
const URGENCY_W = 32;
const DIG_BONUS = 145;
const DIG_HOLD = 45;
const COMBO_KEEP = 60;
const COMBO_BREAK = 60;
const REN_STEP = 60;
const REN_START = 1;
const REN_LATE_N = 250;
const REN_LATE_STEP = 110;
const EMERG_STEP = 160;
const EMERG_LINE = 12;
const EMERG_LINE_SPIKE = 10;
const EMERG_SPIKE = 4;
const SETUP_MIN_H = 4;
const GAMMA = 0.55;
const WELL_KEEP = 16;
const WELL_SUSTAIN = 12;
const TSLOT_KEEP = 38;
const TSLOT_RESV = 14;
const TSD_ARRIVAL = 360;
const TETRIS_ARRIVAL = 480;
const TSD_EXEC_DEEP = 215;
const TETRIS_EXEC_DEEP = 340;
const WELL_FILL_STEP = 100;
const WELL_EDGE_BONUS = 30;
const WELL_CENTER_PEN = 50;
const LATE_PIECE_N = 60;
const LATE_MULT = 1.15;
const HOLE_FILL_STEP = 90;
const HOLE_GROW_PEN = 60;
const FLOAT_FIRE_STEP = 80;
const REBUILD_STEP = 20;
const REN_CALM_KEEP = 30;
const TSLOT_CYCLE = 45;

interface Last {
  readonly score: number;
  readonly fire: number;
  readonly lines: number;
  readonly tspin: boolean;
  readonly holes: number;
  readonly height: number;
  readonly ms: number;
}

function isEmpty(b: Board): boolean {
  for (let y = 0; y < b.length; y += 1) if ((b[y] ?? 0) !== 0) return false;
  return true;
}

function queueHas(q: readonly PieceKind[], k: PieceKind, n: number): boolean {
  for (let i = 0; i < n && i < q.length; i += 1) if (q[i] === k) return true;
  return false;
}

export function createFighterB(): {
  readonly name: string;
  findBestMove(snapshot: GameSnapshot): AiMove | null;
  getDebug(): AiDebug | null;
} {
  let last: Last | null = null;
  let pcs = 0;
  return {
    name: "RED",
    findBestMove: (s) => {
      const t0 = performance.now();
      if (s.active === null || s.gameOver) return null;
      pcs += 1;
      const seen = pcs;
      const board = toBoard(s);
      const pending = s.pendingGarbage;
      const hold = s.hold;
      const queue = s.next.slice(0, 5);
      const skyH = v8Heights(board);
      const skyWell = v8WellCol(skyH);
      const skyMaxEx = v8MaxExWell(skyH, skyWell);
      const skyMax = v8MaxOf(skyH);
      const skyHoles = v8CountHoles(board, skyH);
      const tallBoard = skyMaxEx >= 12;

      const redAdjust = (after: Board, lines: number, tspin: boolean): number => {
        const h = v8Heights(after);
        const holes = v8CountHoles(after, h);
        let adj = -(v8Capped(after, h) * 30 + v8High(after) * 25);
        if (seen <= OPENING_N) adj -= holes * HOLE_EXTRA;
        void lines;
        void tspin;
        return adj;
      };

      const redVeto = (after: Board, lines: number, tspin: boolean): boolean => {
        if (tallBoard || pending > 0) {
          const h = v8Heights(after);
          if (tspin && lines === 0 && v8Hopeless(after, h, pending)) return true;
          return false;
        }
        return v8Veto(after, lines, pending, tspin);
      };

      const redScorer = (after: Board, lines: number, tspin: boolean, ctx: PlyContext): number => {
        const feat = extractFeatures(after, 0, 0);
        const ncombo = lines > 0 ? ctx.combo + 1 : -1;
        const late = pcs >= LATE_PIECE_N ? LATE_MULT : 1;
        const pend = ctx.pending;
        const digNow = pend >= EMERG_SPIKE;
        const emergLineNow = digNow ? EMERG_LINE_SPIKE : EMERG_LINE;
        let sc =
          attackForClear({
            lines,
            tspinLines: tspin ? lines : 0,
            combo: ncombo,
            b2bActive: ctx.b2b,
            perfectClear: isEmpty(after),
          }) *
          ATK_W *
          late;
        if (tspin && lines > 0) sc += TSPIN_EXEC + TSD_ARRIVAL / (ctx.ply + 1);
        if (lines === 4) sc += TETRIS_EXEC + TETRIS_ARRIVAL / (ctx.ply + 1);
        // Execute trigger: partially filled well converts to Tetris damage.
        if (lines > 0 && lines < 4 && !tspin && ctx.ply <= 2) {
          const h = v8Heights(after);
          const well = Math.min(6, v8WellDepth(after, v8WellCol(h), 6));
          if (well >= 4 && v8MaxOf(h) <= 12) sc += ((well - 3) * WELL_FILL_STEP) / (ctx.ply + 1);
          else {
            const floatWell = Math.min(6, v8FloatWell(after, h, 6));
            if (floatWell >= 4 && v8MaxOf(h) <= 16)
              sc += ((floatWell - 3) * FLOAT_FIRE_STEP) / (ctx.ply + 1);
          }
        }
        if ((lines === 4 || (tspin && lines > 0)) && ctx.b2b) sc += B2B_CHAIN;
        if (lines > 0 && lines < 4 && !tspin && ctx.b2b) {
          const emerg: V8Emerg = v8Emergency(pend, v8MaxOf(v8Heights(after)));
          if (emerg !== 2) {
            const tAhead = v8CountTslots(after, 1) > 0 || queueHas(queue, "T", 3) || hold === "T";
            if (tAhead && ctx.ply <= 2) sc += TSLOT_CYCLE / (ctx.ply + 1);
            else sc -= B2B_BREAK_PEN;
          }
        }
        if (ctx.ply >= 1 && ctx.ply <= 3) {
          if (lines === 4) sc += TETRIS_EXEC_DEEP;
          if (tspin && lines > 0) sc += TSD_EXEC_DEEP;
        }
        if (lines === 0 && !tspin && feat.maxHeight >= SETUP_MIN_H && !digNow && !tallBoard) {
          const decay = GAMMA ** ctx.ply;
          const h = v8Heights(after);
          const well = v8WellCol(h);
          const depth = Math.min(6, v8WellDepth(after, well, 6));
          const emerg: V8Emerg = v8Emergency(pend, v8MaxExWell(h, well));
          const wMult = emerg === 2 ? 0.2 : emerg === 1 ? 0.5 : 1;
          const tMult = emerg === 2 ? 0.3 : emerg === 1 ? 0.6 : 1;
          sc += depth * WELL_KEEP * decay * wMult;
          if (depth >= 4) sc += depth * WELL_SUSTAIN * decay * wMult;
          if (well === 0 || well === 9) sc += depth > 0 ? WELL_EDGE_BONUS * decay * wMult : 0;
          else sc -= depth > 0 ? WELL_CENTER_PEN * decay * wMult : 0;
          sc += Math.min(2, v8CountTslots(after, 2)) * TSLOT_KEEP * decay * tMult;
          // Empty-hold T/I strategy: reserve value when a spinner is banked.
          if (hold === "T" || hold === "I") sc += TSLOT_RESV * decay;
          else if (
            ctx.redV7Piece !== "T" &&
            ctx.redV7Piece !== "I" &&
            (queueHas(queue, "T", 3) || queueHas(queue, "I", 3))
          )
            sc += (TSLOT_RESV * decay) / 2;
          const setups = v8CountTslots(after, 99);
          if (setups > 2) sc -= (setups - 2) * CAVITY_STEP * decay;
          const bump = v8BumpExWell(h, well);
          if (bump > 8) sc -= (bump - 8) * 22 * decay;
        }
        // Late REN engine: reward combo from the first chain link.
        if (lines > 0 && ncombo >= REN_START) {
          const renStep = pcs >= REN_LATE_N ? REN_LATE_STEP : REN_STEP;
          sc += ncombo * renStep * late;
        }
        if (ctx.combo >= 2 && lines > 0) sc += COMBO_KEEP;
        else if (ctx.combo >= 2 && lines === 0 && !tspin) {
          const calm = pend === 0 && v8MaxOf(v8Heights(after)) <= 10;
          if (calm && ctx.ply <= 2) sc += REN_CALM_KEEP / (ctx.ply + 1);
          else sc -= COMBO_BREAK;
        }
        // I/T budgets: never burn a spinner on weak clears outside emergency.
        const hNow = v8Heights(after);
        const emergNow: V8Emerg = v8Emergency(pend, v8MaxExWell(hNow, v8WellCol(hNow)));
        sc += v8WastedT(ctx.redV7Piece, lines, tspin, emergNow);
        sc += v8WastedI(ctx.redV7Piece, lines, emergNow);
        if (tallBoard && lines > 0) sc += skyMax * 12 * lines;
        // hMax emergency mode: height pressure + dig urgency under spikes.
        if (emergNow > 0 && lines === 0 && !tspin) {
          sc -= v8HeightPressure(v8MaxExWell(hNow, v8WellCol(hNow)));
        }
        if (tallBoard && lines === 0 && !tspin && skyMax >= 16) {
          sc -= (skyMax - 15) * 300;
        }
        // v9 spawn-corridor pressure.
        if (lines === 0 && !tspin) sc -= v9SpawnPressure(hNow);
        if (pend > 0 || tallBoard) {
          if (lines > 0) {
            sc += pend * lines * URGENCY_W + DIG_BONUS * lines * (digNow ? 2 : 1);
            if (tallBoard && pend === 0) sc += DIG_BONUS * lines;
            const holesAfter = v8CountHoles(after, hNow);
            if (ctx.ply === 0) {
              const filled = skyHoles - holesAfter;
              if (filled > 0) sc += filled * HOLE_FILL_STEP * (digNow || tallBoard ? 2 : 1);
              else if (filled < 0) sc += filled * HOLE_GROW_PEN;
            } else if (holesAfter > 0) {
              sc -= holesAfter * HOLE_GROW_PEN * (digNow || tallBoard ? 1 : 0.5);
            }
          } else if (feat.maxHeight >= emergLineNow)
            sc -= (feat.maxHeight - emergLineNow + 1) * EMERG_STEP;
          else if (!tallBoard) sc -= DIG_HOLD;
        }
        if (lines === 0 && !tspin && ctx.b2b && ctx.ply >= 1 && ctx.ply <= 3) {
          const h = v8Heights(after);
          const well = v8WellCol(h);
          if (well === 0 || well === 9) {
            const depth = Math.min(6, v8WellDepth(after, well, 6));
            if (depth >= 2) sc += depth * REBUILD_STEP * GAMMA ** ctx.ply;
          }
        }
        return sc;
      };

      const mv = beamBestMove(board, s.active.kind, queue, s.hold, s.canHold, s.b2b, s.combo, {
        weights: RED_WEIGHTS,
        fireWeights: { ...FIRE_WEIGHTS, wellStep: 7, tslotStep: 42 },
        depth: 6,
        width: 32,
        topK: 20,
        useHold: true,
        pending,
        useKick: false,
        evaluation: createBeamEvaluation({
          scoreAdjust: redAdjust,
          scorer: redScorer,
          legacyVeto: redVeto,
        }),
      });
      if (mv === null) return null;
      const feat = extractFeatures(mv.after, 0, 0);
      last = {
        score: mv.score,
        fire: mv.fireScore,
        lines: mv.linesCleared,
        tspin: mv.isTspin,
        holes: feat.holes,
        height: feat.maxHeight,
        ms: performance.now() - t0,
      };
      return {
        targetX: mv.x,
        targetRotation: mv.rotation,
        useHold: mv.useHold,
        ...(mv.execution === undefined ? {} : { execution: mv.execution }),
      };
    },
    getDebug: () =>
      last === null
        ? null
        : {
            score: last.score,
            fireScore: last.fire,
            linesCleared: last.lines,
            isTspin: last.tspin,
            opener: null,
            topHoles: last.holes,
            topMaxHeight: last.height,
            thinkMs: last.ms,
          },
  };
}

function toBoard(s: GameSnapshot): Board {
  const board: Board = new Uint16Array(ROWS);
  const rows = s.board.rows;
  for (let y = 0; y < rows && y < ROWS; y += 1) {
    const src = s.board.grid[rows - 1 - y];
    if (src === undefined) continue;
    let bits = 0;
    for (let x = 0; x < 10; x += 1) if ((src[x] ?? 0) !== 0) bits |= 1 << x;
    board[y] = bits;
  }
  return board;
}
