// Bun/Node loader for the Rust wasm Hoiko engine (scripts, tests, oracle harness).
// The browser uses src/ai/hoiko/browser.ts (Vite '?url'); this reads the wasm from disk.
import { readFileSync } from "node:fs";
import {
  makeRustHoiko,
  type RustHoikoFighter,
  type RustHoikoOptions,
} from "../src/ai/hoiko/engine.js";

const bytes = readFileSync(new URL("../src/ai/hoiko/hoiko_core.wasm", import.meta.url));
const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});

export function createHoiko(options: RustHoikoOptions = {}): RustHoikoFighter {
  return makeRustHoiko(instance, options);
}

export { makeRustHoiko };
export type { RustHoikoFighter, RustHoikoOptions } from "../src/ai/hoiko/engine.js";
