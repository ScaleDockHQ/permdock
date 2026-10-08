import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authorizationProvider } from "permdock/better-supabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SupabasePostgres } from "./support/supabase-postgres.ts";

import { startSupabasePostgres } from "./support/supabase-postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = join(HERE, "../../../apps/examples/next-better-supabase");
const MIGRATIONS = join(EXAMPLE, "supabase/migrations");

const provider = authorizationProvider({
  manifest: readFileSync(join(EXAMPLE, "permdock.manifest.json"), "utf8"),
  catalog: readFileSync(join(EXAMPLE, "permissions.catalog.json"), "utf8"),
});

const LITERALS: Readonly<Record<string, string>> = {
  permission: "'quotes.read'",
  user: "'00000000-0000-4000-8000-000000000001'::uuid",
  role: "'owner'",
  tenant: "'00000000-0000-4000-8000-000000000002'",
};

describe("authorizationProvider against the example's migrations", () => {
  let db: SupabasePostgres | undefined;

  beforeAll(async () => {
    db = await startSupabasePostgres();
    for (const file of readdirSync(MIGRATIONS).toSorted()) {
      await db.owner.query(readFileSync(join(MIGRATIONS, file), "utf8"));
    }
  }, 300_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("finds every required function, executable by its role", async () => {
    const { owner } = db!;
    const requires = provider.requires ?? [];
    expect(requires.length).toBeGreaterThan(0);
    for (const { function: fn, args, role } of requires) {
      const signature = `${fn}(${args ?? ""})`;
      const { rows } = await owner.query<{
        found: boolean;
        executable: boolean | null;
      }>(
        `select to_regprocedure($1) is not null as found,
           case when to_regprocedure($1) is not null
             then has_function_privilege($2, $1, 'execute') end as executable`,
        [signature, role],
      );
      expect({ signature, ...rows[0] }).toEqual({
        signature,
        found: true,
        executable: true,
      });
    }
  });

  it("runs every template at every scope", async () => {
    const { owner } = db!;
    for (const [name, template] of Object.entries(provider.functions)) {
      if (template === undefined) continue;
      for (const { name: scope } of provider.scopes) {
        const sql = template
          .replaceAll("{scope}", scope)
          .replaceAll(
            /\{(\w+)\}/gu,
            (_: string, key: string) => LITERALS[key] ?? "",
          );
        await expect(
          owner.query(`select ${sql}`),
          `${name} at ${scope}`,
        ).resolves.toBeDefined();
      }
    }
  });

  it("names the token hook the migrations create", async () => {
    const { rows } = await db!.owner.query<{ found: boolean }>(
      "select to_regprocedure($1) is not null as found",
      [`${provider.tokenHook!.function}(jsonb)`],
    );
    expect(rows[0]?.found).toBe(true);
  });
});
