import { describe, expect, it } from "vitest";

import type { SupabaseRpcClient } from "../../src/supabase/index.ts";

import { claimsFirst, countHolders, createPermDock } from "../../src/index.ts";
import { postgrestSources } from "../../src/supabase/index.ts";
import { permissions, policy } from "../fixtures/named-scopes.ts";

function fakeClient(
  records: Readonly<Record<string, unknown>>,
  calls: string[] = [],
): SupabaseRpcClient {
  return {
    schema(name) {
      return {
        async rpc(fn, args) {
          calls.push(`${name}.${fn}(${String(args["p_user"])})`);
          if (args["p_user"] === "broken") {
            return { data: null, error: { message: "boom" } };
          }
          return { data: records[String(args["p_user"])] ?? null, error: null };
        },
      };
    },
  };
}

const owner = {
  id: "u1",
  active: true,
  roles: ["support"],
  memberships: [
    { scope: "organization", id: "acme", roles: ["auditor"], via: "staff" },
    { scope: "nope" },
  ],
  customRoles: [
    {
      name: "auditor",
      tenant: "acme",
      scope: "organization",
      grants: [
        { permission: "asset.read" },
        { permission: "x", effect: "deny" },
      ],
    },
    {
      name: "helpdesk",
      scope: "global",
      grants: [{ permission: "organization.read" }],
    },
    { name: "broken", grants: [] },
  ],
  authzVersion: 4,
};

describe("postgrestSources", () => {
  it("reads one record per user and builds the subject the hook would mint", async () => {
    const calls: string[] = [];
    const sources = postgrestSources(fakeClient({ u1: owner }, calls), {
      schema: "api",
      fn: "permdock_subject_for",
    });
    const subject = await sources.subject("u1");
    expect(subject.principal).toEqual({
      id: "u1",
      roles: ["support"],
      memberships: [
        { scope: "organization", id: "acme", roles: ["auditor"], via: "staff" },
      ],
      authzVersion: 4,
    });
    const roles = sources.customRoles({ id: "u1" });
    expect(await roles.rolesFor("acme")).toEqual([
      {
        name: "auditor",
        tenant: "acme",
        scope: "organization",
        grants: [
          { permission: "asset.read", effect: "allow" },
          { permission: "x", effect: "deny" },
        ],
      },
    ]);
    expect(await roles.globalRoles?.()).toEqual([
      {
        name: "helpdesk",
        scope: "global",
        grants: [{ permission: "organization.read", effect: "allow" }],
      },
    ]);
    expect(await sources.memberships.version?.({ id: "u1" })).toBe(4);
    expect(calls).toEqual(["api.permdock_subject_for(u1)"]);
  });

  it("answers an unknown or suspended user with no subject and no memberships", async () => {
    const sources = postgrestSources(
      fakeClient({ u2: { id: "u2", active: false, roles: ["admin"] } }),
    );
    expect((await sources.subject("u2")).principal).toBeNull();
    expect((await sources.subject("u3")).principal).toBeNull();
    expect(await sources.memberships.membershipsFor({ id: "u2" }, {})).toEqual(
      [],
    );
    expect(await sources.customRoles({ id: "u2" }).rolesFor("acme")).toEqual(
      [],
    );
  });

  it("rejects when the function fails, which createPermDock turns into a denial", async () => {
    const sources = postgrestSources(fakeClient({}));
    await expect(sources.subject("broken")).rejects.toThrow(
      "PermDock: permdock.subject_for failed: boom",
    );
  });

  it("checks a token's freshness with authz_version_for and reads the subject only when it is behind", async () => {
    const viewer = {
      id: "u1",
      active: true,
      roles: [],
      memberships: [
        { scope: "organization", id: "acme", roles: ["viewer"], via: "staff" },
      ],
      customRoles: [],
      authzVersion: 4,
    };
    const asset = { id: "a1", organization_id: "acme", customer_id: "c1" };
    const canRead = async (
      tokenVersion: number,
      versionFn?: string,
    ): Promise<{ readonly allowed: boolean; readonly calls: string[] }> => {
      const calls: string[] = [];
      const client: SupabaseRpcClient = {
        schema(name) {
          return {
            async rpc(fn, args) {
              calls.push(`${name}.${fn}(${String(args["p_user"])})`);
              if (fn === "authz_version_for") {
                return { data: 4, error: null };
              }
              if (fn === "subject_for") {
                return { data: viewer, error: null };
              }
              return { data: null, error: { message: "missing" } };
            },
          };
        },
      };
      const sources = postgrestSources(
        client,
        versionFn === undefined ? {} : { versionFn },
      );
      const permdock = await createPermDock(
        policy,
        {
          principal: { id: "u1", memberships: [], authzVersion: tokenVersion },
          context: {},
        },
        {
          memberships: claimsFirst(sources.memberships, { onStale: "reread" }),
        },
      );
      return {
        allowed: permdock.tenant("acme").can(permissions.asset.read, asset),
        calls,
      };
    };
    expect(await canRead(4)).toEqual({
      allowed: false,
      calls: ["permdock.authz_version_for(u1)"],
    });
    expect(await canRead(3)).toEqual({
      allowed: true,
      calls: ["permdock.authz_version_for(u1)", "permdock.subject_for(u1)"],
    });
    expect(await canRead(4, "absent_version_for")).toEqual({
      allowed: false,
      calls: ["permdock.absent_version_for(u1)", "permdock.subject_for(u1)"],
    });
  });

  it("feeds createPermDock for an acting user", async () => {
    const sources = postgrestSources(fakeClient({ u1: owner }));
    const subject = await sources.subject("u1");
    const permdock = await createPermDock(policy, subject, {
      customRoles: sources.customRoles({ id: "u1" }),
      memberships: claimsFirst(sources.memberships),
    });
    expect(
      permdock.tenant("acme").can(permissions.asset.read, {
        id: "a1",
        organization_id: "acme",
        customer_id: "c1",
      }),
    ).toBe(true);
    expect(
      permdock.tenant("acme").can(permissions.asset.update, {
        id: "a1",
        organization_id: "acme",
        customer_id: "c1",
      }),
    ).toBe(false);
  });

  it("lists the members of one instance through members_of, once per instance, for countHolders", async () => {
    const calls: string[] = [];
    const client: SupabaseRpcClient = {
      schema(name) {
        return {
          async rpc(fn, args) {
            calls.push(
              `${name}.${fn}(${String(args["p_scope"])}, ${String(args["p_id"])})`,
            );
            if (args["p_id"] === "broken") {
              return { data: null, error: { message: "boom" } };
            }
            return {
              data: [
                {
                  principal: { id: "u1" },
                  membership: {
                    scope: "organization",
                    id: "acme",
                    roles: ["owner"],
                    via: "staff",
                  },
                },
                {
                  principal: { id: "u2" },
                  membership: {
                    scope: "organization",
                    id: "acme",
                    roles: ["owner", "admin"],
                  },
                },
                { principal: { id: "" }, membership: { roles: ["owner"] } },
                { principal: { id: "u3" }, membership: { scope: "x" } },
                "junk",
              ],
              error: null,
            };
          },
        };
      },
    };
    const sources = postgrestSources(client, { membersFn: "list_members" });
    const query = { scope: "organization", id: "acme" };
    expect(await sources.memberships.list(query)).toEqual([
      {
        principal: { id: "u1" },
        membership: {
          scope: "organization",
          id: "acme",
          roles: ["owner"],
          via: "staff",
        },
      },
      {
        principal: { id: "u2" },
        membership: {
          scope: "organization",
          id: "acme",
          roles: ["owner", "admin"],
        },
      },
    ]);
    expect(
      await countHolders(claimsFirst(sources.memberships), {
        ...query,
        role: "owner",
      }),
    ).toBe(2);
    expect(calls).toEqual(["permdock.list_members(organization, acme)"]);
    await expect(
      sources.memberships.list({ scope: "organization", id: "broken" }),
    ).rejects.toThrow("PermDock: permdock.list_members failed: boom");
    expect(
      await postgrestSources({
        schema: () => ({
          rpc: async () => ({ data: null, error: null }),
        }),
      }).memberships.list(query),
    ).toEqual([]);
    expect(
      await countHolders(sources.memberships, {
        scope: "organization",
        id: "broken",
        role: "owner",
      }),
    ).toBeUndefined();
  });
});
