import { createClient, sql } from "@pgkit/client";
import { Migration } from "@pgkit/migra";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
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

async function generateSplit(
  fixture: string,
  split: string,
): Promise<{
  readonly schema: string;
  readonly seeds: string;
  readonly grants: string;
}> {
  const [grants = "", seeds = "", ...parts] = await generated(
    [
      "rls",
      "generate",
      "--target",
      "sql",
      "--schemas",
      "migra",
      "--split",
      `${split},seeds`,
      "--out",
      "{dir}/{part}.sql",
      "--seeds-out",
      "{dir}/seeds.sql",
      "--grants-out",
      "{dir}/grants.sql",
    ],
    [
      "grants.sql",
      "seeds.sql",
      ...split.split(",").map((part) => `${part}.sql`),
    ],
    { cwd: join(HERE, "../fixtures", fixture) },
  );
  return { schema: parts.join("\n"), seeds, grants };
}

describe("supabase db diff over rls generate --grants-out", () => {
  let db: Postgres | undefined;
  let databases = 0;

  beforeAll(async () => {
    db = await startPostgres([ROLES]);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  const database = async (statements: readonly string[]): Promise<string> => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    databases += 1;
    const name = `diff_${String(databases)}`;
    await db.admin.query(`create database ${name}`);
    const uri = new URL(db.uri);
    uri.pathname = `/${name}`;
    const client = new Client({ connectionString: uri.toString() });
    await client.connect();
    try {
      await client.query(statements.join(";\n"));
    } finally {
      await client.end();
    }
    return uri.toString();
  };

  const diff = async (from: string, to: string): Promise<string> => {
    const base = createClient(from);
    const head = createClient(to);
    try {
      await base.query(sql`set search_path = ''`);
      await head.query(sql`set search_path = ''`);
      const migration = await Migration.create(base, head, {
        exclude_schema: ["auth"],
        ignore_extension_versions: true,
      });
      migration.set_safety(false);
      migration.add_all_changes(true);
      return migration.sql.trim();
    } finally {
      await base.end();
      await head.end();
    }
  };

  for (const [fixture, setup, split] of [
    ["rls-custom-roles", CUSTOM_ROLES, "helpers"],
    ["centrakit-roles", CENTRAKIT, "helpers,hook"],
  ] as const) {
    it(`finds nothing to change between the migrations and the ${split} schema (${fixture})`, async () => {
      const { schema, seeds, grants } = await generateSplit(fixture, split);
      const migrated = await database([setup, schema, seeds, grants]);
      const declared = await database([setup, schema, seeds]);
      expect(await diff(migrated, declared)).toBe("");
      expect(await diff(declared, migrated)).toBe("");
    });
  }
});
