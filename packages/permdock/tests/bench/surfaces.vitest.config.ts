import { defineConfig } from "vitest/config";

declare module "vitest" {
  interface ProvidedContext {
    readonly surfacesOut: string | undefined;
    readonly surfacesLabel: string;
    readonly surfacesOnly: readonly string[] | undefined;
    readonly surfacesPgUrl: string | undefined;
  }
}

/**
 * `SURFACES_OUT=<file> [SURFACES_LABEL=<label>] [SURFACES_ONLY=mcp,orm]
 * [SURFACES_PG_URL=<url>] vitest run --config
 * tests/bench/surfaces.vitest.config.ts`.
 */
export default defineConfig({
  test: {
    name: "surfaces",
    include: ["tests/bench/*.run.ts"],
    reporters: ["dot"],
    provide: {
      surfacesOut: process.env["SURFACES_OUT"],
      surfacesLabel: process.env["SURFACES_LABEL"] ?? "after",
      surfacesOnly: process.env["SURFACES_ONLY"]?.split(","),
      surfacesPgUrl: process.env["SURFACES_PG_URL"],
    },
  },
});
