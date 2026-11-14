import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { values } = parseArgs({
  options: Object.fromEntries(["job", "result", "records"].map((key) => [key, { type: "string" }])),
});
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
function attaxSide(record) {
  return record.contestants.left === "attax"
    ? "left"
    : record.contestants.right === "attax"
      ? "right"
      : null;
}
let directory;
try {
  if (!values.job || !values.result || !values.records)
    throw new Error("--job, --result and --records are required");
  const job = JSON.parse(await readFile(values.job, "utf8"));
  directory = await mkdtemp(
    join(tmpdir(), `s2-eval-${job.jobId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${process.pid}-`),
  );
  const profilePath = join(
    directory,
    `profile-${job.jobId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${process.pid}.json`,
  );
  await writeFile(profilePath, JSON.stringify(job.profile));
  const opponentArgs = [];
  if (job.opponent?.kind === "attax-profile") {
    const opponentPath = join(directory, "opponent.json");
    await writeFile(opponentPath, JSON.stringify(job.opponent.profile));
    opponentArgs.push("--opponent-profile", opponentPath, "--opponent-id", job.opponent.id);
  } else if (job.opponent && job.opponent.kind !== "champion")
    throw new Error("unknown opponent kind");
  const recordsPath = resolve(values.records);
  await writeFile(recordsPath, "");
  const started = performance.now();
  const code = await new Promise((accept, reject) => {
    const child = spawn(
      "bun",
      [
        "tools/s2-lab/run-match.mjs",
        ...opponentArgs,
        "--games",
        String(job.games),
        "--seed",
        String(job.seedStart),
        "--out",
        recordsPath,
      ],
      {
        cwd: root,
        env: { ...process.env, ATTAX_S2_PROFILE: profilePath },
        stdio: ["ignore", 2, "inherit"],
      },
    );
    child.on("error", reject);
    child.on("close", accept);
  });
  const wallMs = performance.now() - started;
  const records = (await readFile(recordsPath, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  let verified;
  if (job.expect) {
    verified = {
      wasmSha256: records[0]?.settings?.wasmSha256,
      championProfileSha256: records[0]?.settings?.championProfileSha256,
      labHead: execFileSync(
        "git",
        ["-C", resolve(root, process.env.S2_LAB_ROOT ?? "../s2-bot-lab-ref"), "rev-parse", "HEAD"],
        { encoding: "utf8" },
      ).trim(),
    };
    for (const key of Object.keys(verified))
      if (verified[key] !== job.expect[key]) throw new Error(`campaign integrity mismatch: ${key}`);
  }
  const compat = records.filter(
    (r) =>
      r.status === "error" &&
      typeof r.error === "string" &&
      r.error.startsWith("public compat error"),
  );
  const invalid = records.filter(
    (r) => (r.status === "error" || r.protocolErrors > 0) && !compat.includes(r),
  );
  if (invalid.length || (code !== 0 && !compat.length)) {
    console.error(JSON.stringify(invalid.length ? invalid : records, null, 2));
    throw new Error(`evaluation failed (exit ${code})`);
  }
  if (records.length !== job.games)
    throw new Error(`expected ${job.games} records, got ${records.length}`);
  const finished = records.filter((r) => r.status !== "error");
  if (!finished.length) throw new Error("evaluation has no finished records");
  let wins = 0,
    losses = 0,
    draws = 0,
    attaxAPP = 0,
    champAPP = 0;
  for (const r of finished) {
    const side = attaxSide(r);
    if (!side) throw new Error("record has no attax contestant");
    const other = side === "left" ? "right" : "left";
    if (r.winner === null) draws++;
    else if (r.winner === side) wins++;
    else if (r.winner === other) losses++;
    else throw new Error("invalid winner");
    for (const seat of [side, other]) {
      if (!(r.locks[seat] > 0) || !Number.isFinite(r.attack[seat]))
        throw new Error("invalid APP inputs");
    }
    attaxAPP += r.attack[side] / r.locks[side];
    champAPP += r.attack[other] / r.locks[other];
  }
  attaxAPP /= finished.length;
  champAPP /= finished.length;
  const result = {
    ...(verified ? { verified } : {}),
    jobId: job.jobId,
    profileSha256: sha256(JSON.stringify(canonical(job.profile))),
    championProfileSha256: records[0]?.settings?.championProfileSha256 ?? null,
    wasmSha256: records[0]?.settings?.wasmSha256 ?? null,
    recordsSha256: sha256(
      JSON.stringify(
        records.map((r) => [
          r.seed,
          attaxSide(r),
          r.winner,
          r.locks,
          r.attack,
          r.finalFingerprints,
        ]),
      ),
    ),
    wins,
    losses,
    draws,
    attaxAPP,
    champAPP,
    J: (wins - losses) / finished.length + attaxAPP - champAPP,
    games: records.length,
    finished: finished.length,
    excluded: compat.length,
    wallMs,
    gamesPerHour: records.length / (wallMs / 3600000),
  };
  const line = JSON.stringify(result);
  await writeFile(values.result, `${line}\n`);
  console.log(line);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (directory) await rm(directory, { recursive: true, force: true });
}
