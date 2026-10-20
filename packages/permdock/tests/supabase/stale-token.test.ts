import { describe, expect, it } from "vitest";

import type { SupabaseRpcClient } from "../../src/supabase/index.ts";

import {
  claimsFirst,
  composeMemberships,
  getPermDock,
} from "../../src/index.ts";
import { postgrestSources } from "../../src/supabase/index.ts";
import { permissions, policy } from "../fixtures/named-scopes.ts";

type Held = { roles: string[]; version: number };

function client(held: Held): SupabaseRpcClient {
  return {
    schema() {
      return {
        async rpc(fn) {
          if (fn === "authz_version_for") {
            return { data: held.version, error: null };
          }
          return {
            data: {
              id: "u1",
              active: true,
              roles: held.roles,
              memberships: [],
              customRoles: [],
              authzVersion: held.version,
            },
            error: null,
          };
        },
      };
    },
  };
}

const stale = {
  id: "u1",
  roles: ["platform-admin"],
  memberships: [],
  authzVersion: 1,
};

function token(extra: Record<string, unknown> = {}) {
  return { principal: stale, context: {}, ...extra };
}

describe("a stale token and global roles", () => {
  it("drops a revoked platform role when the token is behind", async () => {
    const sources = postgrestSources(client({ roles: [], version: 2 }));
    const permdock = await getPermDock(policy, token(), {
      memberships: claimsFirst(sources.memberships, { onStale: "reread" }),
    });
    expect(permdock.can(permissions.organization.list)).toBe(false);
    expect(permdock.subject.principal?.roles).toEqual([]);
  });

  it("keeps the global roles of a current token and of a still-held role", async () => {
    const fresh = await getPermDock(policy, token(), {
      memberships: claimsFirst(
        postgrestSources(client({ roles: [], version: 1 })).memberships,
        { onStale: "reread" },
      ),
    });
    expect(fresh.can(permissions.organization.list)).toBe(true);
    const held = await getPermDock(policy, token(), {
      memberships: claimsFirst(
        postgrestSources(client({ roles: ["platform-admin"], version: 2 }))
          .memberships,
        { onStale: "reread" },
      ),
    });
    expect(held.can(permissions.organization.list)).toBe(true);
  });

  it("leaves no global role when the live read throws", async () => {
    const sources = postgrestSources(client({ roles: [], version: 2 }));
    const throwing = {
      ...sources.memberships,
      globalRolesFor: () => Promise.reject(new Error("down")),
    };
    const permdock = await getPermDock(policy, token(), {
      memberships: claimsFirst(throwing, { onStale: "reread" }),
    });
    expect(permdock.can(permissions.organization.list)).toBe(false);
  });

  it("keeps an OAuth client's delegation ceiling on a stale token", async () => {
    const sources = postgrestSources(
      client({ roles: ["platform-admin"], version: 2 }),
    );
    const delegation = { scopes: [permissions.quote.read.scope] };
    const delegated = token({
      actor: { id: "client-1", kind: "oauth-client" },
      delegation,
    });
    const viaClaimsFirst = await getPermDock(policy, delegated, {
      memberships: claimsFirst(sources.memberships, { onStale: "reread" }),
    });
    expect(viaClaimsFirst.can(permissions.organization.list)).toBe(false);
    const refreshed = await sources.refresh({
      ...delegated,
      principal: stale,
    });
    expect(refreshed.actor?.id).toBe("client-1");
    expect(refreshed.delegation).toEqual(delegation);
    const viaRefresh = await getPermDock(policy, refreshed);
    expect(viaRefresh.can(permissions.organization.list)).toBe(false);
    const rebuilt = await getPermDock(policy, await sources.subject("u1"));
    expect(rebuilt.can(permissions.organization.list)).toBe(true);
  });

  it("refresh rereads the principal and answers no principal for a suspended user", async () => {
    const sources = postgrestSources(client({ roles: [], version: 2 }));
    const refreshed = await sources.refresh(token({ session: "s1" }));
    expect(refreshed.principal?.roles).toEqual([]);
    expect(refreshed.principal?.authzVersion).toBe(2);
    expect(refreshed.session).toBe("s1");
    const gone = postgrestSources({
      schema: () => ({
        rpc: async () => ({ data: { id: "u1", active: false }, error: null }),
      }),
    });
    const none = await gone.refresh(
      token({ actor: { id: "c", kind: "oauth-client" } }),
    );
    expect(none.principal).toBeNull();
    expect(none.actor?.id).toBe("c");
    const anonymous = { principal: null, context: {} };
    expect(await sources.refresh(anonymous)).toBe(anonymous);
  });
});

describe("globalRolesFor", () => {
  it("composes as the union of the sources and survives claimsFirst", async () => {
    const one = {
      membershipsFor: () => [],
      globalRolesFor: () => ["a"],
    };
    const two = {
      membershipsFor: () => [],
      globalRolesFor: async () => ["a", "b"],
    };
    const none = { membershipsFor: () => [] };
    const composed = composeMemberships([one, two, none]);
    expect(await composed.globalRolesFor?.({ id: "u" })).toEqual(["a", "b"]);
    expect(claimsFirst(none).globalRolesFor).toBeUndefined();
    expect(await claimsFirst(composed).globalRolesFor?.({ id: "u" })).toEqual([
      "a",
      "b",
    ]);
    expect(composeMemberships([none]).globalRolesFor).toBeUndefined();
  });
});
