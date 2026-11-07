import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { projectContext } from "../../src/cli/generate/context.ts";
import { runGenerate } from "../../src/cli/generate/pipeline.ts";
import { rls } from "../../src/cli/generate/plugins/rls.ts";
import { requirePolicy } from "../../src/cli/project/load.ts";

const POLICY = join(import.meta.dirname, "fixtures/mini-app/src/policy.ts");

describe("rls plugin", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the SQL the existing generator emits", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "permdock-rls-plugin-"));
    dirs.push(cwd);
    const policy = await requirePolicy(cwd, POLICY, "missing policy");
    const result = await runGenerate({
      cwd,
      policy,
      config: {
        policy: POLICY,
        rls: {
          actions: {
            archive: "none",
            publish: "none",
            accept: "none",
            disable: "none",
            pay: "none",
          },
        },
      },
      plugins: [rls({ out: "out.sql" })],
      ctx: await projectContext(cwd),
      check: false,
      dryRun: false,
    });
    expect(result.code).toBe(0);
    expect(result.files[0]?.plugin).toBe("rls");
    expect(readFileSync(join(cwd, "out.sql"), "utf8")).toContain(
      "permdock_has",
    );
  });
});
