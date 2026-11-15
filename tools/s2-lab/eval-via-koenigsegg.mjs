#!/usr/bin/env bun
// Koenigsegg-agera eval runner (campaign-2 formation amendment
// 2026-11-15): the SSH analogue of eval-via-pc.mjs. Same CLI contract
// (--games/--seed/--out, ATTAX_S2_PROFILE / ATTAX_S2_OPPONENT_* env)
// and the same exit-code semantics: 0 = records written to --out;
// 75 = transport failure (ssh/scp layer; the driver's transport policy
// applies); 1 = worker/record failure. The node layout mirrors the PC
// (~/attax-s2, ~/s2-bot-lab, ~/s2-jobs) and it runs the identical
// eval-worker, so records are byte-compatible with PC-dispatched ones.
// Access: key auth as s0u7a@100.77.221.54 through the tailnet proxy
// (~/.local/bin/ts-connect). The identity file is passed explicitly:
// ssh resolves default identities from the passwd home, which is not
// where this VM keeps its key.
import { execFileSync, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: Object.fromEntries(["games", "seed", "out"].map((key) => [key, { type: "string" }])),
});
class TransportError extends Error {}
const home = process.env.HOME ?? homedir();
const sshBase = [
  "-i",
  join(home, ".ssh/id_ed25519"),
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  `ProxyCommand=${join(home, ".local/bin/ts-connect")} %h %p`,
  "-o",
  `UserKnownHostsFile=${join(home, ".ssh/known_hosts")}`,
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=25",
  "s0u7a@100.77.221.54",
];
function run(file, args, timeoutMs = 90000) {
  return new Promise((accept, reject) => {
    const child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
    const outChunks = [];
    const errChunks = [];
    child.stdout.on("data", (chunk) => outChunks.push(chunk));
    child.stderr.on("data", (chunk) => errChunks.push(chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new TransportError(`${file} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new TransportError(error?.message ?? String(error)));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      accept({
        code: code ?? 1,
        stdout: Buffer.concat(outChunks).toString("utf8"),
        stderr: Buffer.concat(errChunks).toString("utf8"),
      });
    });
  });
}
async function ssh(command, timeoutMs = 90000) {
  const result = await run("ssh", [...sshBase, command], timeoutMs);
  if (result.code !== 0)
    throw new TransportError(
      `ssh command failed (exit ${result.code}): ${result.stderr.slice(-300)}`,
    );
  return result.stdout;
}
const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
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
  const expect = {
    wasmSha256: "facb773f18feb041868e21022442e52754fbc5972c813577bc56586b1c653731",
    championProfileSha256: "b3d8686a4faa786746ed5b57d8bd09cdd30f88f1735b548e619b9ed63d498d6c",
    labHead: execFileSync(
      "git",
      ["-C", resolve(root, process.env.S2_LAB_ROOT ?? "../s2-bot-lab-ref"), "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim(),
  };
  const attax = process.env.S2_KOE_ATTAX || "$HOME/attax-s2";
  const lab = process.env.S2_KOE_LAB || "$HOME/s2-bot-lab";
  const jobs = process.env.S2_KOE_JOBS || "$HOME/s2-jobs";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const jobId = `koe-${seed}-${games}-${process.pid}-${attempt}`;
      const job = { jobId, profile, seedStart: seed, games, opponent, expect };
      const jobPath = `${jobs}/${jobId}.json`;
      const resultPath = `${jobs}/${jobId}.result.json`;
      const recordsPath = `${jobs}/${jobId}.records.jsonl`;
      const donePath = `${jobs}/${jobId}.done`;
      const logPath = `${jobs}/${jobId}.log`;
      const encoded = Buffer.from(JSON.stringify(job)).toString("base64");
      await ssh(`mkdir -p ${jobs} && printf %s '${encoded}' | base64 -d > ${jobPath}`);
      const workerCommand =
        `PATH=$HOME/.bun/bin:$PATH S2_LAB_ROOT=${lab} bun ${attax}/tools/s2-lab/eval-worker.mjs` +
        ` --job ${jobPath} --result ${resultPath} --records ${recordsPath} > ${logPath} 2>&1; echo $? > ${donePath}`;
      await ssh(
        `rm -f ${resultPath} ${recordsPath} ${donePath} ${logPath} && nohup sh -c ${quote(workerCommand)} </dev/null >/dev/null 2>&1 & echo started`,
      );
      const deadline = Date.now() + 15 * 60 * 1000;
      let misses = 0;
      for (;;) {
        if (Date.now() >= deadline) throw new Error("remote evaluation timed out after 15 minutes");
        await sleep(Math.min(5000, deadline - Date.now()));
        let exitCode = "";
        try {
          // `|| true`: a not-yet-written .done file makes cat exit 1,
          // which is the normal polling state, not a transport failure.
          exitCode = (await ssh(`cat ${donePath} 2>/dev/null || true`, 60000)).trim();
          misses = 0;
        } catch (error) {
          // A poll that fails on transport says nothing about the job;
          // tolerate a few, then classify as transport failure.
          if (++misses >= 4) throw error;
          continue;
        }
        if (!exitCode) continue;
        if (!/^\d+$/.test(exitCode)) throw new Error("invalid remote worker exit code");
        if (Number(exitCode) !== 0) {
          const tail = await ssh(`tail -20 ${logPath} 2>/dev/null`, 60000).catch(() => "");
          console.error(tail);
          throw new Error(`remote evaluation worker failed (exit ${exitCode})`);
        }
        break;
      }
      // Fetch over the same ssh channel (byte-clean tunnel, unlike
      // morsh): the records are UTF-8 JSONL, well under any pipe limit.
      const recordsText = await ssh(`cat ${recordsPath}`, 120000);
      const lines = recordsText.split("\n").filter((line) => line.trim());
      if (!lines.length) throw new Error("remote records file is empty");
      for (const line of lines) JSON.parse(line);
      await writeFile(values.out, recordsText);
      const result = (await ssh(`cat ${resultPath}`, 60000)).trim();
      console.error(`KOENIGSEGG evaluation: ${JSON.stringify(JSON.parse(result))}`);
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      console.error("KOENIGSEGG evaluation attempt 1 failed; retrying:", error);
    }
  }
} catch (error) {
  console.error(error);
  if (error instanceof TransportError) {
    console.error("EVAL_TRANSPORT_FAILURE");
    process.exitCode = 75;
  } else {
    process.exitCode = 1;
  }
}
