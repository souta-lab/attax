import { makeRustDeepSeekV2, type RustDeepSeekFighter } from "./deepseek-rust-core.js";
import type { DeepSeekV2Options } from "./deepseek-v2.js";
import wasmUrl from "./wasm/deepseek_v2.wasm?url";

const instance = (await WebAssembly.instantiate(await (await fetch(wasmUrl)).arrayBuffer(), {}))
  .instance;

export function createRustDeepSeekV2(options: DeepSeekV2Options = {}): RustDeepSeekFighter {
  return makeRustDeepSeekV2(instance, options);
}

export type { RustDeepSeekFighter } from "./deepseek-rust-core.js";
