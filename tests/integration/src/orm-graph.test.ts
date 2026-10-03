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
  type WorkspaceUser,
  closureSql,
  permissions,
  policy,
  relations,
  rows,
  schemaSql,
  seedSql,
  users,
} from "../fixtures/workspace/policy.ts";

const tables = {
  doc: pgTable("doc", { id: text("id"), folderId: text("folderId") }),
  folder: pgTable("folder", {
    id: text("id"),
    parentId: text("parentId"),
    teamId: text("teamId"),
    restricted: boolean("restricted"),
  }),
  team: pgTable("team", { id: text("id"), leadId: text("leadId") }),
} as const;

type Resource = keyof typeof tables;

const checks = [
  permissions.doc.read,
  permissions.doc.review,
  permissions.folder.read,
  permissions.team.read,
] as const;

function scenarios(): OrmParityScenario<WorkspaceUser>[] {
  return users.flatMap((user) =>
    checks.map((permission) => ({
      name: `${user.id} ${permission.key}`,
      user,
      options: { relations },
      // SAFETY: every check is an instance permission; the scenario type erases its generics
      permission: permission as Permission<string, unknown, "instance">,
      // SAFETY: every check's resource is one of the seeded Resource tables
      rows: rows[permission.resource as Resource],
    })),
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
  "closure table": { closure: "permdock_closure" },
  "recursive walk": {},
};

describe("ORM parity over the relation graph: match, includes, groups, links, resource roles", () => {
  let lite: PGlite | undefined;

  beforeAll(async () => {
    lite = new PGlite();
    await lite.exec(`${schemaSql}\n${seedSql}\n${closureSql}`);
  });

  afterAll(async () => {
    await lite?.close();
  });

  const database = (): PGlite => {
    if (lite === undefined) {
      throw new Error("PermDock: PGlite did not start");
    }
    return lite;
  };

  const ids = async (
    query: string,
    values: readonly unknown[],
  ): Promise<readonly unknown[]> =>
    // SAFETY: pg only reads the values array; its signature just lacks readonly
    (
      await database().query<{ id: unknown }>(query, values as unknown[])
    ).rows.map((row) => row.id);

  for (const [label, mapping] of Object.entries(mappings)) {
    it(`drizzle, ${label}`, async () => {
      const db = drizzle({ client: database() });
      const report = await ormParity(policy, scenarios(), {
        run: async ({ scenario, where }) => {
          // SAFETY: every scenario's resource is one of the seeded Resource tables
          const table = tables[scenario.permission.resource as Resource];
          // SAFETY: drizzleWhere compiles against a Drizzle table, so it returns a Drizzle SQL
          const found = await db
            .select({ id: table.id })
            .from(table)
            .where(drizzleWhere(where, table, { relations: mapping }) as SQL);
          return found.map((row) => row.id);
        },
      });
      expect(failures(report.results)).toEqual([]);
      expect(report.results.some((result) => result.expected.length > 0)).toBe(
        true,
      );
    });

    it(`kysely, ${label}`, async () => {
      const db = new Kysely<Record<Resource, { id: string }>>({
        dialect: {
          createAdapter: () => new PostgresAdapter(),
          createDriver: () => new DummyDriver(),
          createIntrospector: (inner) => new PostgresIntrospector(inner),
          createQueryCompiler: () => new PostgresQueryCompiler(),
        },
      });
      const report = await ormParity(policy, scenarios(), {
        run: async ({ scenario, where }) => {
          // SAFETY: every scenario's resource is one of the seeded Resource tables
          const resource = scenario.permission.resource as Resource;
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
          return ids(compiled.sql, compiled.parameters);
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
          // SAFETY: every scenario's resource is one of the seeded Resource tables
          const table = tables[scenario.permission.resource as Resource];
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

  it("refuses a graph grant without a relations mapping", async () => {
    const report = await ormParity(policy, scenarios().slice(0, 1), {
      run: ({ where }) => {
        drizzleWhere(where, tables.doc);
        return Promise.resolve([]);
      },
    });
    expect(report.results[0]?.error).toMatch(
      /non-portable-condition: related/u,
    );
    expect(report.ok).toBe(false);
  });
});
