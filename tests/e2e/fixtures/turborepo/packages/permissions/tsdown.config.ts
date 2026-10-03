import { defineConfig } from "tsdown";

// The shared domain is bundled in, so `dist` holds a second copy of every
// permission leaf: consumers of `./dist` prove identity is by key.
export default defineConfig({
  entry: { index: "src/index.ts" },
  platform: "node",
  dts: false,
  clean: true,
  deps: { neverBundle: [/^permdock$/u], alwaysBundle: [/^permdock\/testing/u] },
  exports: false,
});
