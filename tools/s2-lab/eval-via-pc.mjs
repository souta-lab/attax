#!/usr/bin/env bun
import { execFileSync, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: Object.fromEntries(["games", "seed", "out"].map((key) => [key, { type: "string" }])),
});
const quote = (value) => `'${value.replace(/'/g, "'\\''")}'`;
// Expand home paths on the remote shell while quoting the rest literally.
function remotePath(value) {
  if (value === "~") return '"$HOME"';
  if (value.startsWith("~/")) return `"$HOME"/${quote(value.slice(2))}`;
  return quote(value);
}
async function pc(command, capture = false, timeoutMs = 90000) {
  return new Promise((accept, reject) => {
    const child = spawn("/home/hatch/bin/pc", [command], {
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    });
    const chunks = [];
    if (capture) child.stdout.on("data", (chunk) => chunks.push(chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`pc command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`pc command failed (exit ${code})`));
      else accept(Buffer.concat(chunks).toString("utf8"));
    });
  });
}
let payloadCounter = 0;
async function pcPayload(producerCommand) {
  const nonce = `n${process.pid}x${payloadCounter++}x${Date.now().toString(36)}`;
  const begin = `S2B-${nonce}`;
  const end = `S2E-${nonce}`;
  const output = await pc(`printf '${begin}\\n'; ${producerCommand}; printf '\\n${end}\\n'`, true);
  await writeFile("/tmp/pcpayload-last.txt", output).catch(() => {});
  const marker = output.lastIndexOf(`\n${begin}`);
  const beginIndex = marker >= 0 ? marker + 1 : output.startsWith(begin) ? 0 : -1;
  const payloadStart = beginIndex >= 0 ? output.indexOf("\n", beginIndex) : -1;
  const payloadEnd = payloadStart >= 0 ? output.indexOf(`\n${end}`, payloadStart) : -1;
  if (payloadStart < 0 || payloadEnd < 0) throw new Error("missing remote payload markers");
  return output.slice(payloadStart + 1, payloadEnd).replace(/\r/g, "");
}
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
    // Campaign's pinned champion artifacts.
    wasmSha256: "facb773f18feb041868e21022442e52754fbc5972c813577bc56586b1c653731",
    championProfileSha256: "b3d8686a4faa786746ed5b57d8bd09cdd30f88f1735b548e619b9ed63d498d6c",
    labHead: execFileSync(
      "git",
      ["-C", resolve(root, process.env.S2_LAB_ROOT ?? "../s2-bot-lab-ref"), "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim(),
  };
  const attax = remotePath(process.env.S2_PC_ATTAX || "~/attax-s2");
  const lab = remotePath(process.env.S2_PC_LAB || "~/s2-bot-lab");
  const jobs = remotePath(process.env.S2_PC_JOBS || "~/s2-jobs");
  const base64Text = (output) => output.replace(/[^A-Za-z0-9+/=]/g, "");
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const jobId = `pc-${seed}-${games}-${process.pid}-${attempt}`;
      const job = { jobId, profile, seedStart: seed, games, opponent, expect };
      const jobPath = `${jobs}/${jobId}.json`;
      const resultPath = `${jobs}/${jobId}.result.json`;
      const recordsPath = `${jobs}/${jobId}.records.jsonl`;
      const donePath = `${jobs}/${jobId}.done`;
      const logPath = `${jobs}/${jobId}.log`;
      const encoded = Buffer.from(JSON.stringify(job)).toString("base64");
      await pc(`mkdir -p ${jobs} && printf %s '${encoded}' | base64 -d > ${jobPath}`);
      const workerCommand = `PATH=$HOME/.bun/bin:$PATH S2_LAB_ROOT=${lab} bun ${attax}/tools/s2-lab/eval-worker.mjs --job ${jobPath} --result ${resultPath} --records ${recordsPath} > ${logPath} 2>&1; echo $? > ${donePath}`;
      await pc(
        `rm -f ${resultPath} ${recordsPath} ${donePath} ${logPath} && systemd-run --user --collect --unit s2eval-${jobId} sh -c ${quote(workerCommand)}`,
      );
      const deadline = Date.now() + 15 * 60 * 1000;
      for (;;) {
        if (Date.now() >= deadline) throw new Error("remote evaluation timed out after 15 minutes");
        await sleep(Math.min(5000, deadline - Date.now()));
        if (Date.now() >= deadline) throw new Error("remote evaluation timed out after 15 minutes");
        const exitCode = (await pcPayload(`cat ${donePath} 2>/dev/null`)).trim();
        if (!exitCode) continue;
        if (!/^\d+$/.test(exitCode)) throw new Error("invalid remote worker exit code");
        if (Number(exitCode) !== 0) {
          console.error(await pcPayload(`tail -20 ${logPath} 2>/dev/null`));
          throw new Error(`remote evaluation worker failed (exit ${exitCode})`);
        }
        break;
      }
      const lengthOutput = (await pcPayload(`base64 -w0 ${recordsPath} | wc -c`)).trim();
      const length = Number(lengthOutput);
      if (!/^\d+$/.test(lengthOutput) || !Number.isSafeInteger(length) || length < 1)
        throw new Error("invalid remote records base64 length");
      let recordsText = "";
      for (let offset = 0; offset < length; offset += 3000) {
        recordsText += await pcPayload(
          `base64 -w0 ${recordsPath} | tail -c +${offset + 1} | head -c 3000`,
        );
      }
      recordsText = base64Text(recordsText.replace(/\s/g, ""));
      if (recordsText.length !== length)
        throw new Error(
          `remote records base64 length mismatch: expected ${length}, got ${recordsText.length}`,
        );
      const records = Buffer.from(recordsText, "base64");
      const lines = records
        .toString("utf8")
        .split("\n")
        .filter((line) => line.trim());
      if (!lines.length) throw new Error("remote records file is empty");
      for (const line of lines) JSON.parse(line);
      await writeFile(values.out, records);
      const result = (await pcPayload(`cat ${resultPath}`)).trim();
      console.error(`PC evaluation: ${JSON.stringify(JSON.parse(result))}`);
      break;
    } catch (error) {
      if (attempt === 2) throw error;
      console.error("PC evaluation attempt 1 failed; retrying:", error);
    }
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
