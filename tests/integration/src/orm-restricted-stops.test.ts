import type { SQL } from "drizzle-orm";
import type { Permission, WhereResult } from "permdock";
import type { RelationsMapping } from "permdock/drizzle";

import { PGlite } from "@electric-sql/pglite";
import { boolean, pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  sql,
} from "kysely";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { toWhere as drizzleWhere } from "permdock/drizzle";
import { toWhere as kyselyWhere } from "permdock/kysely";
import { resolveRelated } from "permdock/prisma";
import {
  type OrmParityCase,
  type OrmParityScenario,
  ormParity,
} from "permdock/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type RestrictedUser,
  type TreeName,
  policy,
  relations,
  rows,
  setupSql,
  treePermissions,
  trees,
  users,
} from "../fixtures/restricted-stops/policy.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/restricted-stops");

const treeTable = (name: TreeName) =>
  pgTable(name, {
    id: text("id"),
    driveId: text("driveId"),
    parentId: text("parentId"),
    restricted: boolean("restricted"),
  });

const tables = {
  node: treeTable("node"),
  item: treeTable("item"),
  entry: treeTable("entry"),
} as const;

function scenarios(): OrmParityScenario<RestrictedUser>[] {
  return trees.flatMap((tree) =>
    (["read", "update"] as const).flatMap((action) =>
      users.map((user) => ({
        name: `${user.id} ${tree}.${action}`,
        user,
        options: { relations },
        // SAFETY: every check is an instance permission; the scenario type erases its generics
        permission: treePermissions[tree][action] as Permission<
          string,
          unknown,
          "instance"
        >,
        rows,
      })),
    ),
  );
}

function failures(results: readonly OrmParityCase[]): readonly string[] {
  return results
    .filter((result) => !result.ok)
    .map(
      (result) =>
        `${result.name}: expected [${result.expected.join(",")}] got [${result.actual.join(",")}]${result.error === undefined ? "" : ` (${result.error})`}`,
    );
}

const mappings: Readonly<Record<string, RelationsMapping>> = {
  "closure table": { closure: "permdock.permdock_closure" },
  "recursive walk": {},
};

describe("ORM parity for restricted stops: links closed below a restricted row", () => {
  let lite: PGlite | undefined;
  const dir = mkdtempSync(join(tmpdir(), "permdock-restricted-orm-"));
  const out = join(dir, "restricted.sql");

  beforeAll(async () => {
    const generated = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: FIXTURE },
    );
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}${generated.stderr}`);
    }
    lite = new PGlite();
    await lite.exec("create role tester nologin;");
    await lite.exec(setupSql);
    await lite.exec(readFileSync(out, "utf8"));
  });

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await lite?.close();
  });

  const database = (): PGlite => {
    if (lite === undefined) {
      throw new Error("PermDock: PGlite did not start");
    }
    return lite;
  };

  const tableOf = (scenario: OrmParityScenario<RestrictedUser>) =>
    // SAFETY: every scenario's resource is one of the seeded tree tables
    tables[scenario.permission.resource as TreeName];

  for (const [label, mapping] of Object.entries(mappings)) {
    it(`drizzle, ${label}`, async () => {
      const db = drizzle({ client: database() });
      const report = await ormParity(policy, scenarios(), {
        run: async ({ scenario, where }) => {
          const table = tableOf(scenario);
          // SAFETY: drizzleWhere compiles against a Drizzle table, so it returns a Drizzle SQL
          const found = await db
            .select({ id: table.id })
            .from(table)
            .where(drizzleWhere(where, table, { relations: mapping }) as SQL);
          return found.map((row) => row.id);
        },
      });
      expect(failures(report.results)).toEqual([]);
      expect(
        report.results.some(
          (result) => !result.partial && result.expected.length > 0,
        ),
      ).toBe(true);
    });

    it(`kysely, ${label}`, async () => {
      const db = new Kysely<Record<TreeName, { id: string }>>({
        dialect: {
          createAdapter: () => new PostgresAdapter(),
          createDriver: () => new DummyDriver(),
          createIntrospector: (inner) => new PostgresIntrospector(inner),
          createQueryCompiler: () => new PostgresQueryCompiler(),
        },
      });
      const report = await ormParity(policy, scenarios(), {
        run: async ({ scenario, where }) => {
          // SAFETY: every scenario's resource is one of the seeded tree tables
          const resource = scenario.permission.resource as TreeName;
          const compiled = db
            .selectFrom(resource)
            .select("id")
            .where(
              // SAFETY: kyselyWhere compiles for this db's resource table; Kysely's generic filter type is erased
              kyselyWhere(where, resource, {
                relations: mapping,
                sql,
              }) as never,
            )
            .compile();
          return (
            await database().query<{ id: unknown }>(
              compiled.sql,
              // SAFETY: pg only reads the values array; its signature just lacks readonly
              compiled.parameters as unknown[],
            )
          ).rows.map((row) => row.id);
        },
      });
      expect(failures(report.results)).toEqual([]);
    });

    it(`resolveRelated (the Prisma path), ${label}`, async () => {
      const db = drizzle({ client: database() });
      const report = await ormParity(policy, scenarios(), {
        run: async ({ scenario, where }) => {
          const resolved: WhereResult = await resolveRelated(where, {
            relations: mapping,
            run: async (query) =>
              (
                await database().query<Record<string, unknown>>(
                  query.sql,
                  // SAFETY: pg only reads the values array; its signature just lacks readonly
                  query.values as unknown[],
                )
              ).rows,
          });
          expect(JSON.stringify(resolved.condition)).not.toContain("related");
          const table = tableOf(scenario);
          // SAFETY: drizzleWhere compiles against a Drizzle table, so it returns a Drizzle SQL
          const found = await db
            .select({ id: table.id })
            .from(table)
            .where(drizzleWhere(resolved, table) as SQL);
          return found.map((row) => row.id);
        },
      });
      expect(failures(report.results)).toEqual([]);
    });
  }
});
