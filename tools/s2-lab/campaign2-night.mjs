#!/usr/bin/env bun
// Campaign-2 orchestrator — chain per S2-CAMPAIGN2-DESIGN.md
// (pre-registered 2026-11-15; Souta's order: fix J1 and restart the
// learning immediately):
//   tuning to iteration 60 (champion-only, redesigned objective),
//     with early-abort probes at iterations 30 (seeds 5501) and 60 (5601)
//   -> intermediate selection (26001) + validation (5301) [checkpoint]
//   -> tuning in chunks to iteration 120 (iteration-bound, no cutoff),
//     with an early-abort probe at iteration 90 (seeds 5701)
//   -> final selection (26501) + final validation (5401) [headline]
// A probe abort (paired ΔJ <= +0.10) ends the campaign cleanly with
// status "aborted" — the registered final result for this design.
// Stage markers make every stage resumable; the tuning driver resumes
// from its checkpoint state, so a relaunch at any point re-enters
// exactly once. The tuning stage carries the bounded retry wrapper
// (non-halt failures only; exit 3 is never retried).
import { spawn } from "node:child_process";
import { appendFile, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const defaults = {
  "state-dir": "/home/hatch/workspace/attax-s2/state2",
  "work-dir": "/home/hatch/workspace/attax-s2",
  iterations: "60",
  "total-iterations": "120",
  "games-per-eval": "8",
  "seed-base": "40011",
  "eval-stride": "10",
  "eval-runner": resolve(repo, "tools/s2-lab/eval-dispatch.mjs"),
  "repo-root": repo,
  "chunk-iterations": "10",
  "intermediate-selection-seed": "26001",
  "intermediate-validation-seed": "5301",
  "final-selection-seed": "26501",
  "final-validation-seed": "5401",
  "survival-weight": "0.3",
  "frozen-groups": "10",
};
const { values } = parseArgs({
  options: Object.fromEntries(
    Object.entries(defaults).map(([key, value]) => [key, { type: "string", default: value }]),
  ),
});
const root = resolve(values["repo-root"]);
const stateDir = resolve(values["state-dir"]),
  workDir = resolve(values["work-dir"]);
const report = resolve(workDir, "S2-CAMPAIGN2-2026-11-15.md");
const firstTarget = Number(values.iterations);
const totalTarget = Number(values["total-iterations"]);
const chunk = Number(values["chunk-iterations"]);
const exists = async (path) => {
  try {
    await stat(path);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
};
const json = async (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
const marker = (name) => resolve(stateDir, `night2-${name}.json`);
const status = (value) =>
  json(resolve(stateDir, "night2-status.json"), { ...value, updatedAt: new Date().toISOString() });
const sleep = (ms) => new Promise((accept) => setTimeout(accept, ms));
async function campaignIteration() {
  try {
    const state = JSON.parse(await readFile(resolve(stateDir, "campaign2-state.json"), "utf8"));
    return state.leagueIteration ?? null;
  } catch {
    return null;
  }
}
async function appendSectionOnce(header, body) {
  let current = "";
  try {
    current = await readFile(report, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (!current.includes(header)) await appendFile(report, body);
}
function launch(command, args, env = process.env) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => accept(code ?? 1));
  });
}
const survivalWeight = Number(values["survival-weight"]);
// Runs one eval job and returns its raw records. Transport failures
// (runner exit 75) are retried once with identical inputs; a persistent
// failure falls through to the records check and fails the (resumable)
// stage as before.
async function runEvalRecords(profile, games, seed, output) {
  const env = { ...process.env, ATTAX_S2_PROFILE: resolve(root, profile) };
  delete env.ATTAX_S2_OPPONENT_ID;
  delete env.ATTAX_S2_OPPONENT_PROFILE;
  // Runners append records; a restarted stage must start with an empty output.
  let code = 75;
  for (let attempt = 0; attempt < 2 && code === 75; attempt++) {
    await writeFile(output, "");
    code = await launch(
      values["eval-runner"],
      ["--games", String(games), "--seed", String(seed), "--out", output],
      env,
    );
    if (code === 75 && attempt === 0)
      console.error("evaluation transport failure; retrying once with identical inputs");
  }
  const records = (await readFile(output, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  if (records.length !== games) throw new Error(`expected ${games} records, got ${records.length}`);
  let excluded = 0;
  for (const r of records) {
    if (r.status === "error" && r.error?.startsWith("public compat error")) {
      excluded++;
      continue;
    }
    if (r.status === "error" || r.protocolErrors > 0)
      throw new Error(`evaluation error: ${r.error}`);
    const side =
      r.contestants.left === "attax" ? "left" : r.contestants.right === "attax" ? "right" : null;
    if (!side) throw new Error("missing main attax seat");
    for (const seat of ["left", "right"])
      if (!(r.locks[seat] > 0) || !Number.isFinite(r.attack[seat]))
        throw new Error("invalid APP inputs");
  }
  if (code !== 0 && !excluded) throw new Error(`runner failed: ${code}`);
  return { records, excluded };
}
async function evaluate(profile, games, seed, output) {
  const { records, excluded } = await runEvalRecords(profile, games, seed, output);
  let wins = 0,
    losses = 0,
    draws = 0,
    attaxAPP = 0,
    champAPP = 0;
  for (const r of records) {
    if (r.status === "error") continue;
    const side =
      r.contestants.left === "attax" ? "left" : r.contestants.right === "attax" ? "right" : null;
    const other = side === "left" ? "right" : "left";
    if (r.winner === null) draws++;
    else if (r.winner === side) wins++;
    else if (r.winner === other) losses++;
    attaxAPP += r.attack[side] / r.locks[side];
    champAPP += r.attack[other] / r.locks[other];
  }
  const count = records.length - excluded;
  if (!count) throw new Error("no usable evaluation records");
  return {
    wins,
    losses,
    draws,
    excluded,
    attaxAPP: attaxAPP / count,
    champAPP: champAPP / count,
    score: wins - losses,
  };
}
// Per-seed campaign-2 objective J for the early-abort probes: for each
// seed, the mean over that seed's finished games of the registered
// per-game composite [w + APP diff + survivalWeight * log2(locks+1)].
async function probeEvaluate(profile, games, seed, output) {
  const { records, excluded } = await runEvalRecords(profile, games, seed, output);
  const perSeed = new Map();
  for (const r of records) {
    if (r.status === "error") continue;
    const side =
      r.contestants.left === "attax" ? "left" : r.contestants.right === "attax" ? "right" : null;
    const other = side === "left" ? "right" : "left";
    const w = r.winner === null ? 0 : r.winner === side ? 1 : -1;
    const j =
      w +
      (r.attack[side] / r.locks[side] - r.attack[other] / r.locks[other]) +
      survivalWeight * Math.log2(r.locks[side] + 1);
    const entry = perSeed.get(r.seed) ?? { sum: 0, n: 0 };
    entry.sum += j;
    entry.n += 1;
    perSeed.set(r.seed, entry);
  }
  return { perSeed, excluded };
}
// Tuning stage with the registered bounded retry wrapper. Returns the
// driver's final exit code (0 = target reached). Exit 3 (C3 halt) is
// returned immediately, never retried.
async function runTuning(target, stageLabel, markerName) {
  if (await exists(marker(markerName))) return 0;
  await appendSectionOnce(
    "## Campaign 2 tuning",
    "\n## Campaign 2 tuning\n\nChampion-only fine-tune from the seed profile under the redesigned objective (S2-CAMPAIGN2-DESIGN.md).\n",
  );
  const args = [
    "tools/s2-lab/tune-spsa.mjs",
    "--league",
    "--champion-only",
    "--survival-weight",
    values["survival-weight"],
    "--frozen-groups",
    values["frozen-groups"],
    "--profile-namespace",
    "campaign2",
    "--iterations",
    String(target),
    "--games-per-eval",
    values["games-per-eval"],
    "--seed-base",
    values["seed-base"],
    "--eval-stride",
    values["eval-stride"],
    "--state",
    resolve(stateDir, "campaign2-state.json"),
    "--profile-out",
    "tools/s2-lab/profiles/s2-campaign2-tuned.json",
    "--log",
    report,
    "--eval-runner",
    values["eval-runner"],
  ];
  let code = 1;
  for (let attempt = 1; attempt <= 6; attempt++) {
    await status({
      status: "running",
      stage: stageLabel,
      target,
      attempt,
      campaignIteration: await campaignIteration(),
    });
    console.log(`=== CAMPAIGN 2: TUNING to ${target} (attempt ${attempt}) ===`);
    code = await launch("bun", args);
    if (code === 0 || code === 3) break;
    if (attempt < 6) {
      console.error(`tuning driver exited ${code}; retrying in 60s (attempt ${attempt + 1}/6)`);
      await sleep(60000);
    }
  }
  if (code === 0) await json(marker(markerName), { completed: new Date().toISOString(), target });
  return code;
}
async function runSelection({ suffix, seed, heading, markerName, stageLabel }) {
  const resultsPath = resolve(workDir, `selection2${suffix}-results.json`);
  if (await exists(marker(markerName))) return JSON.parse(await readFile(resultsPath, "utf8"));
  await status({
    status: "running",
    stage: stageLabel,
    campaignIteration: await campaignIteration(),
  });
  console.log(`=== CAMPAIGN 2: SELECTION ${suffix || "(intermediate)"} (champion only) ===`);
  const candidates = [];
  for (const [id, profile] of [
    ["seed", "tools/s2-lab/profiles/s2-seed.json"],
    ["final", "tools/s2-lab/profiles/s2-campaign2-tuned.json"],
    ["best-eval", "tools/s2-lab/profiles/campaign2/best-eval.json"],
  ]) {
    if (!(await exists(resolve(root, profile)))) continue;
    candidates.push({
      id,
      profile,
      ...(await evaluate(profile, 20, seed, resolve(workDir, `selection2${suffix}-${id}.jsonl`))),
    });
  }
  if (!candidates.some((c) => c.id === "seed"))
    throw new Error("selection requires seed candidate");
  const priority = { final: 2, "best-eval": 1, seed: 0 };
  const winner = [...candidates].sort(
    (a, b) =>
      b.score - a.score ||
      b.attaxAPP - b.champAPP - (a.attaxAPP - a.champAPP) ||
      priority[b.id] - priority[a.id],
  )[0];
  // Registered discipline: a candidate with >10% exclusions voids the round.
  const voided = candidates.filter((c) => c.excluded > 2);
  const results = { candidates, winnerId: winner.id, voided: voided.map((c) => c.id) };
  await json(resultsPath, results);
  await appendFile(
    report,
    `\n${heading}\n\n${candidates.map((c) => `- ${c.id}: ${c.wins}-${c.losses}-${c.draws}, score ${c.score}, APP ${c.attaxAPP}/${c.champAPP}, excluded ${c.excluded}`).join("\n")}\n\nSelected: ${winner.id}.${voided.length ? `\n\nRound voided (exclusions >10% for: ${voided.map((c) => c.id).join(", ")}) — reported as inconclusive.` : ""}\n`,
  );
  await json(marker(markerName), { winnerId: winner.id, voided: results.voided });
  return results;
}
async function runValidation({
  suffix,
  seed,
  heading,
  markerName,
  stageLabel,
  selection,
  verdictLabel,
}) {
  const resultPath = resolve(workDir, `validation2${suffix}-result.json`);
  if (await exists(marker(markerName))) return JSON.parse(await readFile(resultPath, "utf8"));
  await status({
    status: "running",
    stage: stageLabel,
    campaignIteration: await campaignIteration(),
  });
  console.log(`=== CAMPAIGN 2: VALIDATION ${suffix || "(intermediate)"} (champion only) ===`);
  const bar = "wins >= 8 AND winner selection score > seed selection score";
  if (selection.voided?.length) {
    const result = { pass: false, inconclusive: true, reason: "selection round voided", bar };
    await json(resultPath, result);
    await appendFile(
      report,
      `\n${heading}\n\nNot run: the selection round was voided by exclusions.\n\nPre-registered bar: ${bar}.\n\n${verdictLabel}: INCONCLUSIVE.\n`,
    );
    await json(marker(markerName), { validationPass: false, inconclusive: true });
    return result;
  }
  const winner = selection.candidates.find((c) => c.id === selection.winnerId);
  const seedCandidate = selection.candidates.find((c) => c.id === "seed");
  // APP guard (claim overlay, S2-CAMPAIGN2-DESIGN.md): the winner's
  // selection-round attax APP must be >= the seed's - 0.05.
  const appGuard = winner.attaxAPP >= seedCandidate.attaxAPP - 0.05;
  const { score: _score, ...metrics } = await evaluate(
    winner.profile,
    40,
    seed,
    resolve(workDir, `validation2${suffix}-records.jsonl`),
  );
  // Registered discipline: >4 exclusions of 40 makes the match inconclusive.
  const inconclusive = metrics.excluded > 4;
  const pass = !inconclusive && metrics.wins >= 8 && winner.score > seedCandidate.score;
  const result = { ...metrics, pass, inconclusive, appGuard, bar };
  await json(resultPath, result);
  await appendFile(
    report,
    `\n${heading}\n\n${winner.id}: ${metrics.wins}-${metrics.losses}-${metrics.draws}; APP ${metrics.attaxAPP}/${metrics.champAPP}; excluded ${metrics.excluded}.\n\nAPP guard (winner selection APP ${winner.attaxAPP.toFixed(4)} vs seed ${seedCandidate.attaxAPP.toFixed(4)} - 0.05): ${appGuard ? "PASS" : "FAIL"}.\n\nPre-registered bar: ${bar}.\n\n${verdictLabel}: ${inconclusive ? "INCONCLUSIVE" : pass ? (appGuard ? "PASS" : "PASS (bar) — guard FAIL, improvement not claimed") : "FAIL"}.\n`,
  );
  await json(marker(markerName), { validationPass: pass, inconclusive, appGuard });
  return result;
}
// Early-abort probe (registered in S2-CAMPAIGN2-DESIGN.md): paired
// current-theta vs seed-profile on a fresh seed block; aborts the
// campaign when the paired objective difference is <= +0.10.
class CampaignAbort extends Error {
  constructor(checkpoint, result) {
    super(`campaign aborted at checkpoint ${checkpoint}`);
    this.campaignAbort = true;
    this.checkpoint = checkpoint;
    this.result = result;
  }
}
async function runProbe({ checkpoint, seedStart, markerName }) {
  const resultPath = resolve(workDir, `probe2-cp${checkpoint}-result.json`);
  if (await exists(marker(markerName))) return JSON.parse(await readFile(resultPath, "utf8"));
  await status({
    status: "running",
    stage: `probe-${checkpoint}`,
    campaignIteration: await campaignIteration(),
  });
  console.log(
    `=== CAMPAIGN 2: EARLY-ABORT PROBE at iteration ${checkpoint} (seeds ${seedStart}-${seedStart + 19}) ===`,
  );
  const thetaProfile = `tools/s2-lab/profiles/campaign2/theta-iter${checkpoint}.json`;
  await copyFile(
    resolve(root, "tools/s2-lab/profiles/s2-campaign2-tuned.json"),
    resolve(root, thetaProfile),
  );
  const theta = await probeEvaluate(
    thetaProfile,
    40,
    seedStart,
    resolve(workDir, `probe2-cp${checkpoint}-theta.jsonl`),
  );
  const seedP = await probeEvaluate(
    "tools/s2-lab/profiles/s2-seed.json",
    40,
    seedStart,
    resolve(workDir, `probe2-cp${checkpoint}-seed.jsonl`),
  );
  const deltas = [];
  for (const [seed, t] of theta.perSeed) {
    const s = seedP.perSeed.get(seed);
    if (s) deltas.push(t.sum / t.n - s.sum / s.n);
  }
  const pairedSeeds = deltas.length;
  const mean = pairedSeeds ? deltas.reduce((a, b) => a + b, 0) / pairedSeeds : null;
  const sd =
    pairedSeeds > 1
      ? Math.sqrt(deltas.reduce((a, b) => a + (b - mean) ** 2, 0) / (pairedSeeds - 1))
      : null;
  const voidProbe = pairedSeeds < 16;
  const abort = !voidProbe && mean <= 0.1;
  const result = {
    checkpoint,
    seedStart,
    pairedSeeds,
    delta: mean,
    sd,
    thetaExcluded: theta.excluded,
    seedExcluded: seedP.excluded,
    void: voidProbe,
    abort,
    threshold: 0.1,
  };
  await json(resultPath, result);
  await appendFile(
    report,
    `\n## Early-abort probe — checkpoint ${checkpoint} (seeds ${seedStart}-${seedStart + 19})\n\nPaired seeds: ${pairedSeeds}/20; ΔJ (theta − seed, campaign-2 objective): ${mean === null ? "n/a" : mean.toFixed(4)}${sd !== null ? ` (sd ${sd.toFixed(4)})` : ""}; excluded theta ${theta.excluded} / seed ${seedP.excluded}.\n\nRegistered threshold: abort if Δ <= +0.10.${voidProbe ? " Probe VOID (fewer than 16 paired seeds) — cannot abort; campaign continues." : abort ? " **ABORT — objective not moving. This is the campaign's final result for this design.**" : " Continue."}\n`,
  );
  await json(marker(markerName), { checkpoint, delta: mean, pairedSeeds, abort, void: voidProbe });
  return result;
}
async function probeOrAbort(checkpoint, seedStart) {
  const result = await runProbe({ checkpoint, seedStart, markerName: `probe-${checkpoint}` });
  if (result.abort) throw new CampaignAbort(checkpoint, result);
  return result;
}
let stage = "tuning";
try {
  await mkdir(stateDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  // Phase A: tuning to 30, probe, tuning to the intermediate target (60), probe.
  let code = await runTuning(30, "tuning", "tuning-30");
  if (code !== 0) {
    await status(code === 3 ? { status: "halted", stage } : { status: "failed", stage, code });
    process.exit(code);
  }
  stage = "probe-30";
  await probeOrAbort(30, 5501);
  stage = "tuning";
  code = await runTuning(firstTarget, "tuning", "tuning");
  if (code !== 0) {
    await status(code === 3 ? { status: "halted", stage } : { status: "failed", stage, code });
    process.exit(code);
  }
  stage = "probe-60";
  await probeOrAbort(60, 5601);
  // Intermediate checkpoint: selection + validation (checkpoint only).
  stage = "selection";
  const intermediateSelection = await runSelection({
    suffix: "",
    seed: Number(values["intermediate-selection-seed"]),
    heading: "## Champion-only selection — intermediate checkpoint",
    markerName: "selection",
    stageLabel: "selection",
  });
  stage = "validation";
  const intermediate = await runValidation({
    suffix: "",
    seed: Number(values["intermediate-validation-seed"]),
    heading: "## Held-out validation — intermediate checkpoint",
    markerName: "validation",
    stageLabel: "validation",
    selection: intermediateSelection,
    verdictLabel: "Checkpoint verdict (not the campaign's headline)",
  });
  // Phase B: tuning in chunks to the registered total (120), with the
  // iteration-90 early-abort probe.
  stage = "tuning-extended";
  let target = firstTarget;
  while (target < totalTarget) {
    target = Math.min(target + chunk, totalTarget);
    code = await runTuning(target, "tuning-extended", `tuning-${target}`);
    if (code !== 0) {
      await status(code === 3 ? { status: "halted", stage } : { status: "failed", stage, code });
      process.exit(code);
    }
    if (target === 90) {
      stage = "probe-90";
      await probeOrAbort(90, 5701);
      stage = "tuning-extended";
    }
  }
  // Final selection + validation — the headline.
  stage = "selection-final";
  const finalSelection = await runSelection({
    suffix: "-final",
    seed: Number(values["final-selection-seed"]),
    heading: "## Final selection",
    markerName: "selection-final",
    stageLabel: "selection-final",
  });
  stage = "validation-final";
  const final = await runValidation({
    suffix: "-final",
    seed: Number(values["final-validation-seed"]),
    heading: "## Final validation",
    markerName: "validation-final",
    stageLabel: "validation-final",
    selection: finalSelection,
    verdictLabel: "Verdict",
  });
  await status({
    status: "complete",
    validationPass: final.pass,
    appGuard: final.appGuard,
    intermediateValidationPass: intermediate.pass,
    campaignIteration: await campaignIteration(),
  });
} catch (error) {
  if (error?.campaignAbort) {
    // Registered early abort: a clean, final stop for this design.
    console.error(
      `CAMPAIGN 2 ABORTED at checkpoint ${error.checkpoint}: ΔJ ${error.result.delta} <= +0.10 (paired seeds ${error.result.pairedSeeds})`,
    );
    await status({
      status: "aborted",
      stage,
      checkpoint: error.checkpoint,
      delta: error.result.delta,
      pairedSeeds: error.result.pairedSeeds,
      campaignIteration: await campaignIteration(),
    });
    process.exitCode = 0;
  } else {
    console.error(error);
    await status({ status: "failed", stage, code: 1 });
    process.exitCode = 1;
  }
}
