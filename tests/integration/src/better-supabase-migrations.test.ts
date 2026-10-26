import { extract, plan, renderApplyScript } from "@supabase/pg-delta";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { readdirSync, readFileSync } from "node:fs";
import { Client, Pool } from "pg";
import { describe, expect, it } from "vitest";

const example = new URL(
  "../../../apps/examples/next-better-supabase/",
  import.meta.url,
);

describe("better-supabase example forward migrations", () => {
  it("replays the 0.25 forward migration with the claim hook and removal trigger", async () => {
    const database = await new PostgreSqlContainer(
      "postgres:17-alpine",
    ).start();
    const client = new Client({
      connectionString: database.getConnectionUri(),
    });
    await client.connect();
    try {
      await client.query(
        readFileSync(new URL("scripts/auth-stub.sql", example), "utf8"),
      );
      const migrations = new URL("supabase/migrations/", example);
      for (const file of readdirSync(migrations)
        .filter((name) => name.endsWith(".sql"))
        .toSorted()) {
        await client.query(readFileSync(new URL(file, migrations), "utf8"));
      }
      await client.query(
        readFileSync(new URL("supabase/seed.sql", example), "utf8"),
      );
      const pool = new Pool({ connectionString: database.getConnectionUri() });
      try {
        const replayed = await extract(pool);
        for (const file of [
          "900_better_supabase_003_audit.sql",
          "900_better_supabase_004_memberships.sql",
          "permdock/functions/custom_access_token_hook.sql",
        ]) {
          const source = readFileSync(
            new URL(
              `../../../apps/examples/next-better-supabase/supabase/schemas/${file}`,
              import.meta.url,
            ),
            "utf8",
          );
          // Existing policies must be replaced when replaying declarative files over migrations.
          const sql = source.replaceAll(
            /create policy ("[^"]+") on ([^\n]+)\n/giu,
            "drop policy if exists $1 on $2;\ncreate policy $1 on $2\n",
          );
          await client.query(sql);
        }
        const declared = await extract(pool);
        expect(
          renderApplyScript(plan(replayed.factBase, declared.factBase)).trim(),
        ).toBe("");
      } finally {
        await pool.end();
      }
      const functions = await client.query<{ hook: string; tenant: string }>(`
      select pg_get_functiondef('permdock.custom_access_token_hook(jsonb)'::regprocedure) as hook,
        pg_get_functiondef('better_supabase.current_tenant_id()'::regprocedure) as tenant
    `);
      expect(functions.rows[0]?.hook).toContain(
        "claims -> 'app_metadata' ->> 'tenant_id'",
      );
      expect(functions.rows[0]?.tenant).not.toContain("x-bsb-tenant");
      const member = await client.query<{
        user_id: string;
        organization_id: string;
      }>(
        "select user_id, organization_id from public.organization_memberships where role = 'member' limit 1",
      );
      const row = member.rows[0];
      expect(row).toBeDefined();
      if (row === undefined) throw new Error("seed membership missing");
      await client.query(
        "update auth.users set raw_app_meta_data = jsonb_build_object('tenant_id', $2::text, 'retained', true) where id = $1",
        [row.user_id, row.organization_id],
      );
      await client.query(
        "delete from public.organization_memberships where user_id = $1 and organization_id = $2",
        [row.user_id, row.organization_id],
      );
      const user = await client.query<{ raw_app_meta_data: unknown }>(
        "select raw_app_meta_data from auth.users where id = $1",
        [row.user_id],
      );
      expect(user.rows[0]?.raw_app_meta_data).toStrictEqual({ retained: true });
    } finally {
      await client.end();
      await database.stop();
    }
  }, 60_000);
});
