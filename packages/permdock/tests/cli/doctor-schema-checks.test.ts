import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { DoctorFiles } from "../../src/cli/shared/doctor-types.ts";
import type { PermDockConfig } from "../../src/cli/types.ts";
import type { Policy } from "../../src/core/policy-types.ts";

import { pd095, pd096, pd101 } from "../../src/cli/doctor/schema-checks.ts";
import { pd097 } from "../../src/cli/doctor/seed-data.ts";
import { nodeFiles } from "../../src/cli/shared/doctor-files.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";
import { tableMembershipSource } from "../../src/supabase/index.ts";

const dirs: string[] = [];

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), "permdock-pd095-"));
  dirs.push(cwd);
  return cwd;
}

function targetOf(finding: { readonly target?: string }): string {
  return finding.target ?? "";
}

function put(cwd: string, rel: string, text: string): void {
  const path = join(cwd, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

describe("PD095", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flags PermDock schema shapes and a versioned migration that repeats them", async () => {
    const cwd = project();
    put(
      cwd,
      "supabase/schemas/900_other.sql",
      "do $$\nbegin\n  create table public.other (id int);\nend $$;\n",
    );
    put(
      cwd,
      "supabase/schemas/permdock/helpers.sql",
      `create table public.notes (id int);
do $$
begin
  create table public.notes_copy (id int);
end $$;
grant select on all tables in schema public to authenticated;
create function "permdock".same(p int) returns int language sql as $$ select p $$;
create or replace function "permdock".same(p int) returns int language sql as $$ select p $$;
create view public.notes_v as select 1 as id;
create trigger notes_v instead of insert on public.notes_v for each row execute function "permdock".same(1);
`,
    );
    put(
      cwd,
      "supabase/migrations/20260101000000_history.sql",
      "create table public.notes (id int);\n",
    );
    put(
      cwd,
      "supabase/migrations/20260102000000_permdock_seeds.sql",
      `-- permdock:seeds v1
create table public.notes (id int);
grant select on table public.notes to authenticated;
`,
    );
    const findings = await pd095(cwd, nodeFiles);
    const helpers = findings.find((finding) =>
      targetOf(finding).endsWith("helpers.sql"),
    );
    expect(helpers?.message).toContain("a do block whose body contains create");
    expect(helpers?.message).toContain("grant on all");
    expect(helpers?.message).toContain("two definitions of one signature");
    expect(helpers?.message).toContain("a trigger on a view");
    expect(
      findings.some((finding) => targetOf(finding).endsWith("900_other.sql")),
    ).toBe(false);
    expect(
      findings.some((finding) => targetOf(finding).endsWith("history.sql")),
    ).toBe(false);
    const repeated = findings.find((finding) =>
      targetOf(finding).endsWith("permdock_seeds.sql"),
    );
    expect(repeated?.message).toContain("public.notes");
    expect(repeated?.message).toContain("notes");
  });

  it("flags if not exists on create table, index and policy, and a drop-then-create trigger", async () => {
    const cwd = project();
    put(
      cwd,
      "supabase/schemas/permdock/helpers.sql",
      `create table if not exists public.notes (id int);
create unique index if not exists notes_id on public.notes (id);
create index if not exists notes_id2 on public.notes (id);
create policy if not exists p on public.notes for select using (true);
drop trigger if exists notes_t on public.notes;
create trigger notes_t after insert on public.notes execute function permdock.kept();
`,
    );
    const message = (await pd095(cwd, nodeFiles))[0]?.message ?? "";
    expect(message).toContain("create table if not exists");
    expect(message).toContain("create index if not exists");
    expect(message).toContain("create policy if not exists");
    expect(message).toContain("drop trigger before create trigger");
  });

  it("allows create or replace trigger and a schema if not exists", async () => {
    const cwd = project();
    put(
      cwd,
      "supabase/schemas/permdock/helpers.sql",
      `create schema if not exists permdock;
create or replace trigger notes_t after insert on public.notes execute function permdock.kept();
`,
    );
    expect(await pd095(cwd, nodeFiles)).toStrictEqual([]);
  });

  it("returns no findings when the schema directory is absent", async () => {
    expect(await pd095(project(), nodeFiles)).toStrictEqual([]);
  });

  it("ignores a clean schema file, a non-sql neighbour and a migration that adds a new name", async () => {
    const cwd = project();
    put(cwd, "supabase/schemas/permdock/notes.txt", "not sql\n");
    put(
      cwd,
      "supabase/schemas/permdock/helpers.sql",
      `-- generated by permdock
create function permdock.kept() returns int language sql as $$ select 1 $$;
create trigger kept_t after insert on public.notes execute function permdock.kept();
grant select on table public.notes to authenticated;
do $$
begin
  perform 1;
end $$;
do $body$
begin
  perform 1;
`,
    );
    put(
      cwd,
      "supabase/migrations/20260102000000_permdock_extra.sql",
      `-- permdock:extra v1
create table public.fresh (id int);
`,
    );
    expect(await pd095(cwd, nodeFiles)).toStrictEqual([]);
  });
});

describe("PD095 reads statements", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not count a definition in a comment or a string as a second one", async () => {
    const cwd = project();
    put(
      cwd,
      "supabase/schemas/permdock/helpers.sql",
      `-- create or replace function permdock.same(p int) was renamed
create function permdock.same(p int) returns int language sql as $$ select p $$;
comment on function permdock.same(int) is 'create function permdock.same(p int) replaces the old one';
`,
    );
    expect(await pd095(cwd, nodeFiles)).toStrictEqual([]);
  });
});

describe("PD096", () => {
  it("reports no pair when deciding columns record the through match", () => {
    const config: PermDockConfig = {
      rls: {
        membershipSources: [
          tableMembershipSource({
            table: "memberships",
            columns: {
              role: { through: "roles", on: { role_id: "id" }, column: "key" },
            },
          }),
        ],
      },
    };
    expect(pd096(config)).toStrictEqual([]);
    expect(pd096({})).toStrictEqual([]);
  });
});

describe("PD097 defaults", () => {
  it("names an unknown role, scope and permission, and skips a missing policy", async () => {
    const files: DoctorFiles = {
      exists: () => false,
      read: () => "",
      list: () => [],
      isDirectory: () => false,
    };
    const permissions = definePermissions({
      note: resource({ actions: ["read"] }),
    });
    const policy: Policy = definePolicy(permissions, {
      subject: () => null,
      roles: [role("reader", [allow(permissions.note.read)])],
    });
    const config: PermDockConfig = {
      seeds: {
        defaults: {
          roles: [{ key: "ghost", scope: "nowhere", grants: ["note.missing"] }],
        },
        fixtures: {
          users: {},
          tenants: {},
          memberships: [],
          customRoles: [],
          rows: {},
        },
      },
    };
    const findings = await pd097({
      cwd: "/app",
      config,
      files,
      policy: () => Promise.resolve(policy),
    });
    expect(findings.map((finding) => finding.message)).toStrictEqual([
      "default role 'ghost' is not in the policy",
      "default role 'ghost' names unknown scope 'nowhere'",
      "default role 'ghost' names unknown permission 'note.missing'",
    ]);
    expect(
      await pd097({
        cwd: "/app",
        config,
        files,
        policy: () => Promise.resolve(undefined),
      }),
    ).toStrictEqual([]);
  });
});

describe("PD101", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const config: PermDockConfig = {
    permissions: "src/permissions.ts",
    policy: "src/policy.ts",
    rls: {
      tables: {
        job: {
          table: "public.jobs",
          follows: { "public.job_parties": "job_id" },
        },
      },
    },
  };

  it("flags a permissive app policy on a follows child table", async () => {
    const cwd = project();
    put(
      cwd,
      "supabase/schemas/job_parties/040_rls.sql",
      `create policy "job_parties_select" on public.job_parties for select to authenticated using (true);
create policy "job_parties_all" on "public"."job_parties" to authenticated using (true);
create policy "job_parties_guard" on public.job_parties as restrictive for delete to authenticated using (true);
create policy "jobs_select" on public.jobs for select to authenticated using (true);
`,
    );
    put(
      cwd,
      "supabase/schemas/permdock/follows.sql",
      `create policy "permdock_follow_job_parties_select" on "public"."job_parties" for select to authenticated using (true);
`,
    );
    const findings = await pd101(cwd, config, nodeFiles);
    expect(findings.map((finding) => finding.message)).toStrictEqual([
      expect.stringContaining("permissive select policy on public.job_parties"),
      expect.stringContaining("permissive all policy on public.job_parties"),
    ]);
  });

  it("reads an unqualified table as public, skips plain and false tables, and reports an app policy once per command", async () => {
    const cwd = project();
    put(
      cwd,
      "supabase/schemas/app.sql",
      `create policy "p" on job_parties for delete using (true);
create policy "q" on "job_parties" as restrictive for all using (true);
create policy "r" on public.other for select using (true);
`,
    );
    const mixed: PermDockConfig = {
      ...config,
      rls: {
        tables: {
          job: { table: "public.jobs", follows: { job_parties: "job_id" } },
          note: "public.notes",
          cache: false,
          link: { tableOf: "job" },
        },
      },
    };
    expect(await pd101(cwd, mixed, nodeFiles)).toStrictEqual([
      expect.objectContaining({
        message: expect.stringContaining("permissive delete policy"),
      }),
    ]);
  });

  it("reads as restrictive and the command from the statement, not from a string or subquery", async () => {
    const cwd = project();
    put(
      cwd,
      "supabase/schemas/app.sql",
      `create policy "s" on public.job_parties using (note <> 'as restrictive');
create policy "t" on public.job_parties as restrictive using (exists (select 1 from public.jobs for update));
`,
    );
    expect(
      (await pd101(cwd, config, nodeFiles)).map((finding) => finding.message),
    ).toStrictEqual([
      expect.stringContaining("permissive all policy on public.job_parties"),
    ]);
  });

  it("stays quiet without follows", async () => {
    const cwd = project();
    put(
      cwd,
      "supabase/schemas/a.sql",
      "create policy p on public.job_parties for select using (true);\n",
    );
    expect(await pd101(cwd, { ...config, rls: {} }, nodeFiles)).toStrictEqual(
      [],
    );
  });
});
