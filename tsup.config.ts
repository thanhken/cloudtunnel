import { defineConfig } from "tsup";

// Two ESM entries sharing chunks:
// - dist/index.js — the CLI bin (its hashbang comes from src/index.ts; esbuild
//   keeps an entry file's hashbang, so only the bin gets one)
// - dist/api.js   — the Node API (`import … from "@iamken/cloudtunnel"`), typed
export default defineConfig({
  entry: { index: "src/index.ts", api: "src/api/index.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  splitting: true,
  clean: true,
  sourcemap: true,
  dts: { entry: { api: "src/api/index.ts" } },
});
