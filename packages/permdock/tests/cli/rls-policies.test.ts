import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";

import { compileGrants } from "../../src/cli/rls-compile.ts";
import { assemblePolicies } from "../../src/cli/rls-policies.ts";
import { scopeList } from "../../src/core/scopes.ts";
import {
  actor,
  allow,
  anyone,
  definePermissions,
  definePolicy,
  deny,
  principal,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions({
  post: resource({
    actions: ["read", "update", "delete"],
    collection: ["list", "create"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});
const { post } = permissions;
const policy = definePolicy(permissions, {
  subject: () => null,
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role("staff", [allow(post.read), allow(post.list)]),
    role("admin", [allow([post.read, post.update, post.delete])], {
      on: "tenant",
    }),
    role(
      "member",
      [
        allow(post.read),
        allow(post.update, { where: { authorId: principal.id } }),
        deny(post.delete, { where: { locked: true } }),
      ],
      { on: "tenant" },
    ),
  ],
  grants: [allow(post.list, { to: anyone() })],
});
const ctx: RlsSqlContext = {
  dialect: "supabase",
  tenantClaim: "tenant_id",
  scopes: scopeList(undefined),
  gucPrefix: "app",
};

function compiled() {
  return compileGrants(policy, ctx, undefined, [], false);
}

describe("assemblePolicies", () => {
  it("collapses to one policy per table, command, effect and database role", () => {
    const policies = assemblePolicies(compiled().branches, { perRole: false });
    expect(
      policies.map((item) => [item.name, item.effect, item.roles.join(",")]),
    ).toEqual([
      ["post_select", "allow", "authenticated"],
      ["post_select_anon", "allow", "anon"],
      ["post_update", "allow", "authenticated"],
      ["post_delete", "allow", "authenticated"],
      ["deny_post_delete", "deny", "authenticated"],
    ]);
    const using = (name: string) =>
      policies.find((item) => item.name === name)?.using;
    expect(using("post_select")).toBe("true");
    expect(using("post_select_anon")).toBe("true");
    expect(using("post_update")).toContain(
      `"orgId" in (select "permdock".permitted_tenant_ids('post.update#1'))`,
    );
    const denied = policies.find((item) => item.name === "deny_post_delete");
    expect(denied?.using).toBe(
      `(("orgId" in (select "permdock".permitted_tenant_ids('post.delete#2'))) and ("locked" = true)) is not true`,
    );
  });

  it("keys grants of one permission by condition group", () => {
    const rows = compiled().rolePermissions.filter(
      (row) => row.permission === "post.update",
    );
    expect(rows).toEqual([
      {
        role: "admin",
        permission: "post.update",
        grantKey: "post.update#1",
        scope: "tenant",
        effect: "allow",
      },
      {
        role: "member",
        permission: "post.update",
        grantKey: "post.update#2",
        scope: "tenant",
        effect: "allow",
      },
    ]);
    expect(
      compiled().rolePermissions.find((row) => row.role === "staff"),
    ).toMatchObject({ grantKey: "post.read", scope: "global" });
  });

  it("keeps the per-role shape and applies a name template", () => {
    const perRole = assemblePolicies(compiled().branches, { perRole: true });
    expect(perRole.map((item) => item.name)).toContain("member_post_update");
    expect(perRole.map((item) => item.name)).toContain(
      "deny_member_post_delete",
    );
    const named = assemblePolicies(compiled().branches, {
      perRole: false,
      name: "pd_{op}_on_{table}",
    });
    expect(named[0]?.name).toBe("pd_select_on_post");
    expect(() =>
      assemblePolicies(compiled().branches, {
        perRole: false,
        name: "{role}_{table}_{op}",
      }),
    ).toThrow(/--policy-per-role/u);
  });
});

describe("delegated actor denies", () => {
  const guarded = definePolicy(permissions, {
    subject: () => null,
    scopes: { tenant: { key: "orgId" } },
    roles: [role("admin", [allow(post.delete)], { on: "tenant" })],
    grants: [deny(post.delete, { to: actor("oauth-client") })],
  });

  it("compiles deny for oauth-client actors to a restrictive client_id check", () => {
    const policies = assemblePolicies(
      compileGrants(guarded, ctx, undefined, [], false).branches,
      { perRole: false },
    );
    const denied = policies.find((item) => item.name === "deny_post_delete");
    expect(denied?.effect).toBe("deny");
    expect(denied?.using).toBe(
      `(((select auth.jwt()) ->> 'client_id') is not null or ((select auth.jwt()) -> 'act') is not null) is not true`,
    );
  });

  it("refuses an actor grantee it cannot compile", () => {
    const allowed = definePolicy(permissions, {
      subject: () => null,
      grants: [allow(post.read, { to: actor("oauth-client") })],
    });
    expect(() => compileGrants(allowed, ctx, undefined, [], false)).toThrow(
      /RLS compiles only deny/u,
    );
  });
});
