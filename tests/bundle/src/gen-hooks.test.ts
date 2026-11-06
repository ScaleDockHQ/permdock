import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "gen");

describe("the committed react module", () => {
  it("emits JS that never imports the policy", async () => {
    const result = await build({
      entryPoints: [join(FIXTURE, "usage.ts")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "neutral",
      metafile: true,
      logLevel: "silent",
      plugins: [
        {
          name: "bare-external",
          setup(pluginBuild): void {
            // oxlint-disable-next-line eslint/require-unicode-regexp -- esbuild runs the filter as a Go regexp, which has no u flag
            pluginBuild.onResolve({ filter: /^[^./]/ }, (args) => ({
              path: args.path,
              external: true,
            }));
          },
        },
      ],
    });
    expect(Object.keys(result.metafile.inputs).toSorted()).toStrictEqual([
      "src/fixtures/gen/permdock.react.ts",
      "src/fixtures/gen/usage.ts",
    ]);
    const text = result.outputFiles.map((file) => file.text).join("");
    expect(text).toContain('from "permdock/react"');
    expect(text).not.toContain("policy");
  });
});
