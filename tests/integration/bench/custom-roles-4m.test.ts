import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "../src/support/postgres.ts";

import { setupSql } from "../fixtures/row-hot-path/policy.ts";
import { defined } from "../src/support/defined.ts";
import { startPostgres } from "../src/support/postgres.ts";
import { jwtClaims, rlsGenerate } from "../src/support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/row-hot-path-custom");

const USER = "00000000-0000-4000-8000-0000000000aa";
const DECLARED = "00000000-0000-4000-8000-0000000000ab";
const HELD = 40;
const TENANTS = 1000;
const ROLES = 500;
const GRANTS = 8;
/** 1,000 tenants × 500 roles × 8 grants. */
const FILLER = TENANTS * ROLES * GRANTS;

/**
 * The user holds `crew` in 40 organizations: saved through the triggers, so the
 * compiled rows are real. The filler is 4,000,000 grants of other roles in
 * 1,000 tenants, written with the user triggers off and compiled in one set
 * statement, so a probe or an edit shares the table with 4M rows.
 */
const SEED = `
insert into auth.users values ('${USER}'), ('${DECLARED}');
insert into public.organization_members
  select 'org-' || lpad(n::text, 3, '0'), '${DECLARED}', 'member'
  from generate_series(0, ${HELD - 1}) n;
insert into public.organization_members
  select 'org-' || lpad(n::text, 3, '0'), '${USER}', 'crew'
  from generate_series(0, ${HELD - 1}) n;
insert into permdock.custom_role_permissions (tenant_id, scope, scope_id, role, permission, effect)
  select 'org-' || lpad(n::text, 3, '0'), 'tenant', null, 'crew', p, 'allow'
  from generate_series(0, ${HELD - 1}) n, unnest(array['item.read', 'item.edit']) p;
insert into permdock.custom_role_includes (tenant_id, scope, scope_id, role, include_role)
  select 'org-' || lpad(n::text, 3, '0'), 'tenant', null, 'crew', 'member'
  from generate_series(0, ${HELD - 1}) n;
insert into public.item
  select ('00000000-0000-4000-8003-' || lpad(n::text, 12, '0'))::uuid,
         'org-' || lpad((n % ${TENANTS})::text, 3, '0'), false
  from generate_series(0, 3999) n;
alter table permdock.custom_role_permissions disable trigger user;
insert into permdock.custom_role_permissions (tenant_id, scope, scope_id, role, permission, effect)
  select 't' || lpad(t::text, 4, '0'), 'tenant', null, 'filler-' || r, 'perm-' || g, 'allow'
  from generate_series(1, ${TENANTS}) t, generate_series(1, ${ROLES}) r, generate_series(1, ${GRANTS}) g;
alter table permdock.custom_role_permissions enable trigger user;
insert into permdock.custom_role_compiled (tenant_id, scope, scope_id, role, grant_keys, grants, includes, version)
  select tenant_id, scope, scope_id, role, array_agg(permission), '[]'::jsonb, '{}', 1
  from permdock.custom_role_permissions
  where role like 'filler-%'
  group by tenant_id, scope, scope_id, role;
analyze;
`;

describe("custom roles beside 4,000,000 stored grants", () => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "permdock-custom-4m-"));
    const out = join(dir, "rls.sql");
    const generated = await rlsGenerate(["--target", "sql", "--out", out], {
      cwd: FIXTURE,
    });
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}${generated.stderr}`);
    }
    const sql = readFileSync(out, "utf8");
    rmSync(dir, { recursive: true, force: true });
    db = await startPostgres([setupSql.replaceAll("analyze;", ""), sql, SEED]);
  }, 900_000);

  afterAll(async () => {
    await db?.stop();
  });

  const plan = async (sql: string): Promise<string> => {
    const target = defined(db);
    return target.as(
      { role: "authenticated", settings: jwtClaims(USER) },
      async () =>
        (
          await target.tester.query<{ "QUERY PLAN": string }>(
            `explain (analyze, buffers) ${sql}`,
          )
        ).rows
          .map((row) => row["QUERY PLAN"])
          .join("\n"),
    );
  };

  it("holds the 4,000,000 grants", async () => {
    const count = await defined(db).admin.query<{ n: string }>(
      "select count(*)::text as n from permdock.custom_role_permissions",
    );
    expect(Number(count.rows[0]?.n)).toBeGreaterThanOrEqual(FILLER);
  });

  it("answers the probe from the compiled table without a sequential scan", async () => {
    const target = defined(db);
    const text = await plan(
      "select count(*) from permdock.permitted_tenant_ids('item.read')",
    );
    const time = Number(
      /Execution Time: ([\d.]+) ms/u.exec(text)?.[1] ?? "NaN",
    );
    const scans = await target.as(
      { role: "authenticated", settings: jwtClaims(USER) },
      async () => {
        await target.tester.query(
          "select count(*) from permdock.permitted_tenant_ids('item.read')",
        );
        return (
          await target.tester.query<{ table: string; scans: string }>(
            // The includes table holds a few hundred rows, so its planner choice is not asserted.
            `select t::regclass::text as table, pg_stat_get_xact_numscans(t)::text as scans
             from unnest(array['permdock.custom_role_permissions', 'permdock.custom_role_compiled']::regclass[]) t`,
          )
        ).rows;
      },
    );
    expect(scans.map((row) => [row.table, row.scans])).toStrictEqual([
      ["permdock.custom_role_permissions", "0"],
      ["permdock.custom_role_compiled", "0"],
    ]);
    process.stdout.write(`PLAN-4M probe execution_ms=${String(time)}\n`);
    expect(time).toBeLessThan(250);
    const rows = await target.as(
      { role: "authenticated", settings: jwtClaims(USER) },
      async () =>
        (
          await target.tester.query<{ n: string }>(
            "select count(*)::text as n from permdock.permitted_tenant_ids('item.read')",
          )
        ).rows[0]?.n,
    );
    expect(rows).toBe(String(HELD));
  });

  it("saves one role in time that does not depend on the table size", async () => {
    const admin = defined(db).admin;
    const started = performance.now();
    await admin.query(
      "select permdock.permdock_trusted_replace_custom_role_grants('org-001', 'tenant', null, 'crew', array['item.read'], array[]::text[], array['member'])",
    );
    const elapsed = performance.now() - started;
    process.stdout.write(`PLAN-4M save execution_ms=${elapsed.toFixed(1)}\n`);
    expect(elapsed).toBeLessThan(250);
    const compiled = await admin.query<{ n: string }>(
      "select count(*)::text as n from permdock.custom_role_compiled where tenant_id = 'org-001' and role = 'crew'",
    );
    expect(compiled.rows[0]?.n).toBe("1");
  });
});
