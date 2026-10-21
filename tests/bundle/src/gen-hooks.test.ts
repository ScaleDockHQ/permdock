import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "gen");
const BIN = join(
  HERE,
  "..",
  "node_modules",
  "permdock",
  "dist",
  "cli",
  "bin.js",
);

describe("permdock gen --kind react", () => {
  it("matches the committed fixture the typecheck covers", () => {
    const result = spawnSync(
      process.execPath,
      [
        BIN,
        "gen",
        "--cwd",
        FIXTURE,
        "--policy",
        "./policy.ts",
        "--kind",
        "react",
        "--out",
        "permdock.react.ts",
        "--check",
      ],
      { encoding: "utf8" },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

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
