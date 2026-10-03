import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";

import { pd054 } from "../../src/cli/doctor-seeds.ts";
import { run } from "../../src/cli/run.ts";
import { project, removeProjects } from "./doctor-kit.ts";

afterAll(removeProjects);

const POLICY = path.join(import.meta.dirname, "../fixtures/named-scopes.ts");
const SEEDS = "supabase/migrations/20260101000001_permdock_seeds.sql";
const config: PermDockConfig = {
  permissions: POLICY,
  policy: POLICY,
  rls: { dialect: "supabase" },
};

async function seeded(): Promise<string> {
  const cwd = project({
    "permdock.config.ts": `export default ${JSON.stringify(config)};\n`,
  });
  const result = await run(
    [
      "rls",
      "generate",
      "--split",
      "helpers,seeds",
      "--out",
      "supabase/schemas/permdock_{part}.sql",
      "--seeds-out",
      SEEDS,
    ],
    { cwd },
  );
  expect(result.code).toBe(0);
  return cwd;
}

describe("PD054 stale role_permissions seeds", () => {
  it("is quiet when the last seed matches the policy, and names missing and stale rows", async () => {
    const cwd = await seeded();
    expect(await pd054({ cwd, config })).toEqual([]);
    const file = path.join(cwd, SEEDS);
    const sql = readFileSync(file, "utf8");
    const edited = sql
      .replace(/^ {2}\('owner', 'quote\.read'.*,\n/mu, "")
      .replace(
        "values\n",
        "values\n  ('ghost', 'quote.read', 'quote.read', 'organization', 'allow'),\n",
      );
    expect(edited).not.toBe(sql);
    writeFileSync(file, edited);
    const [finding] = await pd054({ cwd, config });
    expect(finding?.code).toBe("PD054");
    expect(finding?.message).toContain(
      `${SEEDS} seeds permdock.role_permissions with rows the policy no longer compiles to: 1 missing, such as (owner quote.read quote.read#1 organization allow); 1 stale, such as (ghost quote.read quote.read organization allow)`,
    );
  });

  it("reads a later migration that clears the table as the latest seed", async () => {
    const cwd = await seeded();
    writeFileSync(
      path.join(cwd, "supabase/migrations/20260102000000_clear.sql"),
      "delete from permdock.role_permissions;\n",
    );
    const [finding] = await pd054({ cwd, config });
    expect(finding?.message).toMatch(/: \d+ missing, such as/u);
  });

  it("compiles a supabase-only config with Supabase defaults and names stale rows alone", async () => {
    const cwd = await seeded();
    const file = path.join(cwd, SEEDS);
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "values\n",
        "values\n  ('ghost', 'quote.read', 'quote.read', 'organization', 'allow'),\n",
      ),
    );
    writeFileSync(
      path.join(cwd, "supabase/migrations/20260102000000_other.sql"),
      "insert into public.notes (id) values ('n1');\ndelete from public.notes;\n",
    );
    const [finding] = await pd054({
      cwd,
      config: { permissions: POLICY, policy: POLICY, supabase: {} },
    });
    expect(finding?.message).toContain(
      "rows the policy no longer compiles to: 1 stale, such as (ghost quote.read quote.read organization allow)",
    );
    expect(finding?.message).not.toContain("missing");
  });

  it("needs a policy, an rls or supabase config, and a seed in the migrations", async () => {
    expect(await pd054({ cwd: project({}), config })).toEqual([]);
    expect(
      await pd054({ cwd: await seeded(), config: { policy: POLICY } }),
    ).toEqual([]);
    expect(
      await pd054({
        cwd: await seeded(),
        config: { ...config, policy: "src/missing-policy.ts" },
      }),
    ).toEqual([]);
  });
});
