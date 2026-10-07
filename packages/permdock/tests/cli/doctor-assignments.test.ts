import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";
import type { Principal } from "../../src/core/subject.ts";

import { pd064 } from "../../src/cli/doctor-assignments.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy, role } from "../../src/core/policy.ts";

const permissions = definePermissions({
  project: resource({
    actions: ["read"],
    relations: { workspace: { field: "workspace_id", memberOf: "workspace" } },
  }),
});

const policy = definePolicy(
  { permissions },
  {
    subject: (user: Principal | null) => user,
    scopes: { workspace: { key: "workspace_id" } },
    roles: [
      role("owner", [allow(permissions.project.read)], {
        on: "workspace",
        assigns: ["owner", "editor"],
      }),
      role("editor", [allow(permissions.project.read)], { on: "workspace" }),
      role("staff", [allow(permissions.project.read)], {
        assigns: ["support"],
      }),
      role("support", [allow(permissions.project.read)]),
    ],
  },
);

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function project(migration: string | undefined, rls: PermDockConfig["rls"]) {
  const cwd = mkdtempSync(join(tmpdir(), "permdock-pd064-"));
  dirs.push(cwd);
  if (migration !== undefined) {
    mkdirSync(join(cwd, "supabase/migrations"), { recursive: true });
    writeFileSync(join(cwd, "supabase/migrations/0001_rls.sql"), migration);
  }
  const config: PermDockConfig = {
    policy: "./policy.ts",
    ...(rls === undefined ? {} : { rls }),
  };
  return { cwd, config, policy: () => Promise.resolve(policy) };
}

const RLS = {
  roles: { table: "app.user_roles" },
  assignments: {
    tables: [
      {
        table: "invites",
        scope: "workspace",
        id: "workspace_id",
        role: "role",
      },
    ],
  },
  memberships: {
    scopes: {
      workspace: {
        table: "workspace_members",
        user: "user_id",
        role: "role",
        columns: { workspace: "workspace_id" },
      },
    },
  },
} satisfies NonNullable<PermDockConfig["rls"]>;

const trigger = (table: string): string =>
  `create trigger "permdock_assignment"\n  before insert or update or delete on ${table}\n  for each row execute function permdock.f();\n`;

describe("PD064", () => {
  it("names each guarded table without an assignment trigger", async () => {
    const findings = await pd064(
      project(trigger(`"public"."workspace_members"`), RLS),
    );
    expect(findings.map((item) => item.message)).toEqual([
      "rls.assignments guards app.user_roles, but no migration creates its permdock_assignment trigger, so a client may write any role there",
      "rls.assignments guards public.invites, but no migration creates its permdock_assignment trigger, so a client may write any role there",
    ]);
    expect(findings[0]).toMatchObject({ code: "PD064", severity: "warning" });
  });

  it("stays quiet when every guarded table has its trigger", async () => {
    expect(
      await pd064(
        project(
          [
            trigger(`"public"."workspace_members"`),
            trigger("app.user_roles"),
            trigger("invites"),
          ].join(""),
          RLS,
        ),
      ),
    ).toEqual([]);
  });

  it("reads the rls generate output and skips a config without rls.assignments", async () => {
    const input = project(undefined, { ...RLS, out: "db/rls.sql" });
    mkdirSync(join(input.cwd, "db"));
    writeFileSync(
      join(input.cwd, "db/rls.sql"),
      [
        trigger(`"public"."workspace_members"`),
        trigger(`"app"."user_roles"`),
        trigger(`"public"."invites"`),
      ].join(""),
    );
    expect(await pd064(input)).toEqual([]);
    expect(
      await pd064(
        project(undefined, { roles: RLS.roles, memberships: RLS.memberships }),
      ),
    ).toEqual([]);
  });

  it("skips a project without a policy or an assigns graph", async () => {
    const input = project(undefined, RLS);
    expect(
      await pd064({ ...input, policy: () => Promise.resolve(undefined) }),
    ).toEqual([]);
    const flat = definePolicy(
      { permissions },
      {
        subject: (user: Principal | null) => user,
        scopes: { workspace: { key: "workspace_id" } },
        roles: [
          role("editor", [allow(permissions.project.read)], {
            on: "workspace",
          }),
        ],
      },
    );
    expect(
      await pd064({ ...input, policy: () => Promise.resolve(flat) }),
    ).toEqual([]);
  });

  it("ignores an rls.out that is not a SQL file", async () => {
    const findings = await pd064(
      project(trigger(`"public"."workspace_members"`), {
        ...RLS,
        out: "db/policies.ts",
      }),
    );
    expect(findings).toHaveLength(2);
  });
});
