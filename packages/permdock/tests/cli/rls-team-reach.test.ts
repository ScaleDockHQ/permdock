import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "../../src/cli/run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "./fixtures/mini-app");
const TMP = join(HERE, "../../tmp");

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function generate(authorize: "database" | "jwt"): Promise<string> {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, "rls-team-reach-"));
  temps.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  writeFileSync(
    join(dir, "src/team-reach.ts"),
    `import { allow, definePermissions, definePolicy, principal, resource, role } from 'permdock';

export const permissions = definePermissions({
  job: resource({
    id: 'id',
    actions: ['read'],
    relations: {
      org: { field: 'orgId', memberOf: 'tenant' },
      team: { field: 'teamId', memberOf: 'team' },
    },
  }),
});

export const policy = definePolicy(permissions, {
  roles: [
    role('manager', [allow(permissions.job.read, { where: { teamId: { in: principal.claims.team_ids } } })], { on: 'tenant' }),
  ],
  scopes: { tenant: { key: 'orgId' }, team: { key: 'teamId', within: 'tenant' } },
  subject: () => null,
});
`,
  );
  writeFileSync(
    join(dir, "permdock.config.ts"),
    `export default {
  permissions: './src/team-reach.ts',
  policy: './src/team-reach.ts',
  rls: {
    dialect: 'supabase',
    tenantType: 'text',
    authorize: '${authorize}',
    ${
      authorize === "database"
        ? "memberships: { tenant: { table: 'organization_members', tenant: 'organization_id', user: 'user_id', role: 'role' } },"
        : ""
    }
  },
};
`,
  );
  const result = await run(
    ["rls", "generate", "--target", "sql", "--out", "rls.sql"],
    { cwd: dir },
  );
  if (result.code !== 0) {
    throw new Error(result.stdout);
  }
  return readFileSync(join(dir, "rls.sql"), "utf8");
}

describe("rls generate for an organisation role with team reach", () => {
  it.each(["database", "jwt"] as const)(
    "%s: compiles the team list to one array comparison, not a per-row helper",
    async (authorize) => {
      const sql = await generate(authorize);
      expect(sql).toContain(
        `("teamId" = any (array(select (e #>> '{}') from jsonb_array_elements(case when jsonb_typeof(((select auth.jwt()) -> 'team_ids')) = 'array'`,
      );
      expect(sql).toContain(
        `"orgId" in (select "permdock".permitted_tenant_ids('job.read'))`,
      );
    },
  );
});
