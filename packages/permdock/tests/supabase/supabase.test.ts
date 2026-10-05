import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AuthEvent } from "../../src/core/interfaces.ts";

import {
  allow,
  createPermDock,
  definePermissions,
  definePolicy,
  defineRoles,
  resource,
  role,
} from "../../src/index.ts";
import {
  authorizeSql,
  subjectFromSupabase,
  subjectFromSupabaseSession,
  supabaseRls,
} from "../../src/supabase/index.ts";

describe("subjectFromSupabase", () => {
  it("never throws and fails closed to anonymous", () => {
    expect(() => subjectFromSupabase(null)).not.toThrow();
    expect(subjectFromSupabase(null).principal).toBeNull();
  });

  it("maps tenant and memberships claims and never reads user_metadata", () => {
    const subject = subjectFromSupabase({
      sub: "user-1",
      role: "authenticated",
      iss: "https://proj.supabase.co/auth/v1",
      aal: "aal2",
      session_id: "sess-1",
      exp: 1_700_000_000,
      user_role: "member",
      tenant_id: "org-1",
      memberships: [{ tenant: "org-1", roles: ["admin"] }],
      app_metadata: { plan: "pro" },
      user_metadata: { role: "superadmin", tenant_id: "evil" },
    });
    expect(subject.principal?.id).toBe("user-1");
    expect(subject.principal?.roles).toEqual(["member"]);
    expect(subject.principal?.tenant).toBe("org-1");
    expect(subject.principal?.memberships).toEqual([
      { tenant: "org-1", roles: ["admin"] },
    ]);
    expect(subject.principal?.assurance).toEqual({ acr: "aal2" });
    expect(subject.session).toBe("sess-1");
    expect(subject.principal?.claims).toMatchObject({ plan: "pro" });
    expect(subject.principal?.claims).not.toHaveProperty("role");
  });

  it("keeps the member group of a membership, and drops an empty one", () => {
    const subject = subjectFromSupabase({
      sub: "user-6",
      role: "authenticated",
      memberships: [
        { tenant: "org-1", roles: ["nurse"], member: { group: "night" } },
        { tenant: "org-2", roles: ["nurse"], member: { group: "" } },
      ],
    });
    expect(subject.principal?.memberships).toEqual([
      { tenant: "org-1", roles: ["nurse"], member: { group: "night" } },
      { tenant: "org-2", roles: ["nurse"] },
    ]);
  });

  it("maps resource-scoped memberships from the hook claim", () => {
    const subject = subjectFromSupabase({
      sub: "user-5",
      role: "authenticated",
      memberships: [
        { on: { resource: "document", id: "d_1" }, roles: ["editor"] },
      ],
    });
    expect(subject.principal?.memberships).toEqual([
      { on: { resource: "document", id: "d_1" }, roles: ["editor"] },
    ]);
  });

  it("reads hook claims from app_metadata when top-level is absent", () => {
    const subject = subjectFromSupabase(
      {
        sub: "user-2",
        role: "authenticated",
        app_metadata: {
          user_role: ["editor", "unknown"],
          tenant_id: "org-2",
        },
      },
      { declared: ["editor"] },
    );
    expect(subject.principal?.roles).toEqual(["editor"]);
    expect(subject.principal?.tenant).toBe("org-2");
  });

  it("treats a null top-level claim as absent and falls back to app_metadata", () => {
    const subject = subjectFromSupabase({
      sub: "user-3",
      role: "authenticated",
      user_role: null,
      tenant_id: null,
      app_metadata: { user_role: "editor", tenant_id: "org-3" },
    });
    expect(subject.principal?.roles).toEqual(["editor"]);
    expect(subject.principal?.tenant).toBe("org-3");
    expect(
      subjectFromSupabase({
        sub: "user-4",
        role: "authenticated",
        app_metadata: { user_role: null },
      }).principal?.roles,
    ).toEqual([]);
  });

  it("maps only user sessions from a structural session object", () => {
    const claims = {
      sub: "user-6",
      role: "authenticated",
      user_role: "editor",
    };
    expect(
      subjectFromSupabaseSession({ kind: "user", claims }).principal?.roles,
    ).toEqual(["editor"]);
    expect(
      subjectFromSupabaseSession({ kind: "anon", claims }).principal,
    ).toBeNull();
    expect(
      subjectFromSupabaseSession({ kind: "service" }).principal,
    ).toBeNull();
    expect(subjectFromSupabaseSession(undefined).principal).toBeNull();
  });

  it("returns anonymous for missing, anon, and service_role claims", () => {
    expect(subjectFromSupabase(undefined).principal).toBeNull();
    expect(
      subjectFromSupabase({ role: "anon", sub: "x" }).principal,
    ).toBeNull();
    expect(
      subjectFromSupabase({ role: "service_role", sub: "x" }).principal,
    ).toBeNull();
    expect(subjectFromSupabase({ role: "authenticated" }).principal).toBeNull();
  });

  it("drops custom claims when the schema fails", () => {
    const subject = subjectFromSupabase(
      {
        sub: "user-3",
        role: "authenticated",
        app_metadata: { plan: 1 },
      },
      { schema: z.object({ plan: z.string() }) },
    );
    expect(subject.principal?.id).toBe("user-3");
    expect(subject.principal?.claims).toBeUndefined();
  });

  it("exposes include fields only when asked", () => {
    const subject = subjectFromSupabase(
      {
        sub: "user-4",
        role: "authenticated",
        email: "a@b.c",
        phone: "1",
        is_anonymous: false,
      },
      { include: ["email"] },
    );
    expect(subject.principal?.email).toBe("a@b.c");
    expect(subject.principal?.phone).toBeUndefined();
  });

  it("reports each membership entry it drops", () => {
    const events: AuthEvent[] = [];
    const subject = subjectFromSupabase(
      {
        sub: "user-5",
        role: "authenticated",
        memberships: [
          { scope: "tenant", id: "org-1", roles: ["admin"] },
          { org_id: "org-2", role: "admin" },
          { tenant: "org-3", roles: [] },
        ],
      },
      {
        onAuth: (event) => {
          events.push(event);
        },
      },
    );
    expect(subject.principal?.memberships).toEqual([
      { scope: "tenant", id: "org-1", roles: ["admin"] },
    ]);
    expect(events).toEqual([
      { reason: "schema", cause: "membership-dropped", source: "supabase" },
    ]);
  });

  it("reads plans from the active tenant's entry only", () => {
    const claims = {
      sub: "user-6",
      role: "authenticated",
      tenant_id: "org-1",
      features: { "org-1": ["pro", "sso"], "org-2": ["enterprise"] },
    };
    expect(
      subjectFromSupabase(claims, { plans: "features" }).principal?.plans,
    ).toEqual(["pro", "sso"]);
    expect(subjectFromSupabase(claims).principal?.plans).toBeUndefined();
    const { tenant_id: _, ...noTenant } = claims;
    expect(
      subjectFromSupabase(noTenant, { plans: "features" }).principal?.plans,
    ).toBeUndefined();
  });

  it("maps act and client_id to an oauth-client actor with scope as delegation", () => {
    const base = { sub: "user-7", role: "authenticated" };
    const client = subjectFromSupabase({
      ...base,
      client_id: "app-1",
      scope: "openid invoice:read",
    });
    expect(client.principal?.id).toBe("user-7");
    expect(client.actor).toEqual({ id: "app-1", kind: "oauth-client" });
    expect(client.delegation).toEqual({ scopes: ["invoice:read"] });
    expect(client.principal?.claims).toBeUndefined();

    const act = { sub: "agent-1", act: { sub: "agent-2" } };
    const chained = subjectFromSupabase({ ...base, act, client_id: "app-1" });
    expect(chained.actor).toEqual({ id: "agent-1", kind: "oauth-client" });
    expect(chained.delegation).toEqual({ chain: act });

    const events: AuthEvent[] = [];
    const broken = subjectFromSupabase(
      { ...base, act: { act: "nope" } },
      {
        onAuth: (event) => {
          events.push(event);
        },
      },
    );
    expect(broken.principal).toBeNull();
    expect(events).toMatchObject([{ cause: "invalid-chain" }]);

    expect(subjectFromSupabase(base).actor).toBeUndefined();
  });

  it("denies a third-party client whose scope does not delegate the permission", async () => {
    const permissions = definePermissions({
      invoice: resource({ collection: ["read"] }),
    });
    const roles = defineRoles({ member: {} });
    const policy = definePolicy(
      { permissions, roles },
      {
        subject: (claims: unknown) => subjectFromSupabase(claims).principal,
        grants: [allow(permissions.invoice.read, { to: roles.member })],
      },
    );
    const base = { sub: "user-8", role: "authenticated", user_role: "member" };
    const permdock = async (
      claims: Record<string, unknown>,
    ): Promise<boolean> =>
      (await createPermDock(policy, subjectFromSupabase(claims))).can(
        permissions.invoice.read,
      );
    expect(await permdock(base)).toBe(true);
    expect(await permdock({ ...base, client_id: "app-1" })).toBe(false);
    expect(
      await permdock({ ...base, client_id: "app-1", scope: "invoice:read" }),
    ).toBe(true);
  });
});

describe("supabaseRls and authorizeSql", () => {
  it("wraps a single memberships table as the tenant mapping", () => {
    const config = supabaseRls({
      memberships: {
        table: "organization_members",
        tenant: "organization_id",
        user: "user_id",
        role: "role",
      },
    });
    expect(config.dialect).toBe("supabase");
    expect(config.memberships?.tenant?.table).toBe("organization_members");
  });

  it("emits authorize() that denies tenant requests without a memberships source", () => {
    const sql = authorizeSql({ tenant: true });
    expect(sql).toContain("requested_tenant text default null");
    expect(sql).toContain("security definer");
    expect(sql).toContain("set search_path = ''");
    expect(sql).toMatch(/if requested_tenant is not null then\s+return false;/);
    expect(sql).not.toContain("perform requested_tenant");
    expect(sql).not.toMatch(/service_role/);
  });

  it("reads the memberships table or the hook claims for tenant requests", () => {
    const database = authorizeSql({
      schema: "app",
      tenant: {
        table: "organization_members",
        tenant: "organization_id",
        user: "user_id",
        role: "role",
      },
    });
    expect(database).toContain('create or replace function "app"."authorize"(');
    expect(database).toContain('m."organization_id" = v_member_tenant');
    expect(database).toContain("rp.permission = requested_permission::text");
    expect(database).toContain("and rp.scope = 'tenant'");
    expect(database).toContain("and rp.effect = 'allow'");
    const jwt = authorizeSql({ authorize: "jwt" });
    expect(jwt).toContain("claims -> 'memberships'");
    expect(jwt).toContain("nullif(claims -> 'user_role', 'null'::jsonb)");
    expect(jwt).not.toContain("user_roles");
    expect(() => authorizeSql({ schema: "app; drop" })).toThrow(TypeError);
  });

  it("answers tenant requests from custom roles only when asked", () => {
    const tenant = {
      table: "organization_members",
      tenant: "organization_id",
      user: "user_id",
      role: "role",
    };
    expect(authorizeSql({ tenant })).not.toContain("permdock_custom_keys");
    const database = authorizeSql({
      tenant,
      customRoles: { declared: ["admin", "o'wner"] },
    });
    expect(database).toContain('"permdock"."custom_role_permissions" c');
    expect(database).toContain('"permdock"."custom_role_includes" c');
    expect(database).toContain("any(array['admin', 'o''wner']::text[])");
    expect(database).toContain('"permdock"."permdock_custom_keys"(');
    const jwt = authorizeSql({
      authorize: "jwt",
      customRoles: { declared: [] },
    });
    expect(jwt).toContain("(select m -> 'grants' -> r.role as g) cg");
    expect(jwt).toContain("where m ->> 'scope' = 'tenant'");
    expect(
      authorizeSql({
        authorize: "jwt",
        scope: "organization",
        customRoles: { declared: [] },
      }),
    ).toContain("rp.scope = 'organization'");
    expect(() => authorizeSql({ scope: "bad scope" })).toThrow(/unsafe scope/);
    expect(jwt).toContain("any('{}'::text[])");
    expect(jwt).not.toContain("custom_role_permissions");
  });
});

describe("subjectFromSupabase with Supabase OAuth server tokens", () => {
  const Invoice = z.object({ id: z.string() });
  const permissions = definePermissions({
    invoice: resource(Invoice, { id: "id", actions: ["read", "pay"] }),
  });
  const grants = [allow([permissions.invoice.read, permissions.invoice.pay])];
  const claims = {
    sub: "user-7",
    role: "authenticated",
    user_role: "member",
    client_id: "first-party-cli",
    scope: "openid email profile phone",
  };
  const invoice = { id: "i1" };

  it("reads the OpenID Connect identity scopes as no delegation", async () => {
    const subject = subjectFromSupabase(claims);
    expect(subject.actor).toEqual({
      id: "first-party-cli",
      kind: "oauth-client",
    });
    expect(subject.delegation).toBeUndefined();
    const policy = definePolicy(permissions, {
      roles: [role("member", grants)],
      subject: (user: { readonly id: string }) => user,
    });
    const decision = (await createPermDock(policy, subject)).decide(
      permissions.invoice.read,
      invoice,
    );
    expect(decision.outcome).toBe("denied");
    expect(decision.outcome === "denied" && decision.denials[0]?.reason).toBe(
      "no-delegation",
    );
  });

  it("lets a policy delegation for the client act within its ceiling", async () => {
    const policy = definePolicy(permissions, {
      roles: [role("member", grants)],
      subject: (user: { readonly id: string }) => user,
      delegations: [
        {
          from: "member",
          to: { kind: "oauth-client", id: "first-party-cli" },
          permissions: [permissions.invoice.read],
        },
      ],
    });
    const permdock = await createPermDock(policy, subjectFromSupabase(claims));
    expect(permdock.can(permissions.invoice.read, invoice)).toBe(true);
    expect(permdock.can(permissions.invoice.pay, invoice)).toBe(false);
    const other = await createPermDock(
      policy,
      subjectFromSupabase({ ...claims, client_id: "third-party" }),
    );
    expect(other.can(permissions.invoice.read, invoice)).toBe(false);
    const scoped = await createPermDock(
      policy,
      subjectFromSupabase({ ...claims, scope: "openid invoice.pay" }),
    );
    expect(scoped.can(permissions.invoice.read, invoice)).toBe(false);
  });
});
