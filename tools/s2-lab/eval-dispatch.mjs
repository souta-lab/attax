#!/usr/bin/env bun
// Eval dispatch (amendment 2026-11-15, box fleet integration): the
// --eval-runner the campaign launches with. Scheduling layer only —
// seed blocks, pairing, objective, and gains are untouched; the node a
// job lands on does not affect its records (all nodes run the launched
// code + the pinned champion WASM and are C5-qualified to identical
// recordsSha256 on the standard job).
// Routing: tuning-size evals rotate PC -> bench -> main -> koenigsegg
// -> VM via a counter file (the five-node formation completed by the
// campaign-2 amendment 2026-11-15: boxes woken from hibernation,
// koenigsegg and the VM qualified under C5 at the campaign-2 tree and
// wired in); larger evals (selection 20 / validation 40) always run on
// the PC reference node. Backend exit codes pass through unchanged
// (0 ok, 75 transport, 1 worker failure), so the driver's registered
// error policies apply per node exactly as before.
// Campaign 2 (S2-CAMPAIGN2-DESIGN.md): the rotating job size and the
// counter path are env-configurable (S2_DISPATCH_ROTATE_GAMES,
// comma-separated, default "4"; S2_DISPATCH_COUNTER, default the
// campaign-1 counter). Defaults preserve campaign-1 behavior exactly.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const games = Number(args[args.indexOf("--games") + 1]);
const rotateGames = new Set(
  (process.env.S2_DISPATCH_ROTATE_GAMES || "4").split(",").map((s) => Number(s.trim())),
);
const counterPath =
  process.env.S2_DISPATCH_COUNTER || "/home/hatch/workspace/attax-s2/state/dispatch-counter";
const backends = [
  { name: "pc", runner: resolve(here, "eval-via-pc.mjs"), env: {} },
  { name: "bench", runner: resolve(here, "eval-via-box.mjs"), env: { S2_BOX_NAME: "bench" } },
  { name: "main", runner: resolve(here, "eval-via-box.mjs"), env: { S2_BOX_NAME: "main" } },
  { name: "koenigsegg", runner: resolve(here, "eval-via-koenigsegg.mjs"), env: {} },
  { name: "vm", runner: resolve(here, "eval-via-vm.mjs"), env: {} },
];

async function pickBackend() {
  if (!rotateGames.has(games)) return backends[0];
  const lock = `${counterPath}.lock`;
  for (let i = 0; i < 50; i++) {
    try {
      await mkdir(lock);
      try {
        let n = 0;
        try {
          n = Number((await readFile(counterPath, "utf8")).trim()) || 0;
        } catch {}
        await writeFile(counterPath, `${n + 1}\n`);
        return backends[n % backends.length];
      } finally {
        await import("node:fs/promises").then((fs) =>
          fs.rm(lock, { recursive: true, force: true }),
        );
      }
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return backends[0];
}

const backend = await pickBackend();
console.error(`eval-dispatch: games=${games} -> ${backend.name}`);
const code = await new Promise((accept, reject) => {
  const child = spawn(backend.runner, args, {
    env: { ...process.env, ...backend.env },
    stdio: "inherit",
  });
  child.on("error", reject);
  child.on("close", (c) => accept(c ?? 1));
});
process.exit(code);
