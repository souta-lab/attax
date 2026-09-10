// Parallel shard runner for gate scripts.
// Usage: bun scripts/shards.ts <gateScript> [shardCount]
// Env:
//   SHARD_INDEX_VAR  env var name for the shard index (default GATE_SHARD_INDEX)
//   SHARD_COUNT_VAR  env var name for the shard count (default GATE_SHARD_COUNT)
//   SHARD_LOG_DIR    directory for per-shard logs (default /tmp)
//
// Runs <shardCount> copies of the gate script concurrently, one per seed shard,
// tees each copy's output to its own log, then prints the merged JSONL so a
// single command yields the full corpus result. Example (fast iteration):
//   SHARD_INDEX_VAR=GATE_SHARD_INDEX GATE_SEEDS=1,7,42,99,777,1234 bun scripts/shards.ts scripts/gate.ts 6
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

const script = process.argv[2];
const shardCount = Number(process.argv[3] ?? 6);
if (script === undefined || !Number.isInteger(shardCount) || shardCount < 1) {
  console.error("usage: bun scripts/shards.ts <gateScript> [shardCount]");
  process.exit(2);
}
const indexVar = process.env.SHARD_INDEX_VAR ?? "GATE_SHARD_INDEX";
const countVar = process.env.SHARD_COUNT_VAR ?? "GATE_SHARD_COUNT";
const logDir = process.env.SHARD_LOG_DIR ?? "/tmp";
const tag = basename(script).replace(/\.ts$/, "");

interface ShardResult {
  readonly index: number;
  readonly code: number;
  readonly output: string;
}

function runShard(index: number): Promise<ShardResult> {
  return new Promise((resolve) => {
    const child = spawn("bun", [script], {
      env: { ...process.env, [indexVar]: String(index), [countVar]: String(shardCount) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("close", (code) => resolve({ index, code: code ?? 1, output }));
  });
}

const results = await Promise.all(
  Array.from({ length: shardCount }, (_, index) => runShard(index)),
);
let failed = 0;
for (const result of results) {
  await writeFile(join(logDir, `shards-${tag}-${result.index}.log`), result.output);
  if (result.code !== 0) failed += 1;
}
for (const result of results) process.stdout.write(result.output);
console.error(`shards: ${shardCount} run, ${failed} failed; logs in ${logDir}`);
process.exit(failed === 0 ? 0 : 1);
