import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "../../src/cli/core/run.ts";
import { pd104 } from "../../src/cli/doctor/perf-sql.ts";
import { pd090 } from "../../src/cli/doctor/sql.ts";
import {
  taggedPolicyId,
  taggedPolicyIds,
} from "../../src/cli/sql/bsb-access.ts";

const TMP = join(import.meta.dirname, "../../tmp");

const POLICY = `import { allow, definePermissions, definePolicy, resource, role } from "permdock";

export const permissions = definePermissions({
  invoice: resource({
    actions: ["read", "create"],
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
    ], { on: "organization" }),
  ],
});
`;

const SCHEMA = `create table public.invoices (id uuid primary key, organization_id uuid not null);
alter table public.invoices enable row level security;

create policy invoices_read on public.invoices for select to authenticated
  using (organization_id in (select permdock.permitted_organization_ids('invoice.read')));
create policy invoices_insert on public.invoices for insert to authenticated
  with check (organization_id in (select permdock.permitted_organization_ids('invoice.create')) and permdock.permdock_actor_may_write());
`;

const GENERATED = `create policy invoices_read_only_actors on public.invoices as restrictive for insert to authenticated
  with check (permdock.permdock_actor_may_write());
create policy invoices_permdock_read on public.invoices for select to authenticated
  using (true);
`;

const dirs: string[] = [];

async function tagged(): Promise<string> {
  mkdirSync(TMP, { recursive: true });
  const cwd = mkdtempSync(join(TMP, "access-generated-"));
  dirs.push(cwd);
  mkdirSync(join(cwd, "supabase/schemas/permdock"), { recursive: true });
  writeFileSync(join(cwd, "supabase/schemas/app.sql"), SCHEMA);
  writeFileSync(join(cwd, "policy.ts"), POLICY);
  writeFileSync(
    join(cwd, "permdock.config.ts"),
    `export default { policy: "./policy.ts", rls: { dialect: "supabase" } };\n`,
  );
  const moved = await run(["codemod", "bsb-access-tags", "--force"], { cwd });
  expect(moved.code).toBe(0);
  writeFileSync(join(cwd, "supabase/schemas/permdock/guards.sql"), GENERATED);
  return cwd;
}

describe("policies an @bsb access tag renders", () => {
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("are listed by better-supabase, not guessed from the name", async () => {
    const cwd = await tagged();
    const ids = await taggedPolicyIds(cwd);
    expect(ids).toStrictEqual(
      new Set([
        taggedPolicyId("public.invoices", "bsb_access_invoices_read"),
        taggedPolicyId("public.invoices", "bsb_access_invoices_create"),
      ]),
    );
    expect(
      ids.has(taggedPolicyId("invoices", "bsb_access_invoices_read")),
    ).toBe(true);
  });

  it("do not count as hand-written in PD090 or PD104", async () => {
    const cwd = await tagged();
    expect(await pd090(cwd, {})).toStrictEqual([]);
    expect(await pd104(cwd, {})).toStrictEqual([]);
  });

  it("are listed by rls explain", async () => {
    const cwd = await tagged();
    const result = await run(["rls", "explain", "--json"], { cwd });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data.tagged).toStrictEqual([
      expect.objectContaining({
        table: "public.invoices",
        operation: "read",
        name: "bsb_access_invoices_read",
        key: "invoice.read",
      }),
      expect.objectContaining({
        table: "public.invoices",
        operation: "create",
        name: "bsb_access_invoices_create",
        key: "invoice.create",
      }),
    ]);
  });
});
