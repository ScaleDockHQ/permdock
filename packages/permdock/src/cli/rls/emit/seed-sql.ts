import type { Seeds } from "../../../core/seeds.ts";

import { quoteSqlLiteral, quoteSqlTable } from "../../../core/sql.ts";

export const DEFAULTS_MARKER = "-- permdock:defaults v1";
export const FIXTURES_MARKER = "-- permdock:fixtures v1";
export const FIXTURES_PATH = "supabase/seeds/permdock.sql";

const SEED_LINE = "[db.seed]\nsql_paths = ['./seeds/permdock.sql']";

/** The line to add under `supabase/config.toml`. The CLI never writes that file. */
export function seedPathsLine(): string {
  return SEED_LINE;
}

function hasFixtures(seeds: Seeds): boolean {
  return (
    Object.keys(seeds.fixtures.users).length > 0 ||
    Object.keys(seeds.fixtures.tenants).length > 0 ||
    seeds.fixtures.memberships.length > 0 ||
    seeds.fixtures.customRoles.length > 0 ||
    Object.keys(seeds.fixtures.rows).length > 0
  );
}

export function fixturesPresent(seeds: Seeds): boolean {
  return hasFixtures(seeds);
}

/**
 * Idempotent `role_permissions` rows for `defaults`. Grants are permission
 * keys. Other rows in the table are left in place.
 */
export function defaultsSeedSql(seeds: Seeds, schema: string): string {
  const table = quoteSqlTable(`${schema}.role_permissions`);
  const values = seeds.defaults.roles.flatMap((role) =>
    role.grants.map(
      (grant) =>
        `  (${[role.key, grant, grant, role.scope, "allow"].map(quoteSqlLiteral).join(", ")})`,
    ),
  );
  if (values.length === 0) {
    return `${DEFAULTS_MARKER}\n-- no default roles\n`;
  }
  return `${DEFAULTS_MARKER}
-- a seed run never holds a long lock on ${schema}.role_permissions
select set_config('lock_timeout', '5s', true), set_config('statement_timeout', '30s', true);
insert into ${table} (role, permission, grant_key, scope, effect) values
${values.join(",\n")}
on conflict (role, grant_key, scope) do update
  set permission = excluded.permission, effect = excluded.effect;
`;
}

/** Dev and test rows. This file is not a migration and not a schema file. */
export function fixturesSeedSql(seeds: Seeds): string {
  const lines = [
    FIXTURES_MARKER,
    "-- Dev and test data. Do not copy this file into a migration or a schema file.",
  ];
  for (const [name, user] of Object.entries(seeds.fixtures.users)) {
    const email = user.email === undefined ? "" : ` ${user.email}`;
    lines.push(`-- user ${name} ${user.id}${email}`);
  }
  for (const [name, tenant] of Object.entries(seeds.fixtures.tenants)) {
    lines.push(`-- tenant ${name} ${tenant.id}`);
  }
  for (const membership of seeds.fixtures.memberships) {
    lines.push(
      `-- membership ${membership.user} ${membership.tenant} ${membership.roles.join(",")}`,
    );
  }
  for (const [table, rows] of Object.entries(seeds.fixtures.rows)) {
    const quoted = quoteSqlTable(table);
    for (const row of rows) {
      const columns = Object.keys(row);
      const names = columns.map((column) => quoteSqlTable(column)).join(", ");
      const literals = columns
        .map((column) => quoteSqlLiteral(row[column] ?? ""))
        .join(", ");
      lines.push(`insert into ${quoted} (${names}) values (${literals});`);
    }
  }
  return `${lines.join("\n")}\n`;
}
