import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { PermDockPlugin } from "../../src/cli/generate/plugin.ts";
import type { PermDockConfig } from "../../src/cli/types.ts";

import { projectContext } from "../../src/cli/generate/context.ts";
import { runGenerate } from "../../src/cli/generate/pipeline.ts";
import { rls } from "../../src/cli/generate/plugins/rls.ts";
import { supabaseHook } from "../../src/cli/generate/plugins/supabase-hook.ts";
import { supabase } from "../../src/cli/generate/plugins/supabase.ts";
import { requirePolicy } from "../../src/cli/project/load.ts";
import { runSupabase } from "../../src/cli/supabase-hook/supabase-hook.ts";
import { tableMembershipSource } from "../../src/supabase/index.ts";

const POLICY = join(import.meta.dirname, "../fixtures/named-scopes.ts");

const config: PermDockConfig = {
  policy: POLICY,
  rls: { actions: { accept: "none", disable: "none", pay: "none" } },
  supabase: {
    hook: {
      memberships: [
        tableMembershipSource({
          table: "memberships",
          columns: {
            via: "via",
            expiresAt: "expires_at",
            managedBy: "managed_by",
            seats: "seats",
          },
        }),
      ],
    },
  },
};

function filesOf(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && !entry.parentPath.includes("node_modules"),
      )
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path.slice(dir.length + 1), readFileSync(path, "utf8")];
      }),
  );
}

describe("supabase plugin", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function generate(
    plugins: readonly PermDockPlugin[],
  ): Promise<{ readonly code: number; readonly dir: string }> {
    const cwd = mkdtempSync(join(tmpdir(), "permdock-supabase-plugin-"));
    dirs.push(cwd);
    const policy = await requirePolicy(cwd, POLICY, "missing policy");
    const result = await runGenerate({
      cwd,
      policy,
      config,
      plugins,
      ctx: await projectContext(cwd),
      check: false,
      dryRun: false,
    });
    return { code: result.code, dir: cwd };
  }

  it("writes what rls(), supabaseHook() and supabase inspect write", async () => {
    const combined = await generate([supabase()]);
    const separate = await generate([rls(), supabaseHook()]);
    const inspected = await runSupabase({
      cwd: separate.dir,
      config,
      rest: ["inspect"],
      check: false,
      out: true,
      io: { stdout: () => undefined, stderr: () => undefined },
    });
    expect(combined.code).toBe(0);
    expect(inspected.code).toBe(0);
    expect(filesOf(combined.dir)).toStrictEqual(filesOf(separate.dir));
    expect(Object.keys(filesOf(combined.dir))).toContain(
      "permdock.manifest.json",
    );
  });

  it("skips the hook and the manifest on request", async () => {
    const { dir } = await generate([
      supabase({ hook: false, manifest: false }),
    ]);
    expect(Object.keys(filesOf(dir))).toStrictEqual(["permdock.sql"]);
  });

  it("refuses to run next to rls() or supabaseHook()", async () => {
    await expect(generate([supabase(), rls()])).rejects.toThrow(
      /already emits what 'rls' emits/u,
    );
    await expect(generate([supabaseHook(), supabase()])).rejects.toThrow(
      /already emits what 'supabase' emits/u,
    );
  });
});
