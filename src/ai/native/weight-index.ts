/** EvaluateAI `W` enum indices (EvalWeight layout, byte = index*4). */
export const WI = {
  MaxHeight: 0,
  Over10: 1,
  Over15: 2,
  UpDown2: 3,
  DonateCover: 4,
  Cover: 5,
  Roof: 6,
  BadRoof: 7,
  Pierce: 8,
  Anabara: 9,
  WellHint: 10,
  WellDepth: 11,
  WellPeak: 12,
  Column: 13,
  PcStack: 14,
  PcChance: 15,
  Resource: 16,
  ResourceMax: 17,
  TsdHole: 18,
  TsdSpinable: 19,
  TsdClearable: 20,
  TsdOffensive: 21,
  TstHole: 22,
  TstSpinable: 23,
  TstClearable: 24,
  TstHint: 25,
  TstOffensive: 26,
  TDHole: 27,
  TDHint: 28,
  MoveDelay: 29,
  HoldI: 30,
  HoldT: 31,
  WasteI: 32,
  WasteT: 33,
  Single: 34,
  Double: 35,
  Triple: 36,
  Quad: 37,
  Tss: 38,
  Tsd: 39,
  Tst: 40,
  Btb: 41,
  Pc: 42,
  ComboBtb: 43,
  ComboAtk: 44,
  ComboDebt: 45,
  Nexus: 46,
} as const;

export function weightAt(ew: { readonly weight: readonly number[] }, i: number): number {
  return ew.weight[i] ?? 0;
}

export function columnAt(ew: { readonly column: readonly number[] }, x: number): number {
  return ew.column[x] ?? 0;
}

export function comboAt(ew: { readonly comboTable: readonly number[] }, r: number): number {
  return ew.comboTable[r] ?? 0;
}
