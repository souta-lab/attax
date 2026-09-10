/**
 * Hoiko (Puyo Puyo Tetris bot) evaluation weights.
 *
 * The target bot stores its parameters as plaintext CSV-ish files
 * (`we`/`wo`/`wd`/`wr` VS play styles, plus `ultra2`/`sprint`). The native
 * reader (EvaluateAI::EvalWeight::ReadWeight) parses the file POSITIONALLY:
 * line index i (0-based) fills `weight[i]` with the 2nd CSV token, except
 * line 13 (Column) fills `column[0..9]`, line 44 (ComboAtk) fills
 * `comboTable[0..4]`, and line 46 (Nexus) sets `nexus = clamp(weight[46],0,100)*0.01`.
 * The file must contain exactly 47 lines (0..46) or the whole struct is zeroed.
 *
 * The embedded transcriptions below are byte-for-byte copies of
 * evidence/hoiko/weights/*.txt so the fighter is self-contained (src must not
 * read outside its own tree). The named keys are labels only; the parser
 * ignores them and reads by line index, exactly like the native reader.
 */

export type HoikoPreset = "we" | "wo" | "wd" | "wr" | "ultra2" | "sprint";

/** Positional weight struct mirroring EvaluateAI::EvalWeight. */
export interface HoikoWeights {
  /** weight[50] — one scalar per W enum index (line index). */
  readonly weight: readonly number[];
  /** column[10] — per-column weight (line 13). */
  readonly column: readonly number[];
  /** comboTable[5] — combo attack reward by rank (line 44). */
  readonly comboTable: readonly number[];
  /** nexus — board-score blend factor, 0..1 (line 46). */
  readonly nexus: number;
}

const W_COLUMN = 13;
const W_COMBATK = 44;
const W_NEXUS = 46;

function toInt(token: string | undefined): number {
  const value = Number(token?.trim());
  return Number.isFinite(value) ? value : 0;
}

/**
 * Parse a Hoiko weight file positionally, mirroring the native ReadWeight.
 * Returns a zeroed struct when the file does not have exactly 47 lines.
 */
export function parseHoikoWeights(text: string): HoikoWeights {
  const weight = new Array<number>(50).fill(0);
  const column = new Array<number>(10).fill(0);
  const comboTable = new Array<number>(5).fill(0);
  let nexus = 0;
  const lines = text.split(/\r?\n/);
  let i = 0;
  let correct = -1;
  for (; i < lines.length; i += 1) {
    const tokens = (lines[i] ?? "").split(",");
    if (i === W_COLUMN) {
      for (let c = 1; c <= tokens.length; c += 1) {
        if (c === 1) continue;
        column[c - 2] = toInt(tokens[c - 1]);
        if (c >= 11) {
          correct += 1;
          break;
        }
      }
      continue;
    }
    if (i === W_COMBATK) {
      let correctTable = 0;
      for (let c = 1; c <= tokens.length; c += 1) {
        if (c === 1) continue;
        if ((tokens[c - 1] ?? "") === "") break;
        comboTable[c - 2] = toInt(tokens[c - 1]);
        correctTable += 1;
        if (c >= 6) break;
      }
      if (correctTable > 0) {
        correct += 1;
        if (correctTable < 5) {
          const base = comboTable[0] ?? 0;
          comboTable[1] = base * 2;
          comboTable[2] = base * 3;
          comboTable[3] = base * 4;
          comboTable[4] = base * 5;
        }
      }
      continue;
    }
    for (let c = 1; c <= tokens.length; c += 1) {
      if (c === 1) continue;
      weight[i] = toInt(tokens[c - 1]);
      if (c >= 2) {
        correct += 1;
        break;
      }
    }
    if (i === W_NEXUS) {
      nexus = Math.min(100, Math.max(0, weight[W_NEXUS] ?? 0));
      nexus *= 0.01;
      break;
    }
  }
  if (i !== correct) {
    return {
      weight: new Array<number>(50).fill(0),
      column: new Array<number>(10).fill(0),
      comboTable: new Array<number>(5).fill(0),
      nexus: 0,
    };
  }
  return { weight, column, comboTable, nexus };
}

/**
 * Embedded transcriptions of evidence/hoiko/weights/*.txt. `we` is the
 * default VS preset (config `playStyle=0`); `wo`/`wd`/`wr` are the other VS
 * styles; `ultra2`/`sprint` are the single-player presets.
 */
const PRESET_TEXT: Readonly<Record<HoikoPreset, string>> = {
  we: `maxHeight,-15
over10,-30
over15,-100
updown2,-4
donateCover,-25
cover,-10
roof,-15
badRoof,-50
pierce,-120
anabara,-70
wellHint,10
wellDepth,10
wellPeak,5
column,-50,-70,-10,0,0,0,0,-10,-70,-50
pcStack,30
pcChance,1000
resource,2
resourceMax,30
tsdHole,5
tsdSpinable,5
tsdClearable,35
tsdOffensive,-30
tstHole,15
tstSpinable,15
tstClearable,35
tstHint,10
tstOffensive,-100
tdHole,60
tdHint,20
moveDelay,-3
holdI,10
holdT,10
wasteI,-100
wasteT,-100
single,200
double,100
triple,150
quad,200
tss,50
tsd,300
tst,500
btb,50
pc,1500
comboBtb,50
comboAtk,180,360,540,900,1080
comboDebt,250
nexus,50
`,
  wo: `maxHeight,-15
over10,-30
over15,-100
updown2,-4
donateCover,-25
cover,-10
roof,-15
badRoof,-50
pierce,-120
anabara,-70
wellHint,10
wellDepth,10
wellPeak,5
column,-50,-70,-10,0,0,0,0,-10,-70,-50
pcStack,30
pcChance,300
resource,2
resourceMax,50
tsdHole,5
tsdSpinable,5
tsdClearable,35
tsdOffensive,-30
tstHole,15
tstSpinable,15
tstClearable,35
tstHint,10
tstOffensive,-100
tdHole,60
tdHint,20
moveDelay,-3
holdI,10
holdT,10
wasteI,-50
wasteT,-150
single,-350
double,-300
triple,-250
quad,100
tss,50
tsd,300
tst,500
btb,50
pc,1000
comboBtb,50
comboAtk,180,360,540,900,1080
comboDebt,250
nexus,50
`,
  wd: `maxHeight,-15
over10,-30
over15,-100
updown2,-4
donateCover,-25
cover,-10
roof,-15
badRoof,-50
pierce,-120
anabara,-70
wellHint,10
wellDepth,10
wellPeak,7
column,0,-15,0,0,0,0,0,0,-15,0
pcStack,30
pcChance,1000
resource,2
resourceMax,30
tsdHole,5
tsdSpinable,0
tsdClearable,15
tsdOffensive,-30
tstHole,10
tstSpinable,10
tstClearable,15
tstHint,0
tstOffensive,-100
tdHole,35
tdHint,10
moveDelay,-3
holdI,10
holdT,10
wasteI,-150
wasteT,-100
single,-350
double,-250
triple,-200
quad,200
tss,50
tsd,300
tst,400
btb,50
pc,1500
comboBtb,50
comboAtk,180,360,540,900,1080
comboDebt,250
nexus,50
`,
  wr: `maxHeight,-50
over10,-100
over15,-0
updown2,-4
donateCover,-25
cover,-10
roof,-15
badRoof,-50
pierce,-120
anabara,-70
wellHint,10
wellDepth,10
wellPeak,7
column,0,-15,0,0,0,0,0,0,-15,0
pcStack,30
pcChance,1000
resource,2
resourceMax,30
tsdHole,5
tsdSpinable,0
tsdClearable,15
tsdOffensive,-30
tstHole,10
tstSpinable,10
tstClearable,15
tstHint,0
tstOffensive,-100
tdHole,35
tdHint,10
moveDelay,-3
holdI,10
holdT,10
wasteI,-150
wasteT,-100
single,-350
double,-250
triple,-200
quad,200
tss,50
tsd,300
tst,400
btb,50
pc,1500
comboBtb,50
comboAtk,180,360,540,900,1080
comboDebt,250
nexus,50
`,
  ultra2: `maxHeight,1
over10,0
over15,-2
updown2,-5
donateCover,-5
cover,-0
roof,-10
badRoof,-30
pierce,-100
anabara,-50
wellHole,0
wellDepth,5
wellPeak,5
column,-100,-100,-10,0,0,0,0,-10,-100,-100
pcStack,0
pcChance,0
resource,0
resourceMax,0
tsdHole,15
tsdSpinable,15
tsdClearable,45
tsdOffensive,-30
tstHole,30
tstSpinable,15
tstClearable,30
tstHint,100
tstOffensive,-100
tdHole,100
tdHint,50
moveDelay,-5
holdI,0
holdT,10
wasteI,0
wasteT,-5000
single,-50000
double,-45000
triple,-35000
quad,-30
tss,-100
tsd,300
tst,700
btb,0
pc,9999
comboBtb,0
comboAtk,0
comboDebt,0
nexus,50
`,
  sprint: `maxHeight,-15
over10,-30
over15,-40
updown2,-4
donateCover,-15
cover,-10
roof,-15
badRoof,-50
pierce,-120
anabara,-70
wellHole,5
wellDepth,5
wellPeak,4
column,-50,-65,-10,0,0,0,0,-10,-65,-50
pcStack,30
pcChance,100
resource,0
resourceMax,0
tsdHole,0
tsdSpinable,0
tsdClearable,0
tsdOffensive,0
tstHole,0
tstSpinable,0
tstClearable,0
tstHint,0
tstOffensive,0
tdHole,0
tdHint,0
moveDelay,-10
holdI,0
holdT,0
wasteI,-100
wasteT,0
single,-200
double,-200
triple,-200
quad,10000
tss,-100
tsd,-100
tst,-100
btb,0
pc,10000
comboBtb,0
comboAtk,0
comboDebt,0
nexus,50
`,
};

const PRESET_CACHE = new Map<HoikoPreset, HoikoWeights>();

/** Parse the embedded preset (cached; weights are immutable). */
export function hoikoPresetWeights(preset: HoikoPreset): HoikoWeights {
  const cached = PRESET_CACHE.get(preset);
  if (cached !== undefined) return cached;
  const parsed = parseHoikoWeights(PRESET_TEXT[preset]);
  PRESET_CACHE.set(preset, parsed);
  return parsed;
}

/**
 * Build the native `weightList[4]` for a preset's play style.
 *
 * VS presets (we/wo/wd/wr) load all four VS weight files into weightList[0..3]
 * and switch between them via TransitionWeight. Solo presets (ultra2/sprint)
 * load a single file into weightList[0] and copy it to weightList[1]
 * (transitSolo switches between two identical entries).
 */
export function hoikoWeightList(preset: HoikoPreset): readonly HoikoWeights[] {
  switch (preset) {
    case "we":
    case "wo":
    case "wd":
    case "wr":
      return [
        hoikoPresetWeights("we"),
        hoikoPresetWeights("wo"),
        hoikoPresetWeights("wd"),
        hoikoPresetWeights("wr"),
      ];
    case "ultra2":
    case "sprint": {
      const solo = hoikoPresetWeights(preset);
      return [solo, solo];
    }
  }
}

/** Default VS config weights (`playStyle=0`). */
export const HOIKO_DEFAULT_PRESET: HoikoPreset = "we";
