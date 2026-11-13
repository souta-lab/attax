import { defineConfig } from "vite";

export default defineConfig({
  // Relative asset URLs: the built site works from any subpath (e.g. /tetris/).
  base: "./",
  server: { port: 5173 },
  worker: { format: "es" },
  build: {
    target: "es2022",
    // Keep the wasm a separate file (it is fetched by URL), never inlined.
    assetsInlineLimit: 0,
  },
});
