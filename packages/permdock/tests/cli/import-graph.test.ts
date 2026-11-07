import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const HELPER = join(ROOT, "packages/permdock/src/cli/generate/import-graph.ts");

describe("import graph", () => {
  it("records the module URL Node loads", () => {
    const script = `
      import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { join } from "node:path";
      import { pathToFileURL } from "node:url";
      import { withImportGraph } from ${JSON.stringify(pathToFileURL(HELPER).href)};
      const cwd = mkdtempSync(join(tmpdir(), "permdock-graph-"));
      const file = join(cwd, "leaf.mjs");
      writeFileSync(file, "export const n = 1;\\n");
      const recorded = await withImportGraph(() => import(pathToFileURL(file).href));
      console.log(recorded.files.length > 0 && recorded.value.n === 1 ? "ok" : "empty");
      rmSync(cwd, { recursive: true, force: true });
    `;
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--input-type=module", "-e", script],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("ok");
  });
});
