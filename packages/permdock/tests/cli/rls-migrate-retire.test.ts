import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { MigrateReport } from "../../src/cli/rls-migrate.ts";

import {
  legacyHelperCalls,
  retirePlan,
  retireSql,
} from "../../src/cli/rls-retire.ts";
import { run } from "../../src/cli/run.ts";
import { sqlStatements } from "../../src/cli/sql-statements.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const POLICY = join(HERE, "../fixtures/named-scopes.ts");
const SUPABASE = join(HERE, "../../src/supabase/index.ts");
const TMP = join(HERE, "../../tmp");

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const MIGRATE = {
  helpers: {
    has_org_permission: { form: "row", scope: "organization" },
  },
  prefixes: { "organization.": "" },
  tables: { user_permissions: {} },
} as const;

const LEGACY = `create table public.user_permissions (user_id uuid, organization_id uuid, permission text);

create function public.refresh_user_permissions(p_user uuid) returns void
language plpgsql as $$
begin
  delete from public.user_permissions where user_id = p_user;
  insert into public.user_permissions
    select m.user_id, m.organization_id, rp.permission
    from public.memberships m join public.role_permissions rp on rp.role = m.role
    where m.user_id = p_user;
end $$;

create function public.sync_user_permissions() returns trigger
language plpgsql as $$
begin
  perform public.refresh_user_permissions(new.user_id);
  return new;
end $$;

create trigger sync_user_permissions after insert or update or delete on public.memberships
  for each row execute function public.sync_user_permissions();

create function public.has_org_permission(p_org uuid, p_key text) returns boolean
language sql stable as $$
  select exists (select 1 from public.user_permissions up
    where up.user_id = auth.uid() and up.organization_id = p_org and up.permission = p_key)
$$;

create policy "assets_update" on public.asset for update to authenticated
  using (public.has_org_permission(asset.organization_id, 'organization.asset.update'));

create policy "quotes_select" on public.quote for select to authenticated
  using (exists (select 1 from user_permissions up where up.organization_id = quote.organization_id));

create view public.my_permissions as select * from public.user_permissions;
`;

const CLEANUP = `drop view public.my_permissions;

drop policy "quotes_select" on public.quote;
create policy "quotes_select" on public.quote for select to authenticated
  using (organization_id in (select permdock.permitted_organization_ids('quote.read')));
`;

function statements(files: Readonly<Record<string, string>>) {
  return Object.entries(files).flatMap(([file, text]) =>
    sqlStatements(text).map((statement) => Object.assign({ file }, statement)),
  );
}

describe("retirePlan", () => {
  it("finds the refresh triggers, their functions and every reader", () => {
    const plan = retirePlan(statements({ "001.sql": LEGACY }), MIGRATE);
    expect(plan.helpers).toEqual([]);
    expect(plan.tables).toEqual([
      {
        table: "public.user_permissions",
        present: true,
        kind: "table",
        refreshTriggers: [
          {
            name: "sync_user_permissions",
            table: "public.memberships",
            function: "public.sync_user_permissions",
          },
        ],
        refreshFunctions: [
          "public.refresh_user_permissions",
          "public.sync_user_permissions",
        ],
        readers: [
          {
            kind: "policy",
            name: "quotes_select on public.quote",
            file: "001.sql",
            line: 32,
          },
          {
            kind: "view",
            name: "public.my_permissions",
            file: "001.sql",
            line: 35,
          },
          {
            kind: "function",
            name: "public.has_org_permission",
            file: "001.sql",
            line: 23,
          },
        ],
      },
    ]);
    expect(retireSql(plan)).toBeUndefined();
  });

  it("drops the table once the last definitions no longer read it", () => {
    const rewritten = LEGACY.replace(
      "public.has_org_permission(asset.organization_id, 'organization.asset.update')",
      "asset.organization_id in (select permdock.permitted_organization_ids('asset.update'))",
    );
    const plan = retirePlan(
      statements({ "001.sql": rewritten, "002.sql": CLEANUP }),
      MIGRATE,
    );
    expect(plan.helpers).toEqual(["public.has_org_permission"]);
    expect(plan.tables[0]?.readers).toEqual([]);
    expect(retireSql(plan))
      .toBe(`-- permdock:retire v1 table=public.user_permissions
-- rls.migrate.tables: the refresh triggers and functions, uncalled legacy helpers, then the table; no cascade, so a dependant left behind fails the migration
drop trigger if exists "sync_user_permissions" on "public"."memberships";
drop function if exists "public"."refresh_user_permissions";
drop function if exists "public"."sync_user_permissions";
drop function if exists "public"."has_org_permission";
drop table if exists "public"."user_permissions";
`);
  });

  it("takes the configured refresh functions and a materialised view", () => {
    const plan = retirePlan(
      statements({
        "001.sql": `create materialized view public.user_permissions as select 1;
create function public.rebuild() returns trigger language plpgsql as $$ begin execute 'refresh'; return null; end $$;
create trigger rebuild after insert on public.memberships for each statement execute function public.rebuild();
`,
      }),
      { helpers: {}, tables: { user_permissions: { refresh: ["rebuild"] } } },
    );
    expect(plan.tables[0]?.kind).toBe("materialized view");
    expect(plan.tables[0]?.refreshTriggers.map((t) => t.name)).toEqual([
      "rebuild",
    ]);
    expect(retireSql(plan)).toContain(
      'drop materialized view if exists "public"."user_permissions";',
    );
  });

  it("treats a dropped table, trigger or function as gone", () => {
    const plan = retirePlan(
      statements({
        "001.sql": LEGACY,
        "002.sql": `drop trigger if exists sync_user_permissions on public.memberships;
drop function public.sync_user_permissions(), public.refresh_user_permissions(uuid);
drop table public.user_permissions;
`,
      }),
      MIGRATE,
    );
    expect(plan.tables[0]?.present).toBe(false);
    expect(plan.tables[0]?.refreshTriggers).toEqual([]);
    expect(plan.tables[0]?.refreshFunctions).toEqual([]);
    expect(retireSql(plan)).toBeUndefined();
  });

  it("counts legacy helper calls outside their own definition", () => {
    const found = legacyHelperCalls(
      statements({ "001.sql": LEGACY }),
      "has_org_permission",
    );
    expect(found).toEqual({ count: 1, files: ["001.sql"] });
  });
});

function project(files: Readonly<Record<string, string>>): string {
  mkdirSync(TMP, { recursive: true });
  const cwd = mkdtempSync(join(TMP, "retire-"));
  temps.push(cwd);
  writeFileSync(
    join(cwd, "permdock.config.ts"),
    `import { fromTable } from ${JSON.stringify(SUPABASE)};
export default {
  permissions: ${JSON.stringify(POLICY)},
  policy: ${JSON.stringify(POLICY)},
  rls: {
    dialect: 'supabase',
    membershipSources: [fromTable({ table: 'memberships' })],
    migrate: ${JSON.stringify(MIGRATE)},
  },
};
`,
  );
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true });
    writeFileSync(join(cwd, rel), text);
  }
  return cwd;
}

const ARGS = ["rls", "migrate", "--rbac", "supabase", "--sql", "supabase"];

describe("rls migrate --retire-out", () => {
  it("writes nothing and exits 1 while the table is read", async () => {
    const cwd = project({
      "supabase/migrations/20261001000000_legacy.sql": LEGACY,
    });
    const result = await run(
      [...ARGS, "--retire-out", "supabase/migrations/"],
      { cwd },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      "retire public.user_permissions: 1 refresh trigger(s), 2 refresh function(s), 3 reader(s)",
    );
    expect(result.stdout).toContain(
      "rls migrate --retire-out: public.user_permissions still read; nothing written",
    );
    expect(readdirSync(join(cwd, "supabase/migrations"))).toHaveLength(1);
  });

  it("writes one versioned retire migration after --write and the cleanup", async () => {
    const cwd = project({
      "supabase/migrations/20261001000000_legacy.sql": LEGACY,
      "supabase/migrations/20261001000001_cleanup.sql": CLEANUP,
    });
    expect((await run([...ARGS, "--write"], { cwd })).code).toBe(0);
    const json = await run([...ARGS, "--json"], { cwd });
    // SAFETY: --json prints runRlsMigrate's MigrateReport.
    const report = JSON.parse(json.stdout) as MigrateReport;
    expect(report.retire?.tables[0]?.readers).toEqual([]);

    const out = [...ARGS, "--retire-out", "supabase/migrations/"];
    const first = await run(out, { cwd });
    expect(first.code).toBe(0);
    expect(first.stdout).toContain(
      "wrote supabase/migrations/20261001000002_permdock_retire.sql",
    );
    const retire = readFileSync(
      join(cwd, "supabase/migrations/20261001000002_permdock_retire.sql"),
      "utf8",
    );
    expect(retire).toContain(
      'drop table if exists "public"."user_permissions";',
    );

    const again = await run(out, { cwd });
    expect(again.code).toBe(0);
    expect(again.stdout).toContain(
      "rls migrate --retire-out: nothing to retire",
    );
  });

  it("needs rls.migrate.tables", async () => {
    const cwd = project({});
    writeFileSync(
      join(cwd, "permdock.config.ts"),
      readFileSync(join(cwd, "permdock.config.ts"), "utf8").replace(
        ',"tables":{"user_permissions":{}}',
        "",
      ),
    );
    mkdirSync(join(cwd, "supabase"));
    const result = await run([...ARGS, "--retire-out", "-"], { cwd });
    expect(result.code).toBe(2);
    expect(result.stderr + result.stdout).toContain(
      "rls migrate --retire-out needs rls.migrate.tables",
    );
  });
});
