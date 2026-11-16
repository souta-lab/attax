import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WEIGHTS } from "../../../src/ai/bot/weights.js";
import { annotateDecisionRecord, loadWeightSpec } from "./annotate-dataset.js";
import { generateImitationDataset } from "./generate-dataset.js";
import { NUM_TOTAL_FEATURES } from "./s2-variants.js";
import { type DecisionRecord, splitForSeed } from "./schema.js";
import { TACTICAL_ARCHETYPES } from "./tactical-scenarios.js";

describe("imitation data generator & schema pipeline", () => {
  test("generates multi-source DatasetRecords, runs diagnostics & annotations cleanly", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "attax-s2-im-test-"));
    const rawPath = join(workDir, "pilot.jsonl");

    try {
      const summary = await generateImitationDataset({
        outputPath: rawPath,
        targetPositions: 17,
        maxTurnsPerMatch: 2,
        pps: 2.5,
        freshEveryPlies: 2,
        quotas: {
          attax_vs_champion: 0.2,
          champion_selfplay: 0.2,
          champion_vs_historical: 0.2,
          corrected_attax_vs_champion: 0.2,
          targeted_tactical: 0.2,
        },
        annotateVariants: [],
        width: 24,
      });

      expect(summary.totalPositions).toBeGreaterThanOrEqual(16);
      expect(existsSync(summary.metadataPath)).toBe(true);

      const lines = readFileSync(rawPath, "utf8")
        .trim()
        .split("\n")
        .filter((l) => l.length > 0);
      const records = lines.map((l) => JSON.parse(l) as DecisionRecord);

      expect(records.length).toBe(summary.totalPositions);
      const sourcesSeen = new Set(records.map((r) => r.source));
      expect(sourcesSeen.has("attax_vs_champion")).toBe(true);
      expect(sourcesSeen.has("champion_selfplay")).toBe(true);
      expect(sourcesSeen.has("champion_vs_historical")).toBe(true);
      expect(sourcesSeen.has("corrected_attax_vs_champion")).toBe(true);
      expect(sourcesSeen.has("targeted_tactical")).toBe(true);

      // Whole-seed split integrity: each seed belongs strictly to one split.
      const splitBySeed = new Map<number, string>();
      let freshProbeCount = 0;
      let rootChildCount = 0;
      let rootValueCount = 0;

      for (const rec of records) {
        expect(rec.schema).toBe("attax-s2-imitation/1");
        expect(rec.split).toBe(splitForSeed(rec.seed));
        const prevSplit = splitBySeed.get(rec.seed);
        if (prevSplit !== undefined) expect(rec.split).toBe(prevSplit);
        splitBySeed.set(rec.seed, rec.split);

        expect(rec.observation.pieces.known.length).toBeLessThanOrEqual(13);
        expect(rec.legalActions.length).toBeGreaterThan(0);

        const semKeys = new Set(rec.legalActions.map((a) => a.semanticKey));
        expect(semKeys.size).toBe(rec.legalActions.length);

        expect(rec.teacher.selectedActionIndex).toBeGreaterThanOrEqual(0);
        expect(rec.teacher.selectedActionIndex).toBeLessThan(rec.legalActions.length);
        expect(rec.teacher.rankZeroActionIndex).toBeGreaterThanOrEqual(0);
        expect(rec.teacher.ranked.length).toBeGreaterThan(0);

        if (rec.teacher.rootChildren.length > 0) rootChildCount += 1;
        if (rec.teacher.rootValueTop1 !== null) rootValueCount += 1;
        if (rec.freshTeacher !== null) {
          freshProbeCount += 1;
          expect(rec.freshTeacher.sessionMode).toBe("fresh");
          expect(rec.freshAgreement).not.toBeNull();
        }
      }

      expect(rootChildCount).toBe(records.length);
      expect(rootValueCount).toBe(records.length);
      expect(freshProbeCount).toBeGreaterThan(0);

      // Stage B annotation under s2-seed + custom theta34 weights (beam regen smoke check).
      const defaultSpec = loadWeightSpec();
      const customWeightsPath = join(workDir, "custom-fit.json");
      writeFileSync(
        customWeightsPath,
        JSON.stringify({
          weightsId: "custom-fit-test",
          discount: DEFAULT_WEIGHTS.discount,
          theta34: Array.from({ length: NUM_TOTAL_FEATURES }, (_, idx) => (idx < 24 ? 0.1 : -0.05)),
        }),
      );
      const customSpec = loadWeightSpec(customWeightsPath);
      expect(customSpec.augmentedWeights?.length).toBe(10);

      for (const rec of records.slice(0, 3)) {
        const ann = annotateDecisionRecord(rec, {
          variants: ["existing", "corrected"],
          weightSpec: defaultSpec,
          width: 24,
        });
        expect(ann.annotations.existing).toBeDefined();
        expect(ann.annotations.corrected).toBeDefined();
        for (const variantAnn of [ann.annotations.existing, ann.annotations.corrected]) {
          expect(variantAnn?.candidates.length).toBeGreaterThan(0);
          for (const cand of variantAnn?.candidates ?? []) {
            expect(cand.phi34.length).toBe(NUM_TOTAL_FEATURES);
            expect(cand.pruningDepth).toBeGreaterThanOrEqual(1);
          }
        }

        const regen = annotateDecisionRecord(ann, {
          variants: ["corrected"],
          weightSpec: customSpec,
          width: 24,
        });
        expect(regen.annotations.corrected?.weightsId).toBe("custom-fit-test");
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("targeted tactical generator covers archetypes and survival stress states cleanly", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "attax-s2-tac-test-"));
    const tacPath = join(workDir, "tactical.jsonl");
    try {
      const summary = await generateImitationDataset({
        outputPath: tacPath,
        targetPositions: 14,
        freshEveryPlies: 6,
        quotas: {
          attax_vs_champion: 0,
          champion_selfplay: 0,
          champion_vs_historical: 0,
          corrected_attax_vs_champion: 0,
          targeted_tactical: 1,
        },
        annotateVariants: ["corrected"],
        width: 24,
      });
      expect(summary.totalPositions).toBeGreaterThanOrEqual(14);
      const records = readFileSync(tacPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as DecisionRecord);
      const tags = new Set(records.map((r) => r.tacticalTag));
      for (const arch of TACTICAL_ARCHETYPES.slice(0, 4)) {
        expect(tags.has(arch)).toBe(true);
      }
      expect(records.some((r) => r.stratification.hasPressure)).toBe(true);
      expect(records.every((r) => r.annotations.corrected !== undefined)).toBe(true);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 60_000);
});
