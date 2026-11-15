#!/usr/bin/env bun
// VM-local eval runner (campaign-2 formation amendment 2026-11-15): the
// same CLI contract as eval-via-pc.mjs (--games/--seed/--out,
// ATTAX_S2_PROFILE / ATTAX_S2_OPPONENT_* env) and the same exit-code
// semantics (0 = records written to --out; 1 = worker/record failure;
// there is no transport class on the local node). The job runs the
// eval-worker from this repo (the campaign tree itself) against the
// VM lab checkout, so records are byte-compatible with the other
// C5-qualified nodes. Rotation reaches this backend at most one job at
// a time, keeping VM load conservative next to the orchestrator and
// the item-90 units.
import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: Object.fromEntries(["games", "seed", "out"].map((key) => [key, { type: "string" }])),
});
try {
  const games = Number(values.games),
    seed = Number(values.seed);
  if (
    !values.games ||
    !Number.isSafeInteger(games) ||
    games < 1 ||
    !values.seed ||
    !Number.isSafeInteger(seed) ||
    seed < 0 ||
    !values.out
  )
    throw new Error("--games, --seed and --out are required with valid integers");
  if (!process.env.ATTAX_S2_PROFILE) throw new Error("ATTAX_S2_PROFILE is required");
  const profile = JSON.parse(await readFile(process.env.ATTAX_S2_PROFILE, "utf8"));
  const opponentId = process.env.ATTAX_S2_OPPONENT_ID;
  const opponentProfile = process.env.ATTAX_S2_OPPONENT_PROFILE;
  if (!!opponentId !== !!opponentProfile)
    throw new Error("opponent id and profile must be supplied together");
  const opponent = opponentId
    ? {
        kind: "attax-profile",
        id: opponentId,
        profile: JSON.parse(await readFile(opponentProfile, "utf8")),
      }
    : { kind: "champion" };
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const labRoot = resolve(root, process.env.S2_LAB_ROOT ?? "../s2-bot-lab-ref");
  const expect = {
    wasmSha256: "facb773f18feb041868e21022442e52754fbc5972c813577bc56586b1c653731",
    championProfileSha256: "b3d8686a4faa786746ed5b57d8bd09cdd30f88f1735b548e619b9ed63d498d6c",
    labHead: execFileSync("git", ["-C", labRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
  };
  const jobId = `vm-${seed}-${games}-${process.pid}-1`;
  const job = { jobId, profile, seedStart: seed, games, opponent, expect };
  const dir = await mkdtemp(join(tmpdir(), `s2-vm-eval-${jobId}-`));
  try {
    const jobPath = join(dir, "job.json");
    const resultPath = join(dir, "result.json");
    const recordsPath = join(dir, "records.jsonl");
    await writeFile(jobPath, JSON.stringify(job));
    const code = await new Promise((accept, reject) => {
      const child = spawn(
        "bun",
        [
          "tools/s2-lab/eval-worker.mjs",
          "--job",
          jobPath,
          "--result",
          resultPath,
          "--records",
          recordsPath,
        ],
        {
          cwd: root,
          env: { ...process.env, S2_LAB_ROOT: labRoot },
          stdio: "inherit",
        },
      );
      child.on("error", reject);
      child.on("close", (c) => accept(c ?? 1));
    });
    if (code !== 0) throw new Error(`VM evaluation worker failed (exit ${code})`);
    const records = await readFile(recordsPath);
    const lines = records
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim());
    if (!lines.length) throw new Error("VM records file is empty");
    for (const line of lines) JSON.parse(line);
    await copyFile(recordsPath, values.out);
    const result = (await readFile(resultPath, "utf8")).trim();
    console.error(`VM evaluation: ${JSON.stringify(JSON.parse(result))}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
