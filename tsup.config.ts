import { defineConfig } from "tsup";

// Single-file ESM bin with a shebang so `dist/index.js` is directly executable.
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
});
