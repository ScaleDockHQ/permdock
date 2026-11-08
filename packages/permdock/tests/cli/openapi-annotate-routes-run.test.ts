import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { run } from "../../src/cli/core/run.ts";

const dirs: string[] = [];

describe("openapi annotate --routes through run", () => {
  afterAll(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the operations module from route comments", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "permdock-routes-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, "app/posts"), { recursive: true });
    writeFileSync(join(cwd, "permdock.config.ts"), "export default {};\n");
    writeFileSync(
      join(cwd, "app/posts/route.ts"),
      "/** @permission post.create */\nexport async function POST() {\n  return new Response();\n}\n",
    );
    const result = await run([
      "openapi",
      "annotate",
      "--routes",
      "app/**/route.ts",
      "--out",
      "ops.ts",
      "--cwd",
      cwd,
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("wrote ops.ts (1 operations)");
    expect(readFileSync(join(cwd, "ops.ts"), "utf8")).toContain("post.create");
  });
});
