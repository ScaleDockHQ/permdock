import type { SQL } from 'drizzle-orm';
import type { Permission, Principal, WhereResult } from 'permdock';
import type { MembershipsMapping } from 'permdock/drizzle';

import { PGlite } from '@electric-sql/pglite';
import { PrismaPg } from '@prisma/adapter-pg';
import { eq } from 'drizzle-orm';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { Kysely, PostgresDialect } from 'kysely';
import { readFileSync } from 'node:fs';
import { createPermDock, memoryRoleSource } from 'permdock';
import {
  checkRow as drizzleCheckRow,
  toWhere as drizzleWhere,
} from 'permdock/drizzle';
import {
  checkRow as kyselyCheckRow,
  toWhere as kyselyWhere,
} from 'permdock/kysely';
import {
  checkRow as prismaCheckRow,
  permdockExtension,
  prismaModelFields,
  toWhere as prismaWhere,
} from 'permdock/prisma';
import {
  type OrmParityCase,
  type OrmParityScenario,
  ormParity,
} from 'permdock/testing';
import {
  saasCustomRoles,
  saasMemberships as saasMembershipsOf,
  saasPermissions as p,
  saasPolicy,
  saasPrincipal,
  saasSchemaSql,
  saasSeed,
  saasSeedSql,
  saasUsers,
} from 'permdock/testing/saas';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { OrmDatabase } from './support/orm-tables.ts';
import type { Postgres } from './support/postgres.ts';

import {
  type ItemAction,
  itemActions,
  itemMemberships,
  itemPermissions,
  itemPolicy,
  itemPrincipal,
  itemRows,
  itemUsers,
} from '../fixtures/items/policy.ts';
import { itemSchemaSql, itemSeedSql } from '../fixtures/items/sql.ts';
import {
  docTable,
  itemTable,
  projectTable,
  saasMemberships,
} from './support/orm-tables.ts';
import { startPostgres } from './support/postgres.ts';
import { PrismaClient } from './support/prisma/client.ts';

type Resource = 'item' | 'project' | 'doc';

const PRISMA_SCHEMA = readFileSync(
  new URL('../prisma/schema.prisma', import.meta.url),
  'utf8',
);

type Engine = {
  readonly name: string;
  readonly exists: boolean;
  readonly run: (
    resource: Resource,
    where: WhereResult,
    memberships: MembershipsMapping | undefined,
  ) => Promise<readonly unknown[]>;
};

const SETUP = [saasSchemaSql, saasSeedSql(), itemSchemaSql, itemSeedSql()];

const drizzleTables = {
  item: itemTable,
  project: projectTable,
  doc: docTable,
} as const;

type DrizzleDb = {
  select(fields: { id: unknown }): {
    from(table: unknown): {
      where(filter: SQL): Promise<readonly { readonly id: unknown }[]>;
    };
  };
};

function drizzleRun(db: DrizzleDb): Engine['run'] {
  return async (resource, where, memberships) => {
    const table = drizzleTables[resource];
    const rows = await db
      .select({ id: table.id })
      .from(table)
      .where(
        // SAFETY: drizzleWhere compiles against a Drizzle table, so it returns a Drizzle SQL
        drizzleWhere(
          where,
          table,
          memberships === undefined ? {} : { memberships },
        ) as SQL,
      );
    return rows.map((row) => row.id);
  };
}

function principalFor(
  user: string,
  tenant: string | undefined,
): Principal | null {
  return saasPrincipal(user, tenant);
}

const saasRoleSource = memoryRoleSource(saasCustomRoles);

const saasChecks = [
  p.project.read,
  p.project.update,
  p.project.delete,
  p.doc.read,
  p.doc.update,
] as const;

/** Every user, with no tenant, each tenant they hold, and one they don't. */
function saasScenarios(): OrmParityScenario<Principal | null>[] {
  return saasUsers.flatMap((user) => {
    const tenants = [
      undefined,
      ...new Set(
        saasMembershipsOf(user).flatMap((membership) =>
          membership.tenant === undefined ? [] : [membership.tenant],
        ),
      ),
      'globex',
    ];
    return tenants.flatMap((tenant) =>
      saasChecks.map((permission) => ({
        name: `${user}@${tenant ?? '-'} ${permission.key}`,
        user: principalFor(user, tenant),
        options: {
          ...(tenant === undefined ? {} : { tenant }),
          customRoles: saasRoleSource,
        },
        // SAFETY: every saas check is an instance permission; the scenario type erases its generics
        permission: permission as Permission<string, unknown, 'instance'>,
        rows:
          permission.resource === 'project' ? saasSeed.projects : saasSeed.docs,
      })),
    );
  });
}

const itemTenants: Readonly<Record<string, readonly (string | undefined)[]>> = {
  alice: ['acme', undefined, 'globex'],
  bob: ['acme', 'globex'],
  'user-2': ['org-1'],
  mallory: [undefined, 'acme'],
};

function itemScenarios(): OrmParityScenario<Principal | null>[] {
  // SAFETY: itemActions lists every ItemAction, so the resource has one instance permission per action
  const item = itemPermissions.item as unknown as Readonly<
    Record<ItemAction, Permission<string, unknown, 'instance'>>
  >;
  return itemUsers.flatMap((user) =>
    (itemTenants[user] ?? [undefined]).flatMap((tenant) =>
      itemActions.map((action) => ({
        name: `${user}@${tenant ?? '-'} item.${action}`,
        user: itemPrincipal(user),
        options: tenant === undefined ? {} : { tenant },
        permission: item[action],
        rows: itemRows,
      })),
    ),
  );
}

function failures(results: readonly OrmParityCase[]): readonly string[] {
  return results
    .filter((result) => !result.ok)
    .map(
      (result) =>
        `${result.name}: expected [${result.expected.join(',')}] got [${result.actual.join(',')}]${result.error === undefined ? '' : ` (${result.error})`}`,
    );
}

type Checker = (
  dock: Awaited<ReturnType<typeof createPermDock>>,
  permission: Permission<string, unknown, 'instance'>,
  id: string,
) => Promise<{ readonly found: boolean; readonly granted?: boolean }>;

describe('ORM parity: filter() in memory equals toWhere(where()) in Postgres', () => {
  let db: Postgres | undefined;
  let lite: PGlite | undefined;
  let pool: Pool | undefined;
  let kysely: Kysely<OrmDatabase> | undefined;
  let prisma: { $disconnect(): Promise<void> } | undefined;
  const engines: Engine[] = [];
  const checkers: Checker[] = [];

  beforeAll(async () => {
    db = await startPostgres(SETUP);
    lite = new PGlite();
    await lite.exec(SETUP.join(';\n'));
    pool = new Pool({ connectionString: db.uri });
    const kyselyDb = new Kysely<OrmDatabase>({
      dialect: new PostgresDialect({ pool }),
    });
    kysely = kyselyDb;
    const prismaDb = new PrismaClient({
      adapter: new PrismaPg({ connectionString: db.uri }),
    }).$extends(permdockExtension());
    prisma = prismaDb;

    // SAFETY: pg and PGlite Drizzle clients share the query builder DrizzleDb declares
    const drizzleOnPg = drizzleRun(drizzlePg(db.admin) as unknown as DrizzleDb);
    const drizzleOnLite = drizzleRun(
      // SAFETY: pg and PGlite Drizzle clients share the query builder DrizzleDb declares
      drizzlePglite(lite) as unknown as DrizzleDb,
    );
    const listFieldsOf: Readonly<Record<Resource, readonly string[]>> = {
      item: ['tags'],
      project: [],
      doc: [],
    };
    const requiredFieldsOf: Readonly<Record<Resource, readonly string[]>> = {
      item: ['id', 'orgId', 'title'],
      project: ['id', 'orgId', 'ownerId', 'name', 'archived'],
      doc: ['id', 'orgId', 'title', 'locked'],
    };
    const kyselyRun: Engine['run'] = async (resource, where, memberships) => {
      const rows = await kyselyDb
        .selectFrom(resource)
        .select('id')
        .where(
          // SAFETY: kyselyWhere compiles for this db's resource table; Kysely's generic filter type is erased
          kyselyWhere(where, resource, {
            listFields: listFieldsOf[resource],
            ...(memberships === undefined ? {} : { memberships }),
          }) as never,
        )
        .execute();
      return rows.map((row) => row.id);
    };
    // SAFETY: the extended client has one delegate per Resource model with findMany
    const models = prismaDb as unknown as Readonly<
      Record<
        Resource,
        {
          findMany(args: {
            where: unknown;
            select: { id: true };
          }): Promise<readonly { readonly id: string }[]>;
        }
      >
    >;
    const prismaRun: Engine['run'] = async (resource, where) => {
      const rows = await models[resource].findMany({
        where: prismaWhere(where, {
          listFields: listFieldsOf[resource],
          requiredFields: requiredFieldsOf[resource],
        }),
        select: { id: true },
      });
      return rows.map((row) => row.id);
    };
    const prismaSchemaRun: Engine['run'] = async (resource, where) => {
      const rows = await models[resource].findMany({
        where: prismaWhere(where, {
          model: prismaModelFields(PRISMA_SCHEMA, resource),
        }),
        select: { id: true },
      });
      return rows.map((row) => row.id);
    };
    // SAFETY: each ORM's typed client and model is passed to its own row checker, erased to never
    checkers.push(
      async (dock, permission, id) =>
        drizzleCheckRow(
          drizzlePg(db?.admin as never) as never,
          itemTable,
          dock.where(permission),
          eq(itemTable.id, id),
        ),
      async (dock, permission, id) =>
        kyselyCheckRow(
          kyselyDb as never,
          'item',
          dock.where(permission),
          (eb) => eb('id', '=', id),
          { listFields: ['tags'] },
        ),
      async (dock, permission, id) =>
        prismaCheckRow(
          models.item as never,
          dock.where(permission),
          { id },
          { model: prismaModelFields(PRISMA_SCHEMA, 'item') },
        ),
    );

    engines.push(
      { name: 'drizzle (node-postgres)', exists: false, run: drizzleOnPg },
      {
        name: 'drizzle (node-postgres, exists)',
        exists: true,
        run: drizzleOnPg,
      },
      { name: 'drizzle (pglite)', exists: false, run: drizzleOnLite },
      { name: 'drizzle (pglite, exists)', exists: true, run: drizzleOnLite },
      { name: 'kysely (pg)', exists: false, run: kyselyRun },
      { name: 'kysely (pg, exists)', exists: true, run: kyselyRun },
      { name: 'prisma 7 (adapter-pg)', exists: false, run: prismaRun },
      {
        name: 'prisma 7 (schema fields)',
        exists: false,
        run: prismaSchemaRun,
      },
    );
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await kysely?.destroy();
    await lite?.close();
    await db?.stop();
  });

  const names = [
    'drizzle (node-postgres)',
    'drizzle (node-postgres, exists)',
    'drizzle (pglite)',
    'drizzle (pglite, exists)',
    'kysely (pg)',
    'kysely (pg, exists)',
    'prisma 7 (adapter-pg)',
    'prisma 7 (schema fields)',
  ];

  for (const name of names) {
    const engineNamed = (): Engine => {
      const engine = engines.find((item) => item.name === name);
      if (engine === undefined) {
        throw new Error(`PermDock: engine '${name}' was not started`);
      }
      return engine;
    };

    it(`${name}: every operator, NULL, negation, ref, memberOf and parent hop`, async () => {
      const engine = engineNamed();
      const report = await ormParity(itemPolicy, itemScenarios(), {
        run: ({ where }) =>
          engine.run(
            'item',
            where,
            engine.exists ? itemMemberships : undefined,
          ),
      });
      expect(failures(report.results)).toEqual([]);
      expect(report.results.length).toBeGreaterThan(100);
    });

    it(`${name}: the saas domain across users and tenants`, async () => {
      const engine = engineNamed();
      const report = await ormParity(saasPolicy, saasScenarios(), {
        run: ({ scenario, where }) =>
          engine.run(
            // SAFETY: every scenario's resource is one of the seeded Resource tables
            scenario.permission.resource as Resource,
            where,
            engine.exists ? saasMemberships : undefined,
          ),
      });
      expect(failures(report.results)).toEqual([]);
    });
  }

  it('checkRow in Drizzle, Kysely and Prisma answers can() for each row', async () => {
    const mismatches: string[] = [];
    const scenarios = itemScenarios().filter((scenario) =>
      ['read', 'update'].some((action) =>
        scenario.name.endsWith(`item.${action}`),
      ),
    );
    for (const scenario of scenarios) {
      const dock = await createPermDock(
        itemPolicy,
        scenario.user,
        scenario.options,
      );
      for (const row of [...itemRows, { id: 'missing' }]) {
        const id = row.id;
        const want =
          row.id === 'missing'
            ? { found: false }
            : {
                found: true,
                // SAFETY: the row comes from the scenario's seeded rows for this permission's resource
                granted: dock.can(scenario.permission, row as never),
              };
        for (const [index, check] of checkers.entries()) {
          const got = await check(dock, scenario.permission, id);
          if (JSON.stringify(got) !== JSON.stringify(want)) {
            mismatches.push(
              `${['drizzle', 'kysely', 'prisma'][index] ?? ''} ${scenario.name} ${id}: ${JSON.stringify(got)} want ${JSON.stringify(want)}`,
            );
          }
        }
      }
    }
    expect(checkers).toHaveLength(3);
    expect(mismatches).toEqual([]);
  });
});
