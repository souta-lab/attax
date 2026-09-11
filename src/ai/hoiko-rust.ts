import wasmUrl from "./wasm/hoiko_core.wasm?url";
import { makeRustHoiko, type RustHoikoFighter, type RustHoikoOptions } from "./hoiko-rust-core.js";

const instance = (
  await WebAssembly.instantiate(await (await fetch(wasmUrl)).arrayBuffer(), {})
).instance;

export function createRustHoiko(options: RustHoikoOptions = {}): RustHoikoFighter {
  return makeRustHoiko(instance, options);
}

export type { RustHoikoFighter, RustHoikoOptions } from "./hoiko-rust-core.js";
