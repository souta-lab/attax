// Bun/Node loader for the Rust wasm DeepSeek v2 engine (scripts, tests, gate).
// The browser uses src/ai/deepseek-rust.ts (Vite '?url'); this reads from disk.
import { readFileSync } from "node:fs";
import { makeRustDeepSeekV2, type RustDeepSeekFighter } from "../../src/ai/deepseek-rust-core.js";
import type { DeepSeekV2Options } from "../../src/ai/deepseek-v2.js";

const bytes = readFileSync(new URL("../../src/ai/wasm/deepseek_v2.wasm", import.meta.url));
const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});

export function createRustDeepSeekV2(options: DeepSeekV2Options = {}): RustDeepSeekFighter {
  return makeRustDeepSeekV2(instance, options);
}

export { makeRustDeepSeekV2 };
export type { RustDeepSeekFighter } from "../../src/ai/deepseek-rust-core.js";
