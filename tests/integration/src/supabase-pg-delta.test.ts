import { extract, plan, renderApplyScript } from "@supabase/pg-delta";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import {
  CENTRAKIT,
  CUSTOM_ROLES,
  ROLES,
} from "./support/declarative-fixtures.ts";
import { startPostgres } from "./support/postgres.ts";
import { generated } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

async function generateParts(
  fixture: string,
  split: string,
): Promise<{ readonly schema: string; readonly seeds: string }> {
  const [seeds = "", ...parts] = await generated(
    [
      "rls",
      "generate",
      "--target",
      "sql",
      "--split",
      `${split},seeds`,
      "--out",
      "{dir}/{part}.sql",
      "--seeds-out",
      "{dir}/seeds.sql",
    ],
    ["seeds.sql", ...split.split(",").map((part) => `${part}.sql`)],
    { cwd: join(HERE, "../fixtures", fixture) },
  );
  return { schema: parts.join("\n"), seeds };
}

const ACL = `select p.proname as name,
  has_function_privilege('anon', p.oid, 'execute') as anon,
  has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
  has_function_privilege('supabase_auth_admin', p.oid, 'execute') as "authAdmin"
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'permdock'
order by p.proname, p.oid`;

describe("supabase db schema declarative sync over rls generate (pg-delta)", () => {
  let db: Postgres | undefined;
  let databases = 0;

  beforeAll(async () => {
    db = await startPostgres([ROLES]);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  const query = async <Row extends object>(
    uri: string,
    text: string,
  ): Promise<Row[]> => {
    const client = new Client({ connectionString: uri });
    await client.connect();
    try {
      return (await client.query<Row>(text)).rows;
    } finally {
      await client.end();
    }
  };

  const database = async (statements: readonly string[]): Promise<string> => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    databases += 1;
    const name = `delta_${String(databases)}`;
    await db.admin.query(`create database ${name}`);
    const uri = new URL(db.uri);
    uri.pathname = `/${name}`;
    await query(uri.toString(), statements.join(";\n"));
    return uri.toString();
  };

  const migration = async (from: string, to: string): Promise<string> => {
    const source = new Pool({ connectionString: from });
    const desired = new Pool({ connectionString: to });
    try {
      const [current, target] = await Promise.all([
        extract(source),
        extract(desired),
      ]);
      return renderApplyScript(plan(current.factBase, target.factBase)).trim();
    } finally {
      await Promise.all([source.end(), desired.end()]);
    }
  };

  for (const [fixture, setup, split] of [
    ["rls-custom-roles", CUSTOM_ROLES, "helpers"],
    ["centrakit-roles", CENTRAKIT, "helpers,hook"],
  ] as const) {
    it(`plans the ${split} schema with its grants and nothing left over (${fixture})`, async () => {
      const { schema, seeds } = await generateParts(fixture, split);
      const migrated = await database([setup]);
      const declared = await database([setup, schema]);
      const sql = await migration(migrated, declared);
      expect(sql).toMatch(/grant execute on function [^;]*permdock_has/iu);
      expect(sql).not.toContain("service_role");

      await query(migrated, `${sql};\n${seeds}`);
      expect(await migration(migrated, declared)).toBe("");
      expect(await query(migrated, ACL)).toEqual(await query(declared, ACL));
      if (split.includes("hook")) {
        expect(
          await query<{ readonly authAdmin: boolean }>(
            migrated,
            `select has_function_privilege('supabase_auth_admin', 'permdock.custom_access_token_hook(jsonb)', 'execute') as "authAdmin"`,
          ),
        ).toEqual([{ authAdmin: true }]);
      }
    });
  }
});
