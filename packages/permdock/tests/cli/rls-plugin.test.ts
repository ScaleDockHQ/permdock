import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { projectContext } from "../../src/cli/generate/context.ts";
import { runGenerate } from "../../src/cli/generate/pipeline.ts";
import { rls } from "../../src/cli/generate/plugins/rls.ts";
import { supabaseHook } from "../../src/cli/generate/plugins/supabase-hook.ts";
import { supabase } from "../../src/cli/generate/plugins/supabase.ts";
import { withPluginOutputs } from "../../src/cli/project/config.ts";
import { requirePolicy } from "../../src/cli/project/load.ts";
import { hookOut } from "../../src/cli/supabase-hook/supabase-hook.ts";

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

describe("plugin outputs in the config", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("folds the rls() and supabaseHook() out and split into the config doctor reads", () => {
    const cwd = mkdtempSync(join(tmpdir(), "permdock-rls-plugin-"));
    dirs.push(cwd);
    const config = withPluginOutputs({
      rls: { schema: "permdock" },
      plugins: [
        rls({
          out: "supabase/migrations/1_permdock_{part}.sql",
          split: ["helpers", "policies"],
        }),
        supabaseHook({ out: "supabase/schemas/hook.sql" }),
      ],
    });
    expect(config.rls).toStrictEqual({
      schema: "permdock",
      out: "supabase/migrations/1_permdock_{part}.sql",
      split: ["helpers", "policies"],
    });
    expect(hookOut(cwd, config)).toBe("supabase/schemas/hook.sql");
    expect(withPluginOutputs({ plugins: [rls()] }).rls?.out).toBe(
      "permdock.sql",
    );
    expect(
      withPluginOutputs({
        plugins: [supabase({ out: "a.sql", hook: { out: "h.sql" } })],
      }),
    ).toMatchObject({
      rls: { out: "a.sql" },
      supabase: { hook: { out: "h.sql" } },
    });
  });

  it("splits by rls.split in the config when the plugin sets seeds.out", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "permdock-rls-plugin-"));
    dirs.push(cwd);
    const policy = await requirePolicy(cwd, POLICY, "missing policy");
    const result = await runGenerate({
      cwd,
      policy,
      config: {
        policy: POLICY,
        rls: {
          out: "sql/permdock_{part}.sql",
          split: ["helpers", "seeds", "policies"],
          actions: {
            archive: "none",
            publish: "none",
            accept: "none",
            disable: "none",
            pay: "none",
          },
        },
      },
      plugins: [rls({ seeds: { out: "sql/seeds.sql" } })],
      ctx: await projectContext(cwd),
      check: false,
      dryRun: false,
    });
    expect(result.code).toBe(0);
    expect(
      readFileSync(join(cwd, "sql/permdock_helpers.sql"), "utf8"),
    ).toContain("permdock_has");
  });
});
