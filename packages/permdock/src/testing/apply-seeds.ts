import type { Seeds } from "../core/seeds.ts";
import type { SqlQuery } from "../core/sql.ts";

import { quoteSqlTable } from "../core/sql.ts";

/** In-memory users, tenants, memberships, roles and rows from `seeds`. */
export function memorySources(seeds: Seeds): {
  readonly users: Seeds["fixtures"]["users"];
  readonly tenants: Seeds["fixtures"]["tenants"];
  readonly memberships: Seeds["fixtures"]["memberships"];
  readonly roles: Seeds["defaults"]["roles"];
  readonly customRoles: Seeds["fixtures"]["customRoles"];
  readonly rows: Seeds["fixtures"]["rows"];
} {
  return {
    users: seeds.fixtures.users,
    tenants: seeds.fixtures.tenants,
    memberships: seeds.fixtures.memberships,
    roles: seeds.defaults.roles,
    customRoles: seeds.fixtures.customRoles,
    rows: seeds.fixtures.rows,
  };
}

/**
 * Applies default role rows and fixture table rows through `query`. One
 * statement per insert. Run it as the table owner.
 */
export async function applySeeds(
  seeds: Seeds,
  query: SqlQuery,
  schema = "permdock",
): Promise<number> {
  let applied = 0;
  const table = quoteSqlTable(`${schema}.role_permissions`);
  for (const role of seeds.defaults.roles) {
    for (const grant of role.grants) {
      await query(
        `insert into ${table} (role, permission, grant_key, scope, effect) values ($1, $2, $3, $4, 'allow') on conflict (role, grant_key, scope) do update set permission = excluded.permission, effect = excluded.effect`,
        [role.key, grant, grant, role.scope],
      );
      applied += 1;
    }
  }
  for (const [name, rows] of Object.entries(seeds.fixtures.rows)) {
    const target = quoteSqlTable(name);
    for (const row of rows) {
      const columns = Object.keys(row);
      await query(
        `insert into ${target} (${columns.map((column) => quoteSqlTable(column)).join(", ")}) values (${columns.map((_, index) => `$${String(index + 1)}`).join(", ")})`,
        columns.map((column) => row[column]),
      );
      applied += 1;
    }
  }
  return applied;
}
