/** Aggregate match records into the numbers the report and the web page show. */
import type { MatchRecord, SideRecord } from "./match.js";

export interface SideSummary {
  readonly fighter: string;
  readonly wins: number;
  readonly linesPerGame: number;
  readonly attackPerPiece: number;
  readonly tspinsPerGame: number;
  readonly quadsPerGame: number;
  readonly msPerDecision: number;
}

export interface Summary {
  readonly games: number;
  readonly draws: number;
  readonly caps: number;
  /** Win rate of `a` over decided games, with a 95% Wilson interval. */
  readonly winRate: number;
  readonly winRateLow: number;
  readonly winRateHigh: number;
  readonly a: SideSummary;
  readonly b: SideSummary;
}

/** A record seen from one fighter's point of view, whichever side it played on. */
export interface Oriented {
  readonly seed: number;
  readonly aSide: "left" | "right";
  readonly record: MatchRecord;
}

export function wilson(wins: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(centre - margin) / denom, (centre + margin) / denom];
}

function side(records: readonly SideRecord[], wins: number): SideSummary {
  const n = Math.max(1, records.length);
  const sum = (f: (r: SideRecord) => number): number => records.reduce((t, r) => t + f(r), 0);
  const locks = sum((r) => r.locks);
  const decisions = sum((r) => r.decisions);
  return {
    fighter: records[0]?.fighter ?? "",
    wins,
    linesPerGame: sum((r) => r.lines) / n,
    attackPerPiece: locks > 0 ? sum((r) => r.sent) / locks : 0,
    tspinsPerGame: sum((r) => r.tspins) / n,
    quadsPerGame: sum((r) => r.quads) / n,
    msPerDecision: decisions > 0 ? sum((r) => r.thinkMs) / decisions : 0,
  };
}

export function summarize(games: readonly Oriented[]): Summary {
  let aWins = 0;
  let bWins = 0;
  let draws = 0;
  let caps = 0;
  const aRecords: SideRecord[] = [];
  const bRecords: SideRecord[] = [];
  for (const { aSide, record } of games) {
    const bSide = aSide === "left" ? "right" : "left";
    aRecords.push(record[aSide]);
    bRecords.push(record[bSide]);
    if (record.winner === aSide) aWins += 1;
    else if (record.winner === bSide) bWins += 1;
    else if (record.winner === "draw") draws += 1;
    else caps += 1;
  }
  const decided = aWins + bWins;
  const [low, high] = wilson(aWins, decided);
  return {
    games: games.length,
    draws,
    caps,
    winRate: decided > 0 ? aWins / decided : 0,
    winRateLow: low,
    winRateHigh: high,
    a: side(aRecords, aWins),
    b: side(bRecords, bWins),
  };
}
