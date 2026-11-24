import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { authorizationProvider } from "../../src/better-supabase/provider.ts";
import { run } from "../../src/cli/core/run.ts";
import { pd128, pd137 } from "../../src/cli/doctor/table-reads.ts";
import {
  configuredTableReads,
  tableReads,
} from "../../src/cli/rls/table-reads.ts";
import { parseSupabaseManifest } from "../../src/supabase/manifest.ts";

const TMP = join(import.meta.dirname, "../../tmp");

const POLICY = `import { allow, definePermissions, definePolicy, resource, role } from "permdock";

export const permissions = definePermissions({
  invoice: resource({
    actions: ["read"],
    relations: { org: { field: "organization_id", memberOf: "organization" } },
  }),
  note: resource({
    actions: ["read"],
    relations: { org: { field: "organization_id", memberOf: "organization" } },
  }),
});

export const policy = definePolicy(permissions, {
  scopes: { organization: { key: "organization_id" } },
  subject: () => null,
  roles: [
    role("member", [
      allow(permissions.invoice.read),
      allow(permissions.note.read),
    ], { on: "organization" }),
  ],
});
`;

const SCHEMA = `create table public.invoices (id uuid primary key, organization_id uuid not null);
alter table public.invoices enable row level security;
create policy invoices_read on public.invoices for select to authenticated
  using (organization_id in (select permdock.permitted_organization_ids_by_permission('invoice.read')));
create policy invoices_session on public.invoices as restrictive for select to authenticated
  using (permdock.permdock_token_current());

create table public.notes (id uuid primary key, organization_id uuid not null);
alter table public.notes enable row level security;
create policy notes_read on public.notes for select to authenticated
  using (organization_id in (select permdock.permitted_organization_ids('note.read')));

create table public.profiles (id uuid primary key, user_id uuid not null);
alter table public.profiles enable row level security;
create policy profiles_read on public.profiles for select to authenticated
  using (user_id = auth.uid());

create table public.audit (id uuid primary key, organization_id uuid not null, hidden boolean);
alter table public.audit enable row level security;
create policy audit_read on public.audit for select to authenticated
  using (organization_id in (select permdock.permitted_organization_ids_by_permission('invoice.read')));
create policy audit_hidden on public.audit as restrictive for select to authenticated
  using (not hidden);

create table public.logs (id uuid primary key);
`;

const dirs: string[] = [];

function project(): string {
  mkdirSync(TMP, { recursive: true });
  const cwd = mkdtempSync(join(TMP, "table-reads-"));
  dirs.push(cwd);
  mkdirSync(join(cwd, "supabase/schemas"), { recursive: true });
  writeFileSync(join(cwd, "supabase/schemas/app.sql"), SCHEMA);
  writeFileSync(join(cwd, "policy.ts"), POLICY);
  writeFileSync(
    join(cwd, "permdock.config.ts"),
    `export default { policy: "./policy.ts", rls: { dialect: "supabase", authorize: "database", memberships: { scopes: { organization: { table: "memberships", user: "user_id", role: "role", columns: { organization: "organization_id" } } } } } };\n`,
  );
  return cwd;
}

function reads(cwd: string): ReturnType<typeof tableReads> {
  return tableReads({
    cwd,
    config: { rls: { dialect: "supabase" } },
    schema: "permdock",
    root: "organization",
  });
}

describe(tableReads, () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks a table tenant only for the by-permission tenant form", async () => {
    expect(await reads(project())).toStrictEqual([
      {
        table: "public.audit",
        share: "row",
        permissions: ["invoice.read"],
        rules: ["restrictive"],
      },
      {
        table: "public.invoices",
        share: "tenant",
        column: "organization_id",
        permissions: ["invoice.read"],
      },
      { table: "public.logs", share: "row", rules: ["unknown"] },
      { table: "public.notes", share: "row", rules: ["form"] },
      { table: "public.profiles", share: "row", rules: ["owner"] },
    ]);
  });

  it("drops a table a later migration drops and follows a rename", async () => {
    const cwd = project();
    mkdirSync(join(cwd, "supabase/migrations"), { recursive: true });
    writeFileSync(
      join(cwd, "supabase/migrations/20260101000000_old.sql"),
      `create table public.gone (id uuid primary key, organization_id uuid not null);
create table public.before_rename (id uuid primary key, organization_id uuid not null);
alter table public.before_rename enable row level security;
create policy br_read on public.before_rename for select to authenticated
  using (organization_id in (select permdock.permitted_organization_ids_by_permission('invoice.read')));
`,
    );
    writeFileSync(
      join(cwd, "supabase/migrations/20260102000000_later.sql"),
      `drop table public.gone;
alter table public.before_rename rename to after_rename;
`,
    );
    const tables = (await reads(cwd)).map((read) => read.table);
    expect(tables).not.toContain("public.gone");
    expect(tables).not.toContain("public.before_rename");
    expect(tables).toContain("public.after_rename");
  });

  it("says which grant keeps a form table off the tag, in the codemod, the report and explain", async () => {
    const cwd = project();
    writeFileSync(
      join(cwd, "policy.ts"),
      POLICY.replace(
        "allow, definePermissions",
        "allow, deny, definePermissions",
      ).replace(
        "  ],\n});",
        '    role("blocked", [deny(permissions.note.read)], { on: "organization" }),\n  ],\n});',
      ),
    );
    const reason = "key note.read: role blocked on organization denies it";
    const read = (
      await configuredTableReads(cwd, {
        policy: "./policy.ts",
        rls: { dialect: "supabase" },
      })
    ).find((item) => item.table === "public.notes");
    expect(read).toMatchObject({
      rules: ["form"],
      reason: expect.stringContaining(reason),
    });
    const check = await run(["codemod", "bsb-access-tags", "--check"], { cwd });
    expect(check.code).toBe(0);
    expect(check.stdout).toContain(`kept public.notes notes_read: ${reason}`);
    const report = await run(["rls", "report", "--json"], { cwd });
    const counted = JSON.parse(report.stdout).data.tableReads;
    expect(counted).toMatchObject({
      tenant: 1,
      row: 4,
      byRule: { form: 1, owner: 1, restrictive: 1, unknown: 1 },
    });
    const text = await run(["rls", "report"], { cwd });
    expect(text.stdout).toContain("table reads: 1 tenant, 4 row (form 1,");
    expect(text.stdout).toContain(`public.notes: form; ${reason}`);
    const explain = await run(["rls", "explain"], { cwd });
    expect(explain.stdout).toContain(`public.notes: form; ${reason}`);
  });

  it("moves a plain-form table to tenant after codemod bsb-access-tags", async () => {
    const cwd = project();
    const moved = await run(["codemod", "bsb-access-tags", "--force"], { cwd });
    expect(moved.code).toBe(0);
    expect(
      (await reads(cwd)).find((read) => read.table === "public.notes"),
    ).toStrictEqual({
      table: "public.notes",
      share: "tenant",
      column: "organization_id",
      permissions: ["note.read"],
    });
  });

  it("is written into the manifest, read by the provider and checked by PD128", async () => {
    const cwd = project();
    const inspected = await run(["supabase", "inspect", "--out"], { cwd });
    expect(inspected.code).toBe(0);
    const path = join(cwd, "permdock.manifest.json");
    const manifest = parseSupabaseManifest(
      JSON.parse(readFileSync(path, "utf8")),
    );
    expect(
      manifest.rls.tableReads?.map(({ reason: _reason, ...read }) => read),
    ).toStrictEqual(await reads(cwd));
    expect(
      authorizationProvider({
        manifest,
        tables: true,
        catalog: {
          $schema: "https://permdock.com/schemas/catalog-v2.json",
          version: 2,
          generatedAt: "2026-01-01T00:00:00Z",
          generator: "test",
          resources: {},
          permissions: [],
        },
      }).tables?.["public.invoices"],
    ).toStrictEqual({ share: "tenant", permissions: ["invoice.read"] });
    expect(await pd128({ cwd, config: {} })).toStrictEqual([]);

    const edited = {
      ...manifest,
      rls: {
        ...manifest.rls,
        tableReads: manifest.rls.tableReads?.map((read) =>
          read.table === "public.notes"
            ? { table: read.table, share: "tenant", column: "organization_id" }
            : read,
        ),
      },
    };
    writeFileSync(path, JSON.stringify(edited));
    expect(await pd128({ cwd, config: {} })).toStrictEqual([
      expect.objectContaining({
        code: "PD128",
        severity: "error",
        message:
          "permdock.manifest.json marks public.notes share: 'tenant', but its select policies are row-scoped (form)",
      }),
    ]);
  });

  it("writes sharedFunctions and tenantPureHelpers into the manifest and lets PD137 catch a function over a row table", async () => {
    const cwd = project();
    writeFileSync(
      join(cwd, "supabase/schemas/fn.sql"),
      `create function public.invoice_total() returns numeric language sql stable as $$ select count(*) from public.invoices $$;
create function public.note_total() returns numeric language sql stable as $$ select count(*) from public.notes $$;
`,
    );
    expect((await run(["supabase", "inspect", "--out"], { cwd })).code).toBe(0);
    const path = join(cwd, "permdock.manifest.json");
    const manifest = parseSupabaseManifest(
      JSON.parse(readFileSync(path, "utf8")),
    );
    expect(manifest.rls.sharedFunctions).toStrictEqual([
      {
        function: "public.invoice_total",
        tables: ["public.invoices"],
        permissions: ["invoice.read"],
      },
    ]);
    expect(
      manifest.rls.tenantPureHelpers?.map((helper) => helper.name),
    ).toStrictEqual([
      "permdock.permdock_organization_has",
      "permdock.permitted_organization_permission_keys",
    ]);
    expect(await pd137({ cwd, config: {} })).toStrictEqual([]);

    writeFileSync(
      path,
      JSON.stringify({
        ...manifest,
        rls: {
          ...manifest.rls,
          sharedFunctions: [
            ...(manifest.rls.sharedFunctions ?? []),
            {
              function: "public.note_total",
              tables: ["public.notes"],
              permissions: ["note.read"],
            },
          ],
        },
      }),
    );
    expect(await pd137({ cwd, config: {} })).toStrictEqual([
      expect.objectContaining({
        code: "PD137",
        severity: "error",
        message:
          "permdock.manifest.json lists public.note_total in rls.sharedFunctions, but it reads public.notes, which is not a tenant table",
      }),
    ]);
  });
});
