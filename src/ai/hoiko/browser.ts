import { makeRustHoiko, type RustHoikoFighter, type RustHoikoOptions } from "./engine.js";
import wasmUrl from "./hoiko_core.wasm?url";

const instance = (await WebAssembly.instantiate(await (await fetch(wasmUrl)).arrayBuffer(), {}))
  .instance;

export function createHoiko(options: RustHoikoOptions = {}): RustHoikoFighter {
  return makeRustHoiko(instance, options);
}

export type { RustHoikoFighter, RustHoikoOptions } from "./engine.js";
