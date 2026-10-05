import type { CustomRole, Principal } from "permdock";
import type { Client } from "pg";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPermDock,
  findPermission,
  memoryRelations,
  memoryRoleSource,
  validateCustomRole,
} from "permdock";
import {
  approvalsHandler,
  memoryApprovalStore,
  requestApproval,
} from "permdock/approvals";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { permissions, policy } from "../fixtures/centrakit-adoption/policy.ts";
import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/centrakit-adoption");

const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

const ADMIN = id(0xa1);
const MEMBER = id(0xa2);
const VIEWER = id(0xa3);
const TIER2 = id(0xa4);
const MANAGER = id(0xa5);
const APPROVER = id(0xa6);
const ORG_A = id(0xb1);
const ORG_B = id(0xb2);
const CUST_A = id(0xc1);
const CUST_B = id(0xc2);
const BILL_A = id(0xd1);
const BILL_B = id(0xd2);
const PLATFORM_BILL = id(0xd9);
const DISPATCHER = id(0xa7);
const ADMIN_ROLE = id(0xf1);
const MEMBER_ROLE = id(0xf2);
const VIEWER_ROLE = id(0xf3);
const DISPATCH_A_ROLE = id(0xf4);
const DISPATCH_B_ROLE = id(0xf5);
const REPORT = id(0xe1);
const EXPENSE = id(0xe2);

const SETUP = `
create role authenticated nologin;
create role anon nologin;
grant authenticated, anon to tester;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values
  ('${ADMIN}'), ('${MEMBER}'), ('${VIEWER}'), ('${TIER2}'), ('${MANAGER}'), ('${APPROVER}'), ('${DISPATCHER}');
create table organizations (id uuid primary key);
insert into organizations values ('${ORG_A}'), ('${ORG_B}');
create type scope_type as enum ('system', 'organization', 'user', 'team');
create table roles (
  id uuid primary key,
  scope scope_type not null,
  key text not null,
  name text not null,
  system boolean not null default false,
  organization_id uuid references organizations (id) on delete cascade
);
create unique index roles_builtin_key on roles (scope, key) where organization_id is null;
create unique index roles_custom_key on roles (scope, key, organization_id);
insert into roles values
  ('${ADMIN_ROLE}', 'organization', 'admin', 'Admin', true, null),
  ('${MEMBER_ROLE}', 'organization', 'member', 'Member', true, null),
  ('${VIEWER_ROLE}', 'organization', 'viewer', 'Viewer', true, null),
  ('${DISPATCH_A_ROLE}', 'organization', 'dispatcher', 'Dispatcher', false, '${ORG_A}'),
  ('${DISPATCH_B_ROLE}', 'organization', 'dispatcher', 'Dispatcher', false, '${ORG_B}');
create table organization_users (
  user_id uuid not null references auth.users (id) on delete cascade,
  organization_id uuid not null references organizations (id) on delete cascade,
  role_id uuid not null references roles (id),
  unique (user_id, organization_id)
);
insert into organization_users values
  ('${ADMIN}', '${ORG_A}', '${ADMIN_ROLE}'), ('${MEMBER}', '${ORG_A}', '${MEMBER_ROLE}'),
  ('${VIEWER}', '${ORG_A}', '${VIEWER_ROLE}'), ('${DISPATCHER}', '${ORG_A}', '${DISPATCH_A_ROLE}'),
  ('${DISPATCHER}', '${ORG_B}', '${DISPATCH_B_ROLE}');
create table customers (id uuid primary key, organization_id uuid not null);
insert into customers values ('${CUST_A}', '${ORG_A}'), ('${CUST_B}', '${ORG_B}');
create table billing (id uuid primary key, organization_id uuid not null);
insert into billing values ('${BILL_A}', '${ORG_A}'), ('${BILL_B}', '${ORG_B}');
create table platform_billing (id uuid primary key);
insert into platform_billing values ('${PLATFORM_BILL}');
create table reports (id uuid primary key, organization_id uuid not null, approver_id uuid not null);
create table expenses (
  id uuid primary key, organization_id uuid not null, manager_id uuid not null,
  report_id uuid not null, amount numeric not null
);
`;

/**
 * A support tier an operator defined: `support` plus platform billing, and one
 * key outside the global ceiling. Each organization's `dispatcher` reaches a
 * different permission.
 */
const TIER2_ROWS = `
insert into permdock.custom_role_permissions (tenant_id, scope, scope_id, role, permission)
  values ('${ORG_A}', 'organization', null, 'dispatcher', 'customers.view'),
         ('${ORG_B}', 'organization', null, 'dispatcher', 'billing.view');
insert into permdock.user_roles (user_id, role) values ('${TIER2}', 'tier2');
insert into permdock.custom_role_includes (tenant_id, scope, scope_id, role, include_role)
  values (null, 'global', null, 'tier2', 'support');
insert into permdock.custom_role_permissions (tenant_id, scope, scope_id, role, permission)
  values (null, 'global', null, 'tier2', 'platform.billing.view'),
         (null, 'global', null, 'tier2', 'customers.archive');
`;

const tier2: CustomRole = {
  scope: "global",
  name: "tier2",
  includes: ["support"],
  grants: [
    { permission: "system.billing.view" },
    { permission: "customers.archive" },
  ],
};

function staff(user: string, roles: readonly string[]): Principal {
  return {
    id: user,
    tenant: ORG_A,
    memberships: [{ scope: "organization", id: ORG_A, roles }],
  };
}

describe("CentraKit adoption shapes", () => {
  let db: Postgres | undefined;
  let dir = "";
  let generated = "";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "permdock-adoption-"));
    const out = join(dir, "permdock.sql");
    const result = await run(
      [
        "rls",
        "generate",
        "--target",
        "sql",
        "--rbac",
        "supabase",
        "--out",
        out,
      ],
      { cwd: FIXTURE },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
    }
    generated = readFileSync(out, "utf8");
    db = await startPostgres([SETUP, generated, TIER2_ROWS]);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  function as<T>(sub: string, work: (client: Client) => Promise<T>) {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const client = db.tester;
    return db.as(
      {
        role: "authenticated",
        settings: {
          "request.jwt.claims": JSON.stringify({ sub, role: "authenticated" }),
        },
      },
      () => work(client),
    );
  }

  const ids = async (sub: string, table: string) =>
    as(sub, async (client) =>
      (
        await client.query<{ id: string }>(
          `select id from ${table} order by id`,
        )
      ).rows.map((row) => row.id),
    );

  const answer = async (sub: string, sql: string, values: unknown[] = []) =>
    as(sub, async (client) => {
      const { rows } = await client.query<{ ok: boolean }>(sql, values);
      return rows[0]?.ok;
    });

  it("compiles the view verb to a select policy and archive to none", async () => {
    expect(generated).toContain('create policy "customers_select"');
    expect(generated).not.toMatch(/customers_archive|for archive/u);
    expect(await ids(VIEWER, "customers")).toEqual([CUST_A]);
    expect(await ids(ADMIN, "billing")).toEqual([BILL_A]);
    expect(await ids(VIEWER, "billing")).toEqual([]);
  });

  it("answers a lifecycle verb and legacy keys through the shims", async () => {
    const archive = `select public.has_org_permission($1::uuid, 'organization.customers.archive') as ok`;
    expect(await answer(ADMIN, archive, [ORG_A])).toBe(true);
    expect(await answer(ADMIN, archive, [ORG_B])).toBe(false);
    expect(await answer(VIEWER, archive, [ORG_A])).toBe(false);
    const legacyView = await as(VIEWER, async (client) =>
      (
        await client.query<{ id: string }>(
          `select * from public.org_ids_with_permission('organization.customers.view') as t(id)`,
        )
      ).rows.map((row) => row.id),
    );
    expect(legacyView).toEqual([ORG_A]);
    expect(
      await answer(
        TIER2,
        `select public.is_system_user_with('system.billing.view') as ok`,
      ),
    ).toBe(true);
  });

  it("answers a permission whose grants are split by condition through the shims", async () => {
    expect(generated).toContain("reports.view#1");
    const reports = `select public.has_org_permission($1::uuid, 'organization.reports.view') as ok`;
    expect(await answer(MEMBER, reports, [ORG_A])).toBe(true);
    expect(await answer(MEMBER, reports, [ORG_B])).toBe(false);
    expect(await answer(VIEWER, reports, [ORG_A])).toBe(false);
    const orgs = await as(MEMBER, async (client) =>
      (
        await client.query<{ id: string }>(
          `select * from public.org_ids_with_permission('organization.reports.view') as t(id)`,
        )
      ).rows.map((row) => row.id),
    );
    expect(orgs).toEqual([ORG_A]);
  });

  it("lets a caller without usage on the helper schema call a shim", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    await db.admin.query(
      "create role shim_caller nologin; grant shim_caller to tester; grant execute on function public.has_org_permission(uuid, text) to shim_caller",
    );
    const ok = await db.as(
      {
        role: "shim_caller",
        settings: {
          "request.jwt.claims": JSON.stringify({
            sub: ADMIN,
            role: "authenticated",
          }),
        },
      },
      async () =>
        (
          await db!.tester.query<{ ok: boolean }>(
            `select public.has_org_permission($1::uuid, 'organization.customers.archive') as ok`,
            [ORG_A],
          )
        ).rows[0]?.ok,
    );
    expect(ok).toBe(true);
  });

  it("keeps a platform and an organization billing resource apart", async () => {
    expect(permissions.platform.billing.view).toMatchObject({
      key: "platform.billing.view",
      resource: "platform_billing",
    });
    expect(permissions.billing.view.resource).toBe("billing");
    expect(generated).toContain('create policy "platform_billing_select"');
    expect(await ids(TIER2, "platform_billing")).toEqual([PLATFORM_BILL]);
    expect(await ids(ADMIN, "platform_billing")).toEqual([]);
  });

  it("resolves legacy keys in code and in stored custom roles", async () => {
    expect(findPermission(permissions, "organization.customers.view")).toBe(
      permissions.customers.view,
    );
    expect(validateCustomRole(policy, tier2)).toMatchObject({
      ok: false,
      permissions: ["customers.view", "platform.billing.view"],
      dropped: [{ permission: "customers.archive", reason: "outside-ceiling" }],
      renamed: [{ from: "system.billing.view", to: "platform.billing.view" }],
    });
    const permdock = await createPermDock(
      policy,
      { id: TIER2, roles: ["tier2"] },
      { customRoles: memoryRoleSource([tier2]) },
    );
    expect(
      permdock.can(permissions.platform.billing.view, { id: PLATFORM_BILL }),
    ).toBe(true);
    expect(
      permdock.can(permissions.customers.archive, {
        id: CUST_A,
        organization_id: ORG_A,
      }),
    ).toBe(false);
  });

  it("reads organization_users.role_id through roles.key", async () => {
    expect(generated).toContain(
      'join "public"."roles" mk on mk."id" = m."role_id"',
    );
    expect(await ids(ADMIN, "customers")).toEqual([CUST_A]);
    expect(await ids(MEMBER, "billing")).toEqual([]);
    expect(
      await answer(
        ADMIN,
        `select permdock.authorize('customers.update'::permdock.app_permission, $1::text) as ok`,
        [ORG_A],
      ),
    ).toBe(true);
    expect(
      await answer(
        VIEWER,
        `select permdock.authorize('customers.update'::permdock.app_permission, $1::text) as ok`,
        [ORG_A],
      ),
    ).toBe(false);
  });

  it("resolves an organization custom role by its key within that organization", async () => {
    expect(await ids(DISPATCHER, "customers")).toEqual([CUST_A]);
    expect(await ids(DISPATCHER, "billing")).toEqual([BILL_B]);
    expect(
      await answer(
        DISPATCHER,
        `select permdock.authorize('billing.view'::permdock.app_permission, $1::text) as ok`,
        [ORG_B],
      ),
    ).toBe(true);
    expect(
      await answer(
        DISPATCHER,
        `select permdock.authorize('billing.view'::permdock.app_permission, $1::text) as ok`,
        [ORG_A],
      ),
    ).toBe(false);
  });

  it("caps a global custom role at the assignable global roles in SQL", async () => {
    expect(await ids(TIER2, "customers")).toEqual([CUST_A, CUST_B]);
    expect(
      await answer(
        TIER2,
        `select permdock.permdock_has('customers.archive') as ok`,
      ),
    ).toBe(false);
    expect(
      await answer(
        TIER2,
        `select permdock.permdock_has('platform.billing.view') as ok`,
      ),
    ).toBe(true);
  });

  it("resolves a custom-role row stored under a former key in SQL", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    await db.admin.query(
      `insert into permdock.user_roles (user_id, role) values ('${MANAGER}', 'billing-reader');
       insert into permdock.custom_role_permissions (tenant_id, scope, scope_id, role, permission)
         values (null, 'global', null, 'billing-reader', 'system.billing.view')`,
    );
    expect(await ids(MANAGER, "platform_billing")).toEqual([PLATFORM_BILL]);
  });

  it("signs an expense off by its manager, then the report's approver", async () => {
    const expense = {
      id: EXPENSE,
      organization_id: ORG_A,
      manager_id: MANAGER,
      report_id: REPORT,
      amount: 5000,
    };
    const relations = memoryRelations(permissions, {
      rows: {
        expenses: [expense],
        reports: [
          { id: REPORT, organization_id: ORG_A, approver_id: APPROVER },
        ],
      },
    });
    const requester = await createPermDock(policy, staff(MEMBER, ["member"]));
    const decision = requester.decide(permissions.expenses.pay, expense);
    expect(decision.outcome).toBe("approval-required");
    if (decision.outcome !== "approval-required") {
      return;
    }
    const store = memoryApprovalStore();
    const request = await requestApproval(store, decision, {
      permission: permissions.expenses.pay,
      resource: { type: "expenses", id: EXPENSE },
      subject: requester.subject,
    });
    expect(request.approvers).toMatchObject({ mode: "sequential" });
    const approve = async (who: string) => {
      const handler = approvalsHandler(store, {
        subject: () => ({
          principal: staff(who, ["viewer"]),
          context: {},
        }),
        relations,
        permissions,
      });
      return handler(
        new Request(
          `https://centrakit.test/permdock/approvals/${encodeURIComponent(request.token)}/approve`,
          { method: "POST" },
        ),
      );
    };
    expect((await approve(APPROVER)).status).toBe(403);
    expect((await approve(MANAGER)).status).toBe(200);
    expect((await store.get(request.token))?.status).toBe("pending");
    expect((await approve(APPROVER)).status).toBe(200);
    expect(await store.get(request.token)).toMatchObject({
      status: "approved",
      approvals: [
        { by: MANAGER, stage: 0 },
        { by: APPROVER, stage: 1 },
      ],
    });
  });
});
