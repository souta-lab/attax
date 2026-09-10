// Durable source freezes: create / verify / materialize src snapshots.
// Usage:
//   bun scripts/freeze.ts create <name> [notes...]
//   bun scripts/freeze.ts verify <name>
//   bun scripts/freeze.ts materialize <name> <destDir>
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const SRC_DIR = join(ROOT, "src");
const FREEZE_ROOT = join(ROOT, "freeze");

interface ManifestEntry {
  readonly path: string;
  readonly sha256: string;
}

interface Manifest {
  readonly name: string;
  readonly createdAt: string;
  readonly source: string;
  readonly snapshotSha256: string;
  readonly files: readonly ManifestEntry[];
  readonly notes: string;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await listTsFiles(full)));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files.sort();
}

function snapshotPath(name: string, relPath: string): string {
  return join(FREEZE_ROOT, name, "src", `${relPath}.snap`);
}

async function readSnapshotChunks(name: string, manifest: Manifest): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for (const entry of manifest.files) {
    chunks.push(await readFile(snapshotPath(name, entry.path)));
  }
  return chunks;
}

async function create(name: string, notes: string): Promise<Manifest> {
  const files = await listTsFiles(SRC_DIR);
  const entries: ManifestEntry[] = [];
  const chunks: Uint8Array[] = [];
  for (const file of files) {
    const relPath = relative(SRC_DIR, file);
    const data = await readFile(file);
    const dest = snapshotPath(name, relPath);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, data);
    entries.push({ path: relPath, sha256: sha256(data) });
    chunks.push(data);
  }
  const manifest: Manifest = {
    name,
    createdAt: new Date().toISOString(),
    source: "src",
    snapshotSha256: sha256(Buffer.concat(chunks)),
    files: entries,
    notes,
  };
  await mkdir(join(FREEZE_ROOT, name), { recursive: true });
  await writeFile(
    join(FREEZE_ROOT, name, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

async function readManifest(name: string): Promise<Manifest> {
  const raw = await readFile(join(FREEZE_ROOT, name, "manifest.json"), "utf8");
  return JSON.parse(raw) as Manifest;
}

async function verify(name: string): Promise<{
  readonly checked: number;
  readonly missing: readonly string[];
  readonly mismatched: readonly string[];
  readonly aggregateOk: boolean;
}> {
  const manifest = await readManifest(name);
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const entry of manifest.files) {
    let data: Uint8Array;
    try {
      data = await readFile(snapshotPath(name, entry.path));
    } catch {
      missing.push(entry.path);
      continue;
    }
    if (sha256(data) !== entry.sha256) mismatched.push(entry.path);
  }
  let aggregateOk = false;
  if (missing.length === 0 && mismatched.length === 0) {
    const chunks = await readSnapshotChunks(name, manifest);
    aggregateOk = sha256(Buffer.concat(chunks)) === manifest.snapshotSha256;
  }
  return { checked: manifest.files.length, missing, mismatched, aggregateOk };
}

async function materialize(name: string, destDir: string): Promise<number> {
  const manifest = await readManifest(name);
  const root = resolve(destDir);
  const chunks = await readSnapshotChunks(name, manifest);
  for (let index = 0; index < manifest.files.length; index += 1) {
    const entry = manifest.files[index];
    const data = chunks[index];
    if (entry === undefined || data === undefined) continue;
    if (sha256(data) !== entry.sha256) {
      throw new Error(`freeze/${name}: hash mismatch for ${entry.path}; refusing to materialize`);
    }
  }
  if (sha256(Buffer.concat(chunks)) !== manifest.snapshotSha256) {
    throw new Error(`freeze/${name}: snapshot aggregate mismatch; refusing to materialize`);
  }
  for (let index = 0; index < manifest.files.length; index += 1) {
    const entry = manifest.files[index];
    const data = chunks[index];
    if (entry === undefined || data === undefined) continue;
    const out = join(root, "src", entry.path);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, data);
  }
  return manifest.files.length;
}

const [, , command, name, ...rest] = process.argv;
if (command === "create" && name !== undefined) {
  const manifest = await create(name, rest.join(" ").trim());
  console.log(
    `freeze/${name}: created ${manifest.files.length} files (snapshot ${manifest.snapshotSha256.slice(0, 12)})`,
  );
} else if (command === "verify" && name !== undefined) {
  const result = await verify(name);
  if (result.missing.length === 0 && result.mismatched.length === 0 && result.aggregateOk) {
    console.log(`freeze/${name}: OK (${result.checked} files verified)`);
  } else {
    console.error(
      `freeze/${name}: FAIL missing=${result.missing.length} mismatched=${result.mismatched.length} aggregateOk=${result.aggregateOk}`,
    );
    process.exit(1);
  }
} else if (command === "materialize" && name !== undefined && rest[0] !== undefined) {
  const count = await materialize(name, rest[0]);
  console.log(`freeze/${name}: materialized ${count} files to ${resolve(rest[0])}/src`);
} else {
  console.error("usage: bun scripts/freeze.ts <create|verify|materialize> <name> [args]");
  process.exit(2);
}
