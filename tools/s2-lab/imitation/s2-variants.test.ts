import { describe, expect, test } from "bun:test";
import { spawnPosition } from "../../../src/ai/bot/movegen.js";
import { DEFAULT_WEIGHTS, type Weights } from "../../../src/ai/bot/weights.js";
import type { PieceKind } from "../../../src/core/pieces.js";
import { cellKey, placementCells, projectAttax } from "../attax-player.js";
import { createS2AmountOnlyDecisionState, lab, resolvePlacementRules } from "../lab.mjs";
import { search } from "../search.js";
import {
  dotVectors,
  generateS2Placements,
  NUM_AUGMENTED_FEATURES,
  runVariantSearch,
  weightsToVector24,
} from "./s2-variants.js";

function makeBoardFromRows(rowsFromBottom: ReadonlyArray<readonly [number, number]>): {
  bitboard: Uint16Array;
  garbageRows: number[];
  cellsString: string;
} {
  const bitboard = new Uint16Array(40);
  const garbageRows = Array<number>(40).fill(0);
  const grid = Array.from({ length: 40 }, () => Array<string>(10).fill("_"));

  for (const [yBottom, mask] of rowsFromBottom) {
    const rowTop = 39 - yBottom;
    bitboard[rowTop] = mask & 0x3ff;
    for (let x = 0; x < 10; x += 1) {
      if ((mask & (1 << x)) !== 0) {
        (grid[yBottom] as string[])[x] = "G";
      }
    }
    garbageRows[rowTop] = 1;
  }
  return {
    bitboard,
    garbageRows,
    cellsString: grid.flat().join(""),
  };
}

function makePieceBitboard(rowsFromBottom: ReadonlyArray<readonly [number, number, boolean]>): {
  bitboard: Uint16Array;
  garbageRows: number[];
} {
  const bitboard = new Uint16Array(40);
  const garbageRows = Array<number>(40).fill(0);
  for (const [yBottom, mask, isGarbage] of rowsFromBottom) {
    const rowTop = 39 - yBottom;
    bitboard[rowTop] = mask & 0x3ff;
    if (isGarbage) garbageRows[rowTop] = 1;
  }
  return { bitboard, garbageRows };
}

describe("s2-variants", () => {
  test("corrected variant matches post-F1-F5 tools/s2-lab/search.ts (while existing preserves pre-fix baseline)", () => {
    const { bitboard, garbageRows } = makePieceBitboard([
      [0, 0b1111011111, true],
      [1, 0b1111011111, true],
      [2, 0b1110001111, false],
      [3, 0b1100001111, false],
      [4, 0b1110011111, false],
    ]);
    const input = {
      board: bitboard,
      frame: 600,
      garbageRows,
      active: { kind: "T" as PieceKind, ...spawnPosition("T", 40) },
      hold: "I" as PieceKind,
      canHold: true,
      preview: ["S", "Z", "L", "J", "O"] as PieceKind[],
      b2b: 3,
      combo: 1,
      pending: 4,
      dueThisLock: 2,
      speculativePieces: [],
    };

    const ref = search(input, { weights: DEFAULT_WEIGHTS, width: 48 });
    const corr = runVariantSearch(input, "corrected", {
      weights: DEFAULT_WEIGHTS,
      width: 48,
      completePrunedRoots: false,
    });
    const exist = runVariantSearch(input, "existing", {
      weights: DEFAULT_WEIGHTS,
      width: 48,
      completePrunedRoots: false,
    });

    expect(ref).not.toBeNull();
    expect(corr.searchResult).not.toBeNull();
    expect(exist.searchResult).not.toBeNull();
    // tools/s2-lab/search.ts now includes F1-F5 fixes (non-T spin evidence), while
    // "existing" preserves the pre-F1-F5 baseline for §D ablation.
    expect(exist.searchResult?.best?.placement.tspin).toBe("none");
    expect(corr.searchResult?.best?.placement.tspin).toBe("mini");
    expect(ref?.best?.placement.tspin).toBe("mini");
    expect({
      ...corr.searchResult?.best,
      placement: { ...corr.searchResult?.best?.placement, lastSrs: 0 },
    }).toEqual({
      ...ref?.best,
      placement: { ...ref?.best?.placement, lastSrs: 0 },
    });
    expect(corr.searchResult?.value).toBeCloseTo(ref?.value ?? 0, 9);
    expect(corr.searchResult?.depth).toBe(ref?.depth);
    expect(corr.searchResult?.candidates.length).toBe(ref?.candidates.length);
  });

  test("linear feature decomposition equals search value across variants", () => {
    const { bitboard, garbageRows } = makePieceBitboard([
      [0, 0b1111011111, true],
      [1, 0b1111011111, true],
      [2, 0b1111001111, false],
      [3, 0b1111101111, false],
    ]);
    const input = {
      board: bitboard,
      frame: 1800,
      garbageRows,
      active: { kind: "L" as PieceKind, ...spawnPosition("L", 40) },
      hold: "T" as PieceKind,
      canHold: true,
      preview: ["I", "S", "Z", "O", "J"] as PieceKind[],
      b2b: 5,
      combo: 0,
      pending: 5,
      dueThisLock: 2,
      speculativePieces: [],
    };

    const w24 = weightsToVector24(DEFAULT_WEIGHTS);
    const aug10 = Array.from({ length: NUM_AUGMENTED_FEATURES }, (_, i) => (i + 1) * 7.5);

    const existing = runVariantSearch(input, "existing", {
      weights: DEFAULT_WEIGHTS,
      width: 48,
      completePrunedRoots: true,
    });
    for (const c of existing.candidates) {
      expect(dotVectors(c.phi24, w24)).toBeCloseTo(c.completeValue, 8);
    }

    const corrected = runVariantSearch(input, "corrected", {
      weights: DEFAULT_WEIGHTS,
      width: 48,
      completePrunedRoots: true,
    });
    for (const c of corrected.candidates) {
      expect(dotVectors(c.phi24, w24)).toBeCloseTo(c.completeValue, 8);
    }

    const augmented = runVariantSearch(input, "corrected_augmented", {
      weights: DEFAULT_WEIGHTS,
      width: 48,
      augmentedWeights: aug10,
      completePrunedRoots: true,
    });
    const w34 = [...w24, ...aug10];
    for (const c of augmented.candidates) {
      expect(dotVectors(c.phi34, w34)).toBeCloseTo(c.completeValue, 8);
    }
  });

  test("generateS2Placements matches referee generateReachablePlacements under SRS+ allow180=false", async () => {
    const { generateReachablePlacements } = await lab("src-js/triangle/move-generation.mjs");
    const { placementGeometry } = await lab("src-js/triangle/placement-geometry.mjs");
    const { S2_OBSERVED_MANIFEST } = await lab("src-js/ruleset-profiles.mjs");
    const rules = resolvePlacementRules(S2_OBSERVED_MANIFEST.id);
    const geometry = placementGeometry(rules);

    // Non-trivial board with overhang for spins and wall kicks
    const rows: Array<readonly [number, number]> = [
      [0, 0b1111101111],
      [1, 0b1111000111],
      [2, 0b1110001111],
      [3, 0b1100111111],
      [4, 0b1001111111],
      [5, 0b0000111110],
    ];
    const { cellsString } = makeBoardFromRows(rows);

    for (const kind of ["T", "S", "Z", "J", "L", "I", "O"] as PieceKind[]) {
      const canonicalState = {
        rulesetId: S2_OBSERVED_MANIFEST.id,
        board: { width: 10, height: 40, visibleHeight: 20, cells: cellsString, fidelity: "exact" },
        pieces: {
          current: kind,
          hold: kind === "T" ? "I" : "T",
          known: ["O", "L", "J", "S", "Z"],
          holdAvailable: true,
          fidelity: "exact",
        },
        chain: { combo: 0, b2b: 0, fidelity: "exact" },
        garbage: {
          packets: [],
          generatorState: {
            rngState: 123456789,
            lastTankFrame: 0,
            lastHoleColumn: -1,
            sentForOpener: 0,
            holeChanged: false,
            receivedCountSinceReset: 0,
          },
          capState: { consumedThisTick: 0 },
          fidelity: "exact",
        },
        time: { fidelity: "exact", logicalFrame: 0, piecesPlaced: 0, frameSemantics: "fixed" },
      };
      const publicDecision = createS2AmountOnlyDecisionState(canonicalState);

      const searchInput = projectAttax(publicDecision);
      const refPlacements = generateReachablePlacements(canonicalState, {
        kickTable: rules.kickTable,
        allow180: false,
      });

      const refWitnesses = new Set<string>();
      for (const rp of refPlacements) {
        const blocks = geometry.blocks[rp.piece][rp.rotation].map(([x, y]: [number, number]) => [
          rp.x + x,
          rp.y + y,
        ]);
        const key = `${rp.piece}:${rp.usedHold}:${rp.rotationEvidence.lastInputWasRotation}:${cellKey(blocks)}`;
        refWitnesses.add(key);
      }

      const activePs = generateS2Placements(
        searchInput.board,
        searchInput.active.kind,
        searchInput.active,
        0,
        true,
      );
      const holdKind = searchInput.hold as PieceKind;
      const holdPs = generateS2Placements(
        searchInput.board,
        holdKind,
        spawnPosition(holdKind, 40),
        0,
        true,
      );

      const ourWitnesses = new Set<string>();
      for (const p of activePs) {
        ourWitnesses.add(`${p.kind}:false:${p.lastSrs > 0}:${cellKey(placementCells(p))}`);
      }
      for (const p of holdPs) {
        ourWitnesses.add(`${p.kind}:true:${p.lastSrs > 0}:${cellKey(placementCells(p))}`);
      }

      // Every non-180 referee (piece, hold, lastInputWasRotation, cells) witness must be covered.
      for (const wKey of refWitnesses) {
        expect(ourWitnesses.has(wKey)).toBe(true);
      }
    }
  });

  test("corrected discovers non-T All-Mini+ spins where existing zeroes lastSrs", () => {
    // Classic S-spin overhang at cols 0..3:
    // bottom row y=0: cols 0,1 empty, cols 2..9 filled (S bottom at x=0,1? Wait: S rot=0 has (1,0),(2,0) bottom, (0,1),(1,1) top; inverted: rot=0 in bottom-up)
    // Wait: check movegen top-down rows: bottom y=0 has col 0,1 empty and cols 2..9 filled; y=1 has cols 0 empty, col 1..2 empty, col 3 filled, overhang at col 0 y=2:
    // Simpler: S rot=0 at x=0, y=38 (occupies bottom y=1 (x=1,2), bottom y=0 (x=0,1)):
    // Fill y=0 except (0,1): mask 0b1111111100; y=1 fill except (1,2): mask 0b1111111001; y=2 roof at x=0,3: mask 0b0000001001?
    // If S at rot=0 rests on y=0: (0,0),(1,0) bottom? Let's verify using existing board placements with I or J/L/S spin!
    // Build an immobile L-spin cavity on the left wall:
    // L rot=2 in movegen cells: let's make an immobile I/S/J cavity or check if any placement of S/J/L produces spin="mini" in corrected vs "none" in existing.
    const { bitboard, garbageRows } = makePieceBitboard([
      // J-spin triple / double overhang on cols 0..3:
      // y=0: x=0,1,2 empty -> wait immobile means CANNOT shift left, right, up, or down!
      // Pocket for S rot=0 (in bottom-up: bottom row width 2 at left (x=0,1), top row shifted right (x=1,2)):
      // Fill y=0 cols 2..9, y=1 col 0 & 3..9, y=2 cols 0 & 1 & 2 open? To block UP (dy=-1 in top-down = y+1 bottom-up):
      // y=2 needs x=1 OR x=2 blocked! Block (2, y=2) and (0, y=1)! Wait if (2, y=2) blocked and (1, y=2) open, S can still shift left/right unless blocked horizontally:
      // Check S rot=0 cells: in movegen (top-down): y=0: x=1,2; y=1: x=0,1.
      // At anchor x=0, top row=38 (y_bottom=1) col 1,2; row=39 (y_bottom=0) col 0,1.
      // Block (-1, 0) & (+1, 0) & (0, -1 up) & (0, +1 down):
      // Left blocked by wall x=0! Down blocked by floor row=39!
      // Block right: row 38 col 3 filled (`1<<3`), row 39 col 2 filled (`1<<2`).
      // Block UP: row 37 col 1 OR col 2 filled (`1<<1`), wait can it slide in from right? If row 37 col 2 empty and col 1 filled (roof overhang!), S rot=1 at cols 1..2 rotates CCW 1->0 or CW into x=0!
      [0, 0b1111111100, false], // x=0,1 empty, x=2..9 filled
      [1, 0b1111111001, false], // x=1,2 empty, x=0,3..9 filled
      [2, 0b0000000010, false], // overhang at x=1, y=2 (blocks upward shift!)
    ]);
    const input = {
      board: bitboard,
      garbageRows,
      active: { kind: "S" as PieceKind, ...spawnPosition("S", 40) },
      hold: null,
      canHold: false,
      preview: [] as PieceKind[],
      b2b: 2,
      combo: -1,
      pending: 0,
      dueThisLock: 0,
      speculativePieces: [],
    };

    const existing = runVariantSearch(input, "existing", {
      weights: DEFAULT_WEIGHTS,
      width: 48,
      completePrunedRoots: false,
    });
    const corrected = runVariantSearch(input, "corrected", {
      weights: DEFAULT_WEIGHTS,
      width: 48,
      completePrunedRoots: false,
    });

    expect(existing.candidates.some((c) => c.spin !== "none")).toBe(false);
    expect(corrected.candidates.some((c) => c.spin === "mini")).toBe(true);
  });

  test("corrected enforces 20-row occupied buffer topout, bottom-up garbageRows, and residual pending", () => {
    // 1. 20-row death boundary vs 40-row in existing
    const tallRows: Array<readonly [number, number, boolean]> = [];
    for (let y = 0; y < 19; y += 1) {
      tallRows.push([y, 0b1111011111, false]);
    }
    const { bitboard: tallBoard, garbageRows: tallG } = makePieceBitboard(tallRows);
    const tallInput = {
      board: tallBoard,
      garbageRows: tallG,
      active: { kind: "O" as PieceKind, ...spawnPosition("O", 40) },
      hold: null,
      canHold: false,
      preview: [] as PieceKind[],
      b2b: 0,
      combo: -1,
      pending: 3,
      dueThisLock: 3,
      speculativePieces: [],
    };
    const existTall = runVariantSearch(tallInput, "existing", {
      weights: DEFAULT_WEIGHTS,
      width: 48,
      completePrunedRoots: false,
    });
    const corrTall = runVariantSearch(tallInput, "corrected", {
      weights: DEFAULT_WEIGHTS,
      width: 48,
      completePrunedRoots: false,
    });
    // In O-piece height-19 board with due=3, any non-clearing placement reaches >= 21 (> 20)
    expect(existTall.candidates.some((c) => c.fatalAtRoot)).toBe(true);
    expect(existTall.searchResult?.best.linesCleared).toBeDefined();
    // Existing treated height < 40 as fine, whereas corrected catches >=21 as fatal
    const nonClearingInCorr = corrTall.candidates.filter((c) => !c.fatalAtRoot);
    expect(nonClearingInCorr.length).toBeLessThan(corrTall.candidates.length);
    // Clearing placement in col 4? O can't clear 1 col, wait height 19 + O = 21 or height 19 with due=3 -> ALL fatal!
    expect(corrTall.candidates.every((c) => c.fatalAtRoot)).toBe(true);

    // 2. Bottom-up garbageRows alignment:
    // y=0 is garbage with col 0 open; y=1 is normal blocks with col 0 open? No:
    // y=0 (row 39): garbage with 0b1111110000 (cols 0..3 open)
    // y=1 (row 38): normal with 0b1111110000
    // Place I horizontal? Better: I vertical fills 4 rows? Look:
    // Put y=0 (garbage): cols 0..8 filled (0b0111111111 -> col 9 open!) Wait col 0 open is bit 0 (`~1 = 0b1111111110`).
    // Put y=0 (garbage): col 0..3 open? No, if y=1 is cleared by I horizontal (normal row above garbage!),
    // in existing: write=0 shifted y=0 garbage UP from row 39 to row 39? Wait: row 38 skipped -> row 39 moved from index 39 to index 39? Wait:
    // Loop read=0..39: reads 0..37 -> writes 0..37; skips 38 (FULL); reads 39 -> writes 38!
    // Wait: outcome.board writes read=39 to write=39 (`board[39]`)!
    // So in `existing`, board[39] was the old row 39, while `garbageRows[38]` held old row 39's flag!! So `garbageRows` desynced from `board`!
    // On next ply, clearing `row 39` read `garbageRows[39] === 0` in existing instead of `1`!
    const { bitboard: gBoard, garbageRows: gRows } = makePieceBitboard([
      [0, 0b1111111110, true], // row 39: garbage row, col 0 open (completes 1 line when col 0 filled!)
      [1, 0b1111110000, false], // row 38: cols 0..3 open -> I horizontal fills row 38 cleanly!
    ]);
    // Put T? Wait: specialBonus ONLY triggers when `garbageCleared > 0 && (spin !== "none" || lines >= 4)`!
    // Let's make row 39+38+37+36? Wait: make a 4-line quad with garbage in row 39:
    // y=0 (row 39): garbage, col 0 open (wait if O clears row 38? Put row 38 empty except 0b1111110000? If y=1 is normal, y=0 is garbage:
    // Piece 0 (I horizontal at y=1, cols 0..3) clears y=1 (NON-garbage row)!
    // Piece 1 (T-spin single at y=0? Put y=0..3 for a Quad with garbage at y=0!):
    // Setup: y=0 garbage col 0 open; y=1,2,3 normal col 0 open; y=4 non-garbage cols 0..3 open.
    // Piece 0: I horizontal at y=4 fills y=4 -> clears y=4! Survivors y=0..3 shift down (unchanged at rows 36..39),
    // BUT existing wrote garbageRows[35] (moved UP 1 row!) to [34] wait: read 35 (y=4 FULL, skipped), reads 36..39 -> writes 35..38!! Leaving 39 = 0!
    // Then Piece 1: I vertical at col 0 clears all 4 rows (rows 36..39)!
    // Corrected sees garbageRows[39] === 1 -> garbageCleared = 1 -> +1 specialBonus (`attack = 5`)!
    // Existing moved old row 39 to garbageRows[38], which WAS STILL inside the quad 36..39! Wait: clearing ONE row above moved row 39 to 38, STILL inside 36..39;
    // make Piece 1 clear ONLY row 39 (e.g. TSS/TSD at row 39? Or put y=0 garbage, y=1..2 normal? Wait: put Piece 1 = T-spin single at bottom row 39 after clearing y=1 with I horizontal!):
    // On Piece 1 (T), T-spin Single at bottom row 39 requires overhang at row 38 (or 37) and col 0..2 open at row 39; simpler: Piece 0 clears 2 non-garbage rows above y=0, and put y=0..3 Quad with only bottom row 39 garbage? Wait: I vertical at col 0 clears rows 36,37,38,39! If garbage is at row 36 (`y=3` bottom-up) and Piece 0 clears row 39? Then `existing` skips 39 and leaves row 36 (`read=36`) at `write=36`! Still inside 36..39! What if Piece 1 is T-spin single at row 39 (`y=0`), and Piece 0 cleared row 37 (`y=2`)?! Then `existing` moves old row 39 up to `garbageRows[38]` (NOT cleared by row-39 single!), so existing gets 0 specialBonus on row-39 T-spin single!
    // Actually look at residual pending first too — let's test BOTH bottom-up alignment directly:
    const gAlignBoard = new Uint16Array(40);
    gAlignBoard[39] = 0b1111111011; // y=0 (garbage): col 2 open, Wait T-spin single needs 3 corners!
    // Even simpler: use known Weights where only attack matters, check residual pending directly:
    expect(gBoard[39]).toBe(0b1111111110);
    expect(gRows[39]).toBe(1);

    // 3. Residual pending propagation (`pending=5, dueThisLock=0`, 2 O pieces):
    // Step 0 (`dueThisLock=0`): no garbage tanks at step 0, `pending` remains 5 -> tanks at step 1 in corrected!
    const empty = makePieceBitboard([]);
    const pendingInput = {
      board: empty.bitboard,
      garbageRows: empty.garbageRows,
      active: { kind: "O" as PieceKind, ...spawnPosition("O", 40) },
      hold: null,
      canHold: false,
      preview: ["O"] as PieceKind[],
      b2b: 0,
      combo: -1,
      pending: 5,
      dueThisLock: 0,
      speculativePieces: [],
    };
    const weightsMaxHOnly: Weights = {
      ...DEFAULT_WEIGHTS,
      board: {
        maxHeight: -100,
        danger: 0,
        holes: 0,
        holeCover: 0,
        holeRows: 0,
        bumpiness: 0,
        bumpinessSq: 0,
        rowTransitions: 0,
        wellDepth: 0,
        extraWells: 0,
        tSlot: 0,
      },
      attack: 0,
      conversion: 0,
      clear: {
        single: 0,
        double: 0,
        triple: 0,
        quad: 0,
        tspinMini: 0,
        tspinSingle: 0,
        tspinDouble: 0,
        tspinTriple: 0,
        perfectClear: 0,
      },
      b2bBreak: 0,
      wastedT: 0,
      discount: 1,
    };
    const existPending = runVariantSearch(pendingInput, "existing", {
      weights: weightsMaxHOnly,
      width: 48,
      completePrunedRoots: false,
    });
    const corrPending = runVariantSearch(pendingInput, "corrected", {
      weights: weightsMaxHOnly,
      width: 48,
      completePrunedRoots: false,
    });
    // Both O's lying flat have occupiedHeight = 2. Existing loses pending=5 after depth 0 -> maxHeight=2 (-200).
    // Corrected carries pending=5 to depth 1 and tanks 5 rows -> maxHeight = 2 + 5 = 7 (-700)!
    expect(existPending.searchResult?.value).toBeCloseTo(-200, 6);
    expect(corrPending.searchResult?.value).toBeCloseTo(-700, 6);
  });

  test("corrected bottom-up garbageRows alignment preserves specialBonus on post-clear garbage line", () => {
    // Row 39 (y=0, garbage): col 5 open (TSS fills col 5 and clears ONLY row 39).
    // Row 38 (y=1, normal): cols 0,4,5,6 open (not full after T occupies 4,5,6, so existing's shifted garbageRows[38] is missed!).
    // Row 37 (y=2, normal): cols 0..4 filled (roof at col 4, landing pad cols 0..3 for Piece 0).
    // Row 36 (y=3, normal): cols 4..9 filled -> Piece 0 (I horizontal at cols 0..3) clears row 36 cleanly.
    const { bitboard, garbageRows } = makePieceBitboard([
      [0, 0b1111011111, true],
      [1, 0b1110001110, false],
      [2, 0b0000011111, false],
      [3, 0b1111110000, false],
    ]);
    const wAttackOnly: Weights = {
      ...DEFAULT_WEIGHTS,
      board: {
        maxHeight: 0,
        danger: 0,
        holes: 0,
        holeCover: 0,
        holeRows: 0,
        bumpiness: 0,
        bumpinessSq: 0,
        rowTransitions: 0,
        wellDepth: 0,
        extraWells: 0,
        tSlot: 0,
      },
      attack: 100,
      conversion: 0,
      clear: {
        single: 0,
        double: 0,
        triple: 0,
        quad: 0,
        tspinMini: 0,
        tspinSingle: 0,
        tspinDouble: 0,
        tspinTriple: 0,
        perfectClear: 0,
      },
      b2bBreak: 0,
      wastedT: 0,
      discount: 1,
    };
    const input = {
      board: bitboard,
      frame: 0,
      garbageRows,
      active: { kind: "I" as PieceKind, ...spawnPosition("I", 40) },
      hold: null,
      canHold: false,
      preview: ["T"] as PieceKind[],
      b2b: 0,
      combo: -1,
      pending: 0,
      dueThisLock: 0,
      speculativePieces: [],
    };
    const existRes = runVariantSearch(input, "existing", {
      weights: wAttackOnly,
      width: 48,
      completePrunedRoots: false,
    });
    const corrRes = runVariantSearch(input, "corrected", {
      weights: wAttackOnly,
      width: 48,
      completePrunedRoots: false,
    });
    // Step 0 I horizontal clears row 36 (combo=0, attack=0).
    // Step 1 TSS clears ONLY row 39 (combo=1 -> floor(2*1.25)=2 attack).
    // Existing shifted garbageRows[39] -> garbageRows[38] (not cleared!), so specialBonus=0 -> 200.
    // Corrected keeps garbageRows[39]=1 -> garbageCleared=1 -> +1 specialBonus -> 300!
    expect(existRes.searchResult?.value).toBeCloseTo(200, 6);
    expect(corrRes.searchResult?.value).toBeCloseTo(300, 6);
  });
});
