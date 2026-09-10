/**
 * Hoiko (Puyo Puyo Tetris bot) evaluation weights.
 *
 * The target bot stores its parameters as plaintext CSV-ish files
 * (`we`/`wo`/`wd`/`wr` VS play styles, plus `ultra2`/`sprint`). Each line is
 * either a scalar (`key,value`) or a small vector (`key,v1,v2,...`). The
 * complete reverse-engineered set lives at evidence/hoiko/weights/*.txt; the
 * copies embedded below are byte-for-byte transcriptions of those files so the
 * fighter is self-contained (src must not read outside its own tree).
 *
 * Unknown scalar keys are preserved in `extra` (forward compatible); aliases
 * are normalised (`wellHole` -> `wellHint`, both spellings appear in the game
 * parameter files for the same well-shape weight).
 */

export type HoikoPreset = "we" | "wo" | "wd" | "wr" | "ultra2" | "sprint";

export interface HoikoWeights {
  readonly maxHeight: number;
  readonly over10: number;
  readonly over15: number;
  readonly updown2: number;
  readonly donateCover: number;
  readonly cover: number;
  readonly roof: number;
  readonly badRoof: number;
  readonly pierce: number;
  readonly anabara: number;
  readonly wellHint: number;
  readonly wellDepth: number;
  readonly wellPeak: number;
  readonly pcStack: number;
  readonly pcChance: number;
  readonly resource: number;
  readonly resourceMax: number;
  readonly tsdHole: number;
  readonly tsdSpinable: number;
  readonly tsdClearable: number;
  readonly tsdOffensive: number;
  readonly tstHole: number;
  readonly tstSpinable: number;
  readonly tstClearable: number;
  readonly tstHint: number;
  readonly tstOffensive: number;
  readonly tdHole: number;
  readonly tdHint: number;
  readonly moveDelay: number;
  readonly holdI: number;
  readonly holdT: number;
  readonly wasteI: number;
  readonly wasteT: number;
  readonly single: number;
  readonly double: number;
  readonly triple: number;
  readonly quad: number;
  readonly tss: number;
  readonly tsd: number;
  readonly tst: number;
  readonly btb: number;
  readonly pc: number;
  readonly comboBtb: number;
  readonly comboDebt: number;
  readonly nexus: number;
  /** `column` is per-column (10) occupancy/height weight. */
  readonly column: readonly number[];
  /** `comboAtk` is the attack reward for combo depth 1..5. */
  readonly comboAtk: readonly number[];
  /** Scalar keys that were present in the source but not modelled above. */
  readonly extra: Readonly<Record<string, number>>;
}

const SCALAR_KEYS = [
  "maxHeight",
  "over10",
  "over15",
  "updown2",
  "donateCover",
  "cover",
  "roof",
  "badRoof",
  "pierce",
  "anabara",
  "wellHint",
  "wellDepth",
  "wellPeak",
  "pcStack",
  "pcChance",
  "resource",
  "resourceMax",
  "tsdHole",
  "tsdSpinable",
  "tsdClearable",
  "tsdOffensive",
  "tstHole",
  "tstSpinable",
  "tstClearable",
  "tstHint",
  "tstOffensive",
  "tdHole",
  "tdHint",
  "moveDelay",
  "holdI",
  "holdT",
  "wasteI",
  "wasteT",
  "single",
  "double",
  "triple",
  "quad",
  "tss",
  "tsd",
  "tst",
  "btb",
  "pc",
  "comboBtb",
  "comboDebt",
  "nexus",
] as const;

const SCALAR_SET: ReadonlySet<string> = new Set(SCALAR_KEYS);

function padVector(values: readonly number[] | undefined, length: number): readonly number[] {
  const out: number[] = new Array<number>(length).fill(0);
  if (values === undefined) return out;
  for (let i = 0; i < length && i < values.length; i += 1) out[i] = values[i] ?? 0;
  return out;
}

/**
 * Parse a Hoiko weight file. Lines are `key,value` (scalar) or
 * `key,v1,v2,...` (vector). Blank lines and `#` comments are ignored.
 * `column` is padded/truncated to 10, `comboAtk` to 5.
 */
export function parseHoikoWeights(text: string): HoikoWeights {
  const scalars = new Map<string, number>();
  const vectors = new Map<string, number[]>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const parts = line.split(",");
    const key = (parts[0] ?? "").trim();
    if (key.length === 0) continue;
    const values: number[] = [];
    for (let i = 1; i < parts.length; i += 1) {
      const value = Number((parts[i] ?? "").trim());
      if (Number.isFinite(value)) values.push(value);
    }
    if (values.length === 0) continue;
    if (values.length === 1) scalars.set(key, values[0] ?? 0);
    else vectors.set(key, values);
  }
  // Alias: some parameter files spell the well-shape weight `wellHole`.
  if (!scalars.has("wellHint") && scalars.has("wellHole")) {
    scalars.set("wellHint", scalars.get("wellHole") ?? 0);
  }
  const extra: Record<string, number> = {};
  for (const [key, value] of scalars) {
    if (!SCALAR_SET.has(key) && key !== "wellHole") extra[key] = value;
  }
  const num = (key: string): number => scalars.get(key) ?? 0;
  return {
    maxHeight: num("maxHeight"),
    over10: num("over10"),
    over15: num("over15"),
    updown2: num("updown2"),
    donateCover: num("donateCover"),
    cover: num("cover"),
    roof: num("roof"),
    badRoof: num("badRoof"),
    pierce: num("pierce"),
    anabara: num("anabara"),
    wellHint: num("wellHint"),
    wellDepth: num("wellDepth"),
    wellPeak: num("wellPeak"),
    pcStack: num("pcStack"),
    pcChance: num("pcChance"),
    resource: num("resource"),
    resourceMax: num("resourceMax"),
    tsdHole: num("tsdHole"),
    tsdSpinable: num("tsdSpinable"),
    tsdClearable: num("tsdClearable"),
    tsdOffensive: num("tsdOffensive"),
    tstHole: num("tstHole"),
    tstSpinable: num("tstSpinable"),
    tstClearable: num("tstClearable"),
    tstHint: num("tstHint"),
    tstOffensive: num("tstOffensive"),
    tdHole: num("tdHole"),
    tdHint: num("tdHint"),
    moveDelay: num("moveDelay"),
    holdI: num("holdI"),
    holdT: num("holdT"),
    wasteI: num("wasteI"),
    wasteT: num("wasteT"),
    single: num("single"),
    double: num("double"),
    triple: num("triple"),
    quad: num("quad"),
    tss: num("tss"),
    tsd: num("tsd"),
    tst: num("tst"),
    btb: num("btb"),
    pc: num("pc"),
    comboBtb: num("comboBtb"),
    comboDebt: num("comboDebt"),
    nexus: num("nexus"),
    column: padVector(vectors.get("column"), 10),
    comboAtk: padVector(vectors.get("comboAtk"), 5),
    extra,
  };
}

/**
 * Embedded transcriptions of evidence/hoiko/weights/*.txt. `we` is the
 * default VS preset (config `playStyle=0`); `wo`/`wd`/`wr` are the other VS
 * styles; `ultra2`/`sprint` are the single-player presets used here as
 * additional sparring temperaments.
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
single,-350
double,-300
triple,-250
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

/** Default VS config weights (`playStyle=0`). */
export const HOIKO_DEFAULT_PRESET: HoikoPreset = "we";
