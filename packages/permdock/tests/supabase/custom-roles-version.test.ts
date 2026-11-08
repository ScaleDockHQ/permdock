import { describe, expect, it } from "vitest";

import type { SupabaseRpcClient } from "../../src/supabase/index.ts";

import {
  claimsFirst,
  getPermDock,
  memorySubjectCache,
} from "../../src/index.ts";
import { postgrestSources } from "../../src/supabase/index.ts";
import { permissions, policy } from "../fixtures/named-scopes.ts";

type Database = {
  user: number;
  roles: number;
  grants: { permission: string }[];
};

const asset = { id: "a1", organization_id: "acme", customer_id: "c1" };

/** A database with one tenant custom role and a call log per function. */
function database(db: Database): {
  readonly client: SupabaseRpcClient;
  readonly calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    client: {
      schema() {
        return {
          async rpc(fn) {
            calls.push(fn);
            if (fn === "authz_version_for") {
              return { data: db.user, error: null };
            }
            if (fn === "custom_roles_version_for") {
              return { data: db.roles, error: null };
            }
            return {
              data: {
                id: "u1",
                active: true,
                roles: [],
                memberships: [
                  {
                    scope: "organization",
                    id: "acme",
                    roles: ["auditor"],
                    via: "staff",
                  },
                ],
                customRoles: [
                  {
                    name: "auditor",
                    tenant: "acme",
                    scope: "organization",
                    grants: db.grants,
                  },
                ],
                customRolesVersions: { acme: db.roles },
                authzVersion: db.user,
              },
              error: null,
            };
          },
        };
      },
    },
  };
}

const reads = (calls: readonly string[], name: string): number =>
  calls.filter((call) => call === name).length;

function token(version: { user: number; roles?: number }, truncated = false) {
  return {
    principal: {
      id: "u1",
      tenant: "acme",
      memberships: truncated
        ? []
        : [
            {
              scope: "organization",
              id: "acme",
              roles: ["auditor"],
              via: "staff",
            },
          ],
      ...(truncated ? { membershipsTruncated: true } : {}),
      authzVersion: version.user,
      ...(version.roles === undefined
        ? {}
        : { customRolesVersion: version.roles }),
    },
    context: {},
  };
}

async function check(
  sources: ReturnType<typeof postgrestSources>,
  user: ReturnType<typeof token>,
): Promise<boolean> {
  const permdock = await getPermDock(policy, user, {
    tenant: "acme",
    memberships: claimsFirst(sources.memberships, { onStale: "reread" }),
    customRoles: sources.customRoles(user.principal),
  });
  return permdock.can(permissions.asset.read, asset);
}

describe("a token that holds a custom role", () => {
  it("keeps its memberships when both versions hold, and reads the roles once", async () => {
    const { client, calls } = database({
      user: 4,
      roles: 7,
      grants: [{ permission: "asset.read" }],
    });
    const sources = postgrestSources(client, { policy });
    expect(await check(sources, token({ user: 4, roles: 7 }))).toBe(true);
    expect(reads(calls, "authz_version_for")).toBe(1);
    expect(reads(calls, "custom_roles_version_for")).toBe(1);
    expect(reads(calls, "subject_for")).toBe(1);
  });

  it("reads no subject_for on the second request, from the version-keyed cache", async () => {
    const { client, calls } = database({
      user: 4,
      roles: 7,
      grants: [{ permission: "asset.read" }],
    });
    const sources = postgrestSources(client, {
      policy,
      subjects: memorySubjectCache(),
    });
    await check(sources, token({ user: 4, roles: 7 }));
    expect(await check(sources, token({ user: 4, roles: 7 }))).toBe(true);
    expect(reads(calls, "subject_for")).toBe(1);
  });

  it("serves no stale grants once an edit raised the tenant version", async () => {
    const db: Database = {
      user: 4,
      roles: 7,
      grants: [{ permission: "asset.read" }],
    };
    const { client, calls } = database(db);
    const sources = postgrestSources(client, {
      policy,
      subjects: memorySubjectCache(),
    });
    expect(await check(sources, token({ user: 4, roles: 7 }))).toBe(true);
    db.grants = [];
    db.roles = 8;
    expect(await check(sources, token({ user: 4, roles: 8 }))).toBe(false);
    expect(reads(calls, "subject_for")).toBe(2);
  });

  it("reads the live subject when the token's tenant version is behind", async () => {
    const { client, calls } = database({
      user: 4,
      roles: 8,
      grants: [{ permission: "asset.read" }],
    });
    const sources = postgrestSources(client, { policy });
    expect(await check(sources, token({ user: 4, roles: 7 }))).toBe(true);
    expect(reads(calls, "subject_for")).toBe(1);
    expect(reads(calls, "custom_roles_version_for")).toBe(1);
  });

  it("is read live when the token carries no tenant version, as before", async () => {
    const { client, calls } = database({
      user: 4,
      roles: 7,
      grants: [{ permission: "asset.read" }],
    });
    const sources = postgrestSources(client, { policy });
    expect(await check(sources, token({ user: 4 }))).toBe(true);
    expect(reads(calls, "subject_for")).toBe(1);
  });
});

describe("a truncated token", () => {
  it("reads the version, then the subject through the cache", async () => {
    const { client, calls } = database({
      user: 4,
      roles: 7,
      grants: [{ permission: "asset.read" }],
    });
    const sources = postgrestSources(client, {
      policy,
      subjects: memorySubjectCache(),
    });
    expect(await check(sources, token({ user: 4, roles: 7 }, true))).toBe(true);
    expect(await check(sources, token({ user: 4, roles: 7 }, true))).toBe(true);
    expect(reads(calls, "subject_for")).toBe(1);
    expect(reads(calls, "authz_version_for")).toBe(2);
  });
});
