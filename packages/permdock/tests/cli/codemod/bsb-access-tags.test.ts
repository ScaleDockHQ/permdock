import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "../../../src/cli/core/run.ts";
import { parseSqlFile } from "../../../src/cli/sql/ast.ts";

const TMP = join(import.meta.dirname, "../../../tmp");

const POLICY = `import { allow, deny, definePermissions, definePolicy, resource, role } from "permdock";

export const permissions = definePermissions({
  invoice: resource({
    actions: ["read", "create", "update", "delete"],
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
      allow(permissions.invoice.create),
      allow(permissions.invoice.update),
      allow(permissions.note.read),
    ], { on: "organization" }),
    role("viewer", [deny(permissions.note.read)], { on: "organization" }),
  ],
});
`;

const SCHEMA = `create table public.invoices (id uuid primary key, organization_id uuid not null);
alter table public.invoices enable row level security;
comment on table public.invoices is 'Invoices';

create policy invoices_read on public.invoices for select to authenticated
  using (organization_id in (select permdock.permitted_organization_ids('invoice.read')));
create policy invoices_insert on public.invoices for insert to authenticated
  with check (organization_id in (select permdock.permitted_organization_ids('invoice.create')) and permdock.permdock_actor_may_write());
create policy invoices_update on public.invoices for update to authenticated
  using (organization_id in (select permdock.permitted_organization_ids('invoice.update')) and permdock.permdock_actor_may_write())
  with check (organization_id in (select permdock.permitted_organization_ids('invoice.update')) and permdock.permdock_actor_may_write());

create table public.notes (id uuid primary key, organization_id uuid not null);
create policy notes_read on public.notes for select to authenticated
  using (organization_id in (select permdock.permitted_organization_ids('note.read')));
`;

const dirs: string[] = [];

function project(): string {
  mkdirSync(TMP, { recursive: true });
  const cwd = mkdtempSync(join(TMP, "access-tags-"));
  dirs.push(cwd);
  mkdirSync(join(cwd, "supabase/schemas"), { recursive: true });
  writeFileSync(join(cwd, "supabase/schemas/app.sql"), SCHEMA);
  writeFileSync(join(cwd, "policy.ts"), POLICY);
  writeFileSync(
    join(cwd, "permdock.config.ts"),
    `export default { policy: "./policy.ts", rls: { dialect: "supabase" } };\n`,
  );
  return cwd;
}

describe("codemod bsb-access-tags", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("moves plain tenant policies to a tag when both helpers answer the same", async () => {
    const cwd = project();
    const result = await run(
      ["codemod", "bsb-access-tags", "--force", "--json"],
      { cwd },
    );
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout).data;
    expect(report.moved).toStrictEqual([
      {
        table: "public.invoices",
        operations: {
          read: "invoice.read",
          create: "invoice.create",
          update: "invoice.update",
        },
      },
    ]);
    expect(report.kept).toStrictEqual([
      expect.objectContaining({
        table: "public.notes",
        policy: "notes_read",
        reason: expect.stringContaining("key note.read"),
      }),
    ]);
    const text = readFileSync(join(cwd, "supabase/schemas/app.sql"), "utf8");
    expect(text).toContain(
      "@bsb access tenant=organization_id read=invoice.read create=invoice.create update=invoice.update actor-guard",
    );
    expect(text).not.toContain("create policy invoices_read");
    expect(text).toContain('create policy "bsb_access_invoices_read"');
    expect(text).toContain(
      "permdock.permitted_organization_ids_by_permission('invoice.read')",
    );
    expect(text).toContain("permdock.permdock_actor_may_write()");
    expect(text).toContain("create policy notes_read");
    await expect(parseSqlFile(text)).resolves.toBeDefined();
  });
});
