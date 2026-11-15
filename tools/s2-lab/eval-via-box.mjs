#!/usr/bin/env bun
// Box eval runner (amendment 2026-11-15, box fleet integration): the
// Simular Box analogue of eval-via-pc.mjs. Same CLI contract
// (--games/--seed/--out, ATTAX_S2_PROFILE / ATTAX_S2_OPPONENT_* env) and
// the same exit-code semantics: 0 = records written to --out;
// 75 = box-transport failure (the driver's transport policy applies);
// 1 = worker/record failure. The box runs the identical eval-worker
// under /workspace/s2eval (launched-code payload + pinned champion WASM),
// so records are byte-compatible with PC-dispatched ones.
// Target box: env S2_BOX_NAME ("bench" | "main").
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const get = (name) => args[args.indexOf(name) + 1];
const games = Number(get("--games"));
const seed = Number(get("--seed"));
const out = get("--out");
const box = process.env.S2_BOX_NAME;
if (!box || !Number.isSafeInteger(games) || !Number.isSafeInteger(seed) || !out) {
  console.error("usage: S2_BOX_NAME=<box> eval-via-box.mjs --games N --seed S --out PATH");
  process.exit(1);
}
const client = resolve(
  fileURLToPath(
    new URL("../../../custom-connectors/custom.simular-box/bin/client.py", import.meta.url),
  ),
);
const profilePath = process.env.ATTAX_S2_PROFILE;
const opponentId = process.env.ATTAX_S2_OPPONENT_ID;
const opponentProfile = process.env.ATTAX_S2_OPPONENT_PROFILE;
if (!!opponentId !== !!opponentProfile)
  throw new Error("opponent id and profile must be supplied together");
const profile = JSON.parse(await readFile(profilePath, "utf8"));
const opponent = opponentId
  ? {
      kind: "attax-profile",
      id: opponentId,
      profile: JSON.parse(await readFile(opponentProfile, "utf8")),
    }
  : { kind: "champion" };
const expect = {
  wasmSha256: "facb773f18feb041868e21022442e52754fbc5972c813577bc56586b1c653731",
  championProfileSha256: "b3d8686a4faa786746ed5b57d8bd09cdd30f88f1735b548e619b9ed63d498d6c",
  labHead: "79505ca93bd15f7bcbd58724cb2a6ba312e09434",
};

class TransportError extends Error {}
let callSeq = 0;
async function boxShell(command, timeoutS = 120) {
  const argsFile = `/tmp/boxcall-${process.pid}-${callSeq++}.json`;
  await writeFile(argsFile, JSON.stringify({ box, command, timeout_s: timeoutS }));
  const result = await new Promise((accept, reject) => {
    const child = spawn(
      "python3",
      [client, "call-tool", "--name", "shell", "--arguments-file", argsFile],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => accept({ code, stdout, stderr }));
  });
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {}
  if (!parsed) {
    throw new TransportError(
      `box client failed (exit ${result.code}): ${(result.stdout || "").slice(-200)} ${result.stderr.slice(-200)}`,
    );
  }
  // The shell tool reports a nonzero remote exit as isError with the same
  // text payload — that is data (the remote command's status), not a
  // transport failure. Only a missing/unparseable payload is transport.
  const text = parsed.content?.[0]?.text ?? "";
  const status = text.match(/\[exit status (\d+)\]\s*$/);
  return { text, exitStatus: status ? Number(status[1]) : 0 };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runBoxJob(attempt) {
  const jobId = `box-${seed}-${games}-${process.pid}-${attempt}`;
  const dir = "/workspace/s2eval/jobs";
  const jobPath = `${dir}/${jobId}.json`;
  const resultPath = `${dir}/${jobId}.result.json`;
  const recordsPath = `${dir}/${jobId}.records.jsonl`;
  const logPath = `${dir}/${jobId}.log`;
  const donePath = `${dir}/${jobId}.done`;
  const job = { jobId, profile, seedStart: seed, games, opponent, expect };
  const b64 = Buffer.from(JSON.stringify(job), "utf8").toString("base64");
  const write = await boxShell(
    `mkdir -p ${dir} && printf %s '${b64}' | base64 -d > ${jobPath} && rm -f ${resultPath} ${recordsPath} ${donePath} ${logPath}`,
  );
  if (write.exitStatus !== 0)
    throw new TransportError(`job write failed (remote exit ${write.exitStatus})`);
  const workerCommand = `PATH=$HOME/.npm-global/bin:$PATH S2_LAB_ROOT=/workspace/s2eval/lab bun /workspace/s2eval/attax/tools/s2-lab/eval-worker.mjs --job ${jobPath} --result ${resultPath} --records ${recordsPath} > ${logPath} 2>&1; echo $? > ${donePath}`;
  const start = await boxShell(
    `nohup sh -c '${workerCommand}' </dev/null >/dev/null 2>&1 & echo started`,
  );
  if (start.exitStatus !== 0 || !start.text.includes("started"))
    throw new TransportError("worker start failed");
  const deadline = Date.now() + 900_000;
  for (;;) {
    await sleep(10_000);
    const poll = await boxShell(`cat ${donePath} 2>/dev/null`);
    const codeText = poll.text.replace(/\[exit status \d+\]\s*$/, "").trim();
    if (/^\d+$/.test(codeText)) {
      const workerExit = Number(codeText);
      if (workerExit !== 0) {
        const tail = await boxShell(`tail -20 ${logPath} 2>/dev/null`);
        console.error(tail.text);
        throw new Error(`box evaluation worker failed (exit ${workerExit})`);
      }
      break;
    }
    if (Date.now() > deadline) throw new TransportError("box worker deadline (900s) exceeded");
  }
  // Chunked, length-verified records fetch (shell output is size-capped).
  const lenResult = await boxShell(`base64 -w0 ${recordsPath} | wc -c`);
  const total = Number(lenResult.text.replace(/\[exit status \d+\]\s*$/, "").trim());
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error("box records fetch: bad length");
  let encoded = "";
  const CHUNK = 24000;
  for (let offset = 0; offset < total; offset += CHUNK) {
    const part = await boxShell(
      `base64 -w0 ${recordsPath} | cut -c${offset + 1}-${Math.min(total, offset + CHUNK)}`,
    );
    encoded += part.text.replace(/\[exit status \d+\]\s*$/, "").trim();
  }
  if (encoded.length !== total)
    throw new TransportError(
      `box records base64 length mismatch: expected ${total}, got ${encoded.length}`,
    );
  const recordsText = Buffer.from(encoded, "base64").toString("utf8");
  const summary = await boxShell(`cat ${resultPath}`);
  console.log(
    `BOX evaluation (${box}): ${summary.text.replace(/\[exit status \d+\]\s*$/, "").trim()}`,
  );
  await writeFile(out, recordsText);
}

let lastTransport = null;
for (let attempt = 1; attempt <= 2; attempt++) {
  try {
    await runBoxJob(attempt);
    process.exit(0);
  } catch (error) {
    if (error instanceof TransportError) {
      lastTransport = error;
      console.error(`box transport failure (attempt ${attempt}): ${error.message}`);
      continue;
    }
    console.error(error);
    process.exit(1);
  }
}
console.error(
  `EVAL_TRANSPORT_FAILURE: box transport failed after one retry: ${lastTransport?.message}`,
);
process.exit(75);
