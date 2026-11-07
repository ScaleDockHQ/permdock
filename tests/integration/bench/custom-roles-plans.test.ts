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
const FIXTURES = {
  none: join(HERE, "../fixtures/row-hot-path-custom"),
  memo: join(HERE, "../fixtures/row-hot-path-custom-memo"),
} as const;
const PLANS = join(HERE, "plans");

const USER = "00000000-0000-4000-8000-0000000000aa";
const DECLARED = "00000000-0000-4000-8000-0000000000ab";
const HELD = 40;
const SHARED = 10;
const ORGS = 200;

/**
 * One user holds a tenant custom role in 60 organizations and a shared custom
 * role in 10 more. Every probe of `custom_role_permissions` and
 * `custom_role_includes` shows in the plan's buffers and loops.
 */
const SEED = `
insert into auth.users values ('${USER}'), ('${DECLARED}');
insert into public.organization_members
  select 'org-' || lpad(n::text, 3, '0'), '${DECLARED}', 'member'
  from generate_series(0, ${HELD + SHARED - 1}) n;
insert into public.organization_members
  select 'org-' || lpad(n::text, 3, '0'), '${USER}', case when n < ${HELD} then 'crew' else 'shared-crew' end
  from generate_series(0, ${HELD + SHARED - 1}) n;
insert into permdock.custom_role_permissions (tenant_id, scope, scope_id, role, permission, effect)
  select 'org-' || lpad(n::text, 3, '0'), 'tenant', null, 'crew', 'item.read', 'allow'
  from generate_series(0, ${HELD - 1}) n
  union all
  select 'org-' || lpad(n::text, 3, '0'), 'tenant', null, 'crew', 'item.edit', 'allow'
  from generate_series(0, ${HELD - 1}) n;
insert into permdock.custom_role_permissions (tenant_id, scope, scope_id, role, permission, effect)
  values (null, 'tenant', null, 'shared-crew', 'item.read', 'allow');
insert into permdock.custom_role_includes (tenant_id, scope, scope_id, role, include_role)
  select 'org-' || lpad(n::text, 3, '0'), 'tenant', null, 'crew', 'member'
  from generate_series(0, ${HELD - 1}) n;
insert into public.item
  select ('00000000-0000-4000-8003-' || lpad(n::text, 12, '0'))::uuid,
         'org-' || lpad((n % ${ORGS})::text, 3, '0'), false
  from generate_series(0, 3999) n;
analyze;
`;

const SHAPES = [
  {
    name: "tenant-ids-declared",
    user: DECLARED,
    sql: `select count(*) from permdock.permitted_tenant_ids('item.read')`,
  },
  {
    name: "tenant-ids",
    sql: `select count(*) from permdock.permitted_tenant_ids('item.read')`,
  },
  {
    name: "rows",
    sql: `select count(*) from public.item where id in (select permdock.permitted_item_rows('item.read'))`,
  },
  {
    name: "rows-conditioned",
    sql: `select count(*) from public.item where id in (select permdock.permitted_item_rows('item.edit'))`,
  },
  {
    name: "scope-ids-by-permission",
    sql: `select count(*) from permdock.permitted_tenant_ids_by_permission('item.read', true)`,
  },
] as const;

/** The shape and the counts, without timings, so a regression shows in the diff. */
function stable(plan: string): string {
  return plan
    .split("\n")
    .filter(
      (line) =>
        !/^\s*(Planning Time|Execution Time|Planning:|\s*Buffers:|Memory Usage)/u.test(
          line,
        ),
    )
    .map((line) =>
      line
        .replaceAll(/\(cost=[^)]*\)/gu, "(cost=…)")
        .replaceAll(/actual time=[0-9.]+\.\.[0-9.]+/gu, "actual time=…")
        .replaceAll(/Memory: \d+kB/gu, "Memory: …"),
    )
    .join("\n");
}

describe.each(["none", "memo"] as const)(
  "custom-role probes against Postgres with memo %s",
  (mode) => {
    let db: Postgres | undefined;

    beforeAll(async () => {
      const dir = mkdtempSync(join(tmpdir(), "permdock-custom-plans-"));
      const out = join(dir, "rls.sql");
      const generated = await rlsGenerate(["--target", "sql", "--out", out], {
        cwd: FIXTURES[mode],
      });
      if (generated.code !== 0) {
        throw new Error(`rls generate: ${generated.stdout}${generated.stderr}`);
      }
      const sql = readFileSync(out, "utf8");
      rmSync(dir, { recursive: true, force: true });
      db = await startPostgres([
        setupSql
          .replaceAll("analyze;", "")
          .replace(
            "create table public.organization_members",
            "create table public.organization_members",
          ),
        sql,
        SEED,
      ]);
    }, 300_000);

    afterAll(async () => {
      await db?.stop();
    });

    it("answers the same through the custom role as through a declared one", async () => {
      const target = defined(db);
      const count = await target.as(
        { role: "authenticated", settings: jwtClaims(USER) },
        async () =>
          (
            await target.tester.query<{ n: string }>(
              "select count(*)::text as n from permdock.permitted_tenant_ids('item.read')",
            )
          ).rows[0]?.n,
      );
      expect(count).toBe(String(HELD + SHARED));
    });

    it.each(SHAPES)("writes the $name plan", async (shape) => {
      const target = defined(db);
      const plan = await target.as(
        {
          role: "authenticated",
          settings: jwtClaims("user" in shape ? shape.user : USER),
        },
        async () => {
          const rows = (
            await target.tester.query<{ "QUERY PLAN": string }>(
              `explain (analyze, buffers) ${shape.sql}`,
            )
          ).rows;
          return rows.map((row) => row["QUERY PLAN"]).join("\n");
        },
      );
      await expect(`${stable(plan)}\n`).toMatchFileSnapshot(
        join(
          PLANS,
          `custom-roles.${shape.name}${mode === "memo" ? ".memo" : ""}.txt`,
        ),
      );
      // Buffers and times are in the commit message, not the snapshot, because they move with the cache.
      const hit = /Buffers: shared hit=(\d+)/u.exec(plan)?.[1];
      const time = /Execution Time: ([\d.]+) ms/u.exec(plan)?.[1];
      expect(hit).toBeDefined();
      process.stdout.write(
        `PLAN-NUMBERS ${mode} ${shape.name} execution_ms=${time ?? "?"} shared_hit=${hit ?? "?"}\n`,
      );
    });
  },
);
