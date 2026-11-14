#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
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
async function pc(command, capture = false) {
  return new Promise((accept, reject) => {
    const child = spawn("/home/hatch/bin/pc", [command], {
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    });
    const chunks = [];
    if (capture) child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`pc command failed (exit ${code})`));
      else accept(Buffer.concat(chunks).toString("utf8"));
    });
  });
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
  const attax = remotePath(process.env.S2_PC_ATTAX || "~/attax-s2");
  const lab = remotePath(process.env.S2_PC_LAB || "~/s2-bot-lab");
  const jobs = remotePath(process.env.S2_PC_JOBS || "~/s2-jobs");
  const base64Text = (output) => output.replace(/[^A-Za-z0-9+/=]/g, "");
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const jobId = `pc-${seed}-${games}-${process.pid}-${attempt}`;
      const job = { jobId, profile, seedStart: seed, games };
      const jobPath = `${jobs}/${jobId}.json`;
      const resultPath = `${jobs}/${jobId}.result.json`;
      const recordsPath = `${jobs}/${jobId}.records.jsonl`;
      const encoded = Buffer.from(JSON.stringify(job)).toString("base64");
      await pc(`mkdir -p ${jobs} && printf %s '${encoded}' | base64 -d > ${jobPath}`);
      await pc(
        `cd ${attax} && PATH=$HOME/.bun/bin:$PATH S2_LAB_ROOT=${lab} bun tools/s2-lab/eval-worker.mjs --job ${jobPath} --result ${resultPath} --records ${recordsPath}`,
      );
      const lengthOutput = (await pc(`base64 -w0 ${recordsPath} | wc -c`, true)).trim();
      const length = Number(lengthOutput);
      if (!/^\d+$/.test(lengthOutput) || !Number.isSafeInteger(length) || length < 1)
        throw new Error("invalid remote records base64 length");
      let recordsText = "";
      for (let offset = 0; offset < length; offset += 3000) {
        recordsText += base64Text(
          await pc(`base64 -w0 ${recordsPath} | tail -c +${offset + 1} | head -c 3000`, true),
        );
      }
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
      const result = Buffer.from(
        base64Text(await pc(`base64 -w0 ${resultPath}`, true)),
        "base64",
      ).toString("utf8");
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
