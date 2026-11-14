#!/usr/bin/env bun
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
const marker = (stage) => resolve(stateDir, `night-${stage}.json`);
const status = (value) => json(resolve(stateDir, "night-status.json"), value);
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
  await writeFile(output, "");
  const code = await launch(
    values["eval-runner"],
    ["--games", String(games), "--seed", String(seed), "--out", output],
    env,
  );
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
let stage = "tuning";
try {
  await mkdir(stateDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  if (!(await exists(marker(stage)))) {
    console.log("=== LEAGUE NIGHT: TUNING ===");
    await appendFile(
      report,
      "\n## League tuning\n\nRestarted from the seed profile under the corrected model.\n",
    );
    const code = await launch("bun", [
      "tools/s2-lab/tune-spsa.mjs",
      "--league",
      "--iterations",
      values.iterations,
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
    ]);
    if (code !== 0) {
      await status(code === 3 ? { status: "halted", stage } : { status: "failed", stage, code });
      process.exit(code);
    }
    await json(marker(stage), { completed: new Date().toISOString() });
  }
  stage = "selection";
  if (!(await exists(marker(stage)))) {
    console.log("=== LEAGUE NIGHT: SELECTION (champion only) ===");
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
        ...(await evaluate(profile, 20, 25001, resolve(workDir, `selection-${id}.jsonl`))),
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
    await json(resolve(workDir, "selection-results.json"), { candidates, winnerId: winner.id });
    await appendFile(
      report,
      `\n## Champion-only selection\n\n${candidates.map((c) => `- ${c.id}: ${c.wins}-${c.losses}-${c.draws}, score ${c.score}, APP ${c.attaxAPP}/${c.champAPP}, excluded ${c.excluded}`).join("\n")}\n\nSelected: ${winner.id}.\n`,
    );
    await json(marker(stage), { winnerId: winner.id });
  }
  stage = "validation";
  if (!(await exists(marker(stage)))) {
    console.log("=== LEAGUE NIGHT: VALIDATION (champion only) ===");
    const selection = JSON.parse(
      await readFile(resolve(workDir, "selection-results.json"), "utf8"),
    );
    const winner = selection.candidates.find((c) => c.id === selection.winnerId);
    const seed = selection.candidates.find((c) => c.id === "seed");
    const { score: _score, ...metrics } = await evaluate(
      winner.profile,
      40,
      5101,
      resolve(workDir, "validation-records.jsonl"),
    );
    const pass = metrics.wins >= 8 && winner.score > seed.score;
    const bar = "wins >= 8 AND winner selection score > seed selection score";
    await json(resolve(workDir, "validation-result.json"), { ...metrics, pass, bar });
    await appendFile(
      report,
      `\n## Held-out validation\n\n${winner.id}: ${metrics.wins}-${metrics.losses}-${metrics.draws}; APP ${metrics.attaxAPP}/${metrics.champAPP}; excluded ${metrics.excluded}.\n\nPre-registered bar: ${bar}.\n\nVerdict: ${pass ? "PASS" : "FAIL"}.\n`,
    );
    await json(marker(stage), { validationPass: pass });
  }
  const validation = JSON.parse(await readFile(resolve(workDir, "validation-result.json"), "utf8"));
  await status({ status: "complete", validationPass: validation.pass });
} catch (error) {
  console.error(error);
  await status({ status: "failed", stage, code: 1 });
  process.exitCode = 1;
}
