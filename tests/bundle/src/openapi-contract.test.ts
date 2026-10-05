import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(
  new URL("../../../packages/permdock/src/", import.meta.url),
);

describe("permdock/openapi contract helpers", () => {
  it("reach no module outside their own two files", async () => {
    const result = await build({
      stdin: {
        contents: `export { permissionsExtension, problemDetails, securityFor } from './openapi/index.ts';`,
        resolveDir: SRC,
        loader: "ts",
      },
      bundle: true,
      write: false,
      treeShaking: true,
      format: "esm",
      platform: "neutral",
      metafile: true,
      logLevel: "silent",
      plugins: [
        {
          name: "relative-only",
          setup(pluginBuild): void {
            pluginBuild.onResolve({ filter: /^[^./]/ }, (args) => ({
              path: args.path,
              external: true,
            }));
          },
        },
      ],
    });
    const contributing = Object.values(result.metafile.outputs).flatMap(
      (output) =>
        Object.entries(output.inputs)
          .filter(([, input]) => input.bytesInOutput > 0)
          .map(([path]) => path.replace(/^.*packages\/permdock\/src\//u, "")),
    );
    expect(contributing.toSorted()).toEqual([
      "openapi/problem-details.ts",
      "openapi/security.ts",
    ]);
    expect(result.outputFiles.map((file) => file.text).join("")).not.toMatch(
      /\bimport\b/u,
    );
  });
});
