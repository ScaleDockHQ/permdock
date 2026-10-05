import { describe, expect, it } from "vitest";

import type { SupabaseRpcClient } from "../../src/supabase/index.ts";

import { claimsFirst, createPermDock } from "../../src/index.ts";
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
});
