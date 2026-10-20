import { describe, expect, it } from "vitest";

import {
  junctionMembershipSource,
  tableMembershipSource,
} from "../../src/supabase/sources.ts";

describe("MembershipSql.stream", () => {
  it("describes a table source with its default columns", () => {
    const { stream } = tableMembershipSource({ table: "memberships" }).sql;
    expect(stream).toEqual({
      table: "public.memberships",
      user: "user_id",
      scope: { column: "scope" },
      id: "scope_id",
      roles: "role",
      nullableRoles: true,
    });
  });

  it("qualifies a roles table in the source's schema", () => {
    const { stream } = tableMembershipSource({
      table: "app.members",
      columns: {
        role: [
          "tier_role",
          { through: "roles", on: { role_id: "id" }, column: "key" },
        ],
        via: "kind",
        expiresAt: "expires_at",
      },
    }).sql;
    expect(stream).toMatchObject({
      table: "app.members",
      roles: [
        "tier_role",
        { through: "app.roles", on: { role_id: "id" }, column: "key" },
      ],
      via: { column: "kind" },
      expiresAt: "expires_at",
    });
  });

  it("describes a junction source with fixed roles and a fixed via", () => {
    const { stream } = junctionMembershipSource({
      table: "customer_contacts",
      scope: "customer",
      roles: ["contact"],
      via: "contact",
      disabledAt: "disabled_at",
    }).sql;
    expect(stream).toEqual({
      table: "public.customer_contacts",
      user: "user_id",
      scope: { value: "customer" },
      id: "customer_id",
      roles: { value: ["contact"] },
      via: { value: "contact" },
      disabledAt: "disabled_at",
      nullableRoles: false,
    });
  });

  it("describes a junction source with role sources and a user reference", () => {
    const { stream } = junctionMembershipSource({
      table: "tenant_users",
      scope: "tenant",
      id: "tenant_id",
      user: {
        through: "profiles",
        on: { profile_id: "id" },
        column: "user_id",
      },
      roles: {
        sources: [
          "tier_role",
          { through: "public.roles", on: { role_id: "id" }, column: "key" },
        ],
      },
    }).sql;
    expect(stream).toMatchObject({
      user: {
        through: "public.profiles",
        on: { profile_id: "id" },
        column: "user_id",
      },
      roles: [
        "tier_role",
        { through: "public.roles", on: { role_id: "id" }, column: "key" },
      ],
      nullableRoles: true,
    });
  });

  it("carries the guard of a guarded source", () => {
    const guard = {
      table: "public.roles",
      tenant: "tenant_id",
      declared: ["owner"],
    };
    const source = junctionMembershipSource({
      table: "user_roles",
      scope: "tenant",
      id: "tenant_id",
      roles: { through: "roles", on: { role_id: "id" }, column: "key" },
    });
    expect(source.sql.stream?.guard).toBeUndefined();
    expect(source.guarded?.(guard).sql.stream?.guard).toEqual(guard);
  });
});
