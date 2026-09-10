import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  sourcemap: true,
  clean: true,
  dts: true,
  external: ["@ai-hero/sandcastle"],
  // keep the published file contract: dist/index.js + dist/index.d.ts
  outExtensions: () => ({ js: ".js", dts: ".d.ts" }),
});
