const bytes = await Bun.file(
  new URL("../src/ai/hoiko/hoiko_core.wasm", import.meta.url),
).arrayBuffer();
const { instance } = await WebAssembly.instantiate(bytes, {});
const ex = instance.exports;
const rowsPtr = ex.h_alloc(32 * 4);
const outPtr = ex.h_alloc(10 * 4);
const mem = new Int32Array(ex.memory.buffer); // create AFTER allocs (memory may grow)
mem.fill(0, rowsPtr >>> 2, (rowsPtr >>> 2) + 32);
mem[rowsPtr >>> 2] = 0x3ff;
mem[(rowsPtr >>> 2) + 1] = 0x3ff;
const garbage = ex.h_get_column_height(rowsPtr, 1, outPtr);
console.log("wasm popcount(0x3ff):", ex.h_popcount(0x3ff), "(expect 10)");
console.log("wasm log2(512):", ex.h_log2(512), "log2(1):", ex.h_log2(1), "(expect 0, 9)");
console.log(
  "wasm getColumnHeight(2 full rows): garbage=",
  garbage,
  "ch0=",
  mem[outPtr >>> 2],
  "(expect 1, 1)",
);
