import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { champion, lab, labRoot, parameters, profile } from "./lab.mjs";

export async function createChampionDriver() {
  const wasmPath = resolve(
    process.env.CC2_F14_WASM ??
      resolve(
        labRoot,
        "bot/cold-clear-2-s2/target/wasm32-unknown-unknown/release/cold_clear_2_s2.wasm",
      ),
  );
  const wasmBytes = await readFile(wasmPath);
  const { createCc2WasmWorkerSession } = await lab("src-js/cc2-wasm-worker-session.mjs");
  const session = await createCc2WasmWorkerSession({ wasmBytes });
  let generation = 0;
  return {
    async decide(state, gui, botId) {
      generation++;
      const request = champion.createChampionRequest(state, parameters, {
        requestId: `stage2-${botId}-${generation}`,
        generation,
      });
      const response = await session.decideF14({ request, profile });
      return champion.resolveChampionDecision({ state, gui, request, response, parameters });
    },
    close: () => session.close(),
  };
}
