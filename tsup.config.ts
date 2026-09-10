import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  outDir: "dist",
  target: "node18",
  platform: "node",
  sourcemap: true,
  clean: true,
  dts: false,
  treeshake: true,
  external: ["@ai-hero/sandcastle"],
});
