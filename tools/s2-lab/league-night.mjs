#!/usr/bin/env bun
// League night orchestrator — extended chain per the amendment of
// 2026-11-15 02:52 JST in S2-LEAGUE-DESIGN.md (Souta's order: run until
// morning, no cap at 60):
//   tuning to iteration 60
//   -> intermediate selection + validation (registered seeds 25001 / 5101)
//   -> tuning resumes in chunks until the 06:15 JST cutoff
//   -> final selection (fresh 25501) + final validation (fresh 5201)
// The final validation is the night's headline. Stage markers make every
// stage resumable; the tuning driver resumes from its checkpoint state, so
// a relaunch at any point re-enters exactly once. The tuning stage carries
// a bounded retry wrapper (non-halt failures only; exit 3 is never
// retried) so a transient eval-transport drop cannot end the night.
import { spawn } from "node:child_process";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const defaults = {
  "state-dir": "/home/hatch/workspace/attax-s2/state",
  "work-dir": "/home/hatch/workspace/attax-s2",
  iterations: "60",
  "games-per-eval": "4",
  "seed-base": "30011",
  "eval-stride": "10",
  "eval-runner": resolve(repo, "tools/s2-lab/eval-via-pc.mjs"),
  "repo-root": repo,
  cutoff: "2026-11-15T06:15:00+09:00",
  "chunk-iterations": "10",
  "final-selection-seed": "25501",
  "final-validation-seed": "5201",
};
const { values } = parseArgs({
  options: Object.fromEntries(
    Object.entries(defaults).map(([key, value]) => [key, { type: "string", default: value }]),
  ),
});
const root = resolve(values["repo-root"]);
const stateDir = resolve(values["state-dir"]),
  workDir = resolve(values["work-dir"]);
const report = resolve(workDir, "S2-CAMPAIGN-2026-11-15.md");
const cutoffMs = Date.parse(values.cutoff);
if (!Number.isFinite(cutoffMs)) throw new Error(`invalid --cutoff ${values.cutoff}`);
const firstTarget = Number(values.iterations);
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
const marker = (name) => resolve(stateDir, `night-${name}.json`);
const status = (value) =>
  json(resolve(stateDir, "night-status.json"), { ...value, updatedAt: new Date().toISOString() });
const sleep = (ms) => new Promise((accept) => setTimeout(accept, ms));
async function leagueIteration() {
  try {
    const state = JSON.parse(await readFile(resolve(stateDir, "league-state.json"), "utf8"));
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
async function evaluate(profile, games, seed, output) {
  const env = { ...process.env, ATTAX_S2_PROFILE: resolve(root, profile) };
  delete env.ATTAX_S2_OPPONENT_ID;
  delete env.ATTAX_S2_OPPONENT_PROFILE;
  // Runners append records; a restarted stage must start with an empty output.
  // Transport failures (runner exit 75; amendment 2026-11-15 03:00 JST) are
  // retried once with identical inputs; a persistent failure falls through
  // to the records check and fails the (resumable) stage as before.
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
  let wins = 0,
    losses = 0,
    draws = 0,
    excluded = 0,
    attaxAPP = 0,
    champAPP = 0;
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
    const other = side === "left" ? "right" : "left";
    if (r.winner === null) draws++;
    else if (r.winner === side) wins++;
    else if (r.winner === other) losses++;
    else throw new Error("invalid winner");
    for (const seat of [side, other])
      if (!(r.locks[seat] > 0) || !Number.isFinite(r.attack[seat]))
        throw new Error("invalid APP inputs");
    attaxAPP += r.attack[side] / r.locks[side];
    champAPP += r.attack[other] / r.locks[other];
  }
  if (code !== 0 && !excluded) throw new Error(`runner failed: ${code}`);
  const count = games - excluded;
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
// Tuning stage with the registered bounded retry wrapper. Returns the
// driver's final exit code (0 = target reached). Exit 3 (C3 halt) is
// returned immediately, never retried.
async function runTuning(target, stageLabel, markerName) {
  if (await exists(marker(markerName))) return 0;
  await appendSectionOnce(
    "## League tuning",
    "\n## League tuning\n\nRestarted from the seed profile under the corrected model.\n",
  );
  const args = [
    "tools/s2-lab/tune-spsa.mjs",
    "--league",
    "--iterations",
    String(target),
    "--games-per-eval",
    values["games-per-eval"],
    "--seed-base",
    values["seed-base"],
    "--eval-stride",
    values["eval-stride"],
    "--state",
    resolve(stateDir, "league-state.json"),
    "--profile-out",
    "tools/s2-lab/profiles/s2-league-tuned.json",
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
      leagueIteration: await leagueIteration(),
    });
    console.log(`=== LEAGUE NIGHT: TUNING to ${target} (attempt ${attempt}) ===`);
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
  const resultsPath = resolve(workDir, `selection${suffix}-results.json`);
  if (await exists(marker(markerName))) return JSON.parse(await readFile(resultsPath, "utf8"));
  await status({ status: "running", stage: stageLabel, leagueIteration: await leagueIteration() });
  console.log(`=== LEAGUE NIGHT: SELECTION ${suffix || "(intermediate)"} (champion only) ===`);
  const candidates = [];
  for (const [id, profile] of [
    ["seed", "tools/s2-lab/profiles/s2-seed.json"],
    ["final", "tools/s2-lab/profiles/s2-league-tuned.json"],
    ["best-eval", "tools/s2-lab/profiles/league/best-eval.json"],
  ]) {
    if (!(await exists(resolve(root, profile)))) continue;
    candidates.push({
      id,
      profile,
      ...(await evaluate(profile, 20, seed, resolve(workDir, `selection${suffix}-${id}.jsonl`))),
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
  const resultPath = resolve(workDir, `validation${suffix}-result.json`);
  if (await exists(marker(markerName))) return JSON.parse(await readFile(resultPath, "utf8"));
  await status({ status: "running", stage: stageLabel, leagueIteration: await leagueIteration() });
  console.log(`=== LEAGUE NIGHT: VALIDATION ${suffix || "(intermediate)"} (champion only) ===`);
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
  const { score: _score, ...metrics } = await evaluate(
    winner.profile,
    40,
    seed,
    resolve(workDir, `validation${suffix}-records.jsonl`),
  );
  // Registered discipline: >4 exclusions of 40 makes the match inconclusive.
  const inconclusive = metrics.excluded > 4;
  const pass = !inconclusive && metrics.wins >= 8 && winner.score > seedCandidate.score;
  const result = { ...metrics, pass, inconclusive, bar };
  await json(resultPath, result);
  await appendFile(
    report,
    `\n${heading}\n\n${winner.id}: ${metrics.wins}-${metrics.losses}-${metrics.draws}; APP ${metrics.attaxAPP}/${metrics.champAPP}; excluded ${metrics.excluded}.\n\nPre-registered bar: ${bar}.\n\n${verdictLabel}: ${inconclusive ? "INCONCLUSIVE" : pass ? "PASS" : "FAIL"}.\n`,
  );
  await json(marker(markerName), { validationPass: pass, inconclusive });
  return result;
}
let stage = "tuning";
try {
  await mkdir(stateDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  // Phase 1: tuning to the originally registered 60 iterations.
  let code = await runTuning(firstTarget, "tuning", "tuning");
  if (code !== 0) {
    await status(code === 3 ? { status: "halted", stage } : { status: "failed", stage, code });
    process.exit(code);
  }
  // Phase 2: the at-60 selection + validation, now the intermediate checkpoint.
  stage = "selection";
  const intermediateSelection = await runSelection({
    suffix: "",
    seed: 25001,
    heading: "## Champion-only selection — intermediate checkpoint",
    markerName: "selection",
    stageLabel: "selection",
  });
  stage = "validation";
  const intermediate = await runValidation({
    suffix: "",
    seed: 5101,
    heading: "## Held-out validation — intermediate checkpoint",
    markerName: "validation",
    stageLabel: "validation",
    selection: intermediateSelection,
    verdictLabel: "Checkpoint verdict (not the night's headline)",
  });
  // Phase 3: uncapped tuning in chunks until the morning cutoff.
  stage = "tuning-extended";
  let target = firstTarget;
  while (Date.now() < cutoffMs) {
    target += chunk;
    code = await runTuning(target, "tuning-extended", `tuning-${target}`);
    if (code !== 0) {
      await status(code === 3 ? { status: "halted", stage } : { status: "failed", stage, code });
      process.exit(code);
    }
  }
  // Phase 4: final selection + validation at the cutoff — the headline.
  stage = "selection-final";
  const finalSelection = await runSelection({
    suffix: "-final",
    seed: Number(values["final-selection-seed"]),
    heading: "## Final selection (cutoff)",
    markerName: "selection-final",
    stageLabel: "selection-final",
  });
  stage = "validation-final";
  const final = await runValidation({
    suffix: "-final",
    seed: Number(values["final-validation-seed"]),
    heading: "## Final validation (cutoff)",
    markerName: "validation-final",
    stageLabel: "validation-final",
    selection: finalSelection,
    verdictLabel: "Verdict",
  });
  await status({
    status: "complete",
    validationPass: final.pass,
    intermediateValidationPass: intermediate.pass,
    leagueIteration: await leagueIteration(),
  });
} catch (error) {
  console.error(error);
  await status({ status: "failed", stage, code: 1 });
  process.exitCode = 1;
}
