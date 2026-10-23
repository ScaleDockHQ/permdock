import { describe, expect, it } from "vitest";

import type { SupabaseRpcClient } from "../../src/supabase/index.ts";

import {
  claimsFirst,
  getPermDock,
  memoryVersionCache,
} from "../../src/index.ts";
import {
  postgrestSources,
  subjectFromSupabase,
} from "../../src/supabase/index.ts";
import { permissions, policy } from "../fixtures/named-scopes.ts";

const NOW = 1_800_000_000;

function database(held: { roles: string[]; version: number; down?: boolean }) {
  const calls: string[] = [];
  const client: SupabaseRpcClient = {
    schema() {
      return {
        async rpc(fn) {
          calls.push(fn);
          if (held.down === true) {
            return { data: null, error: { message: "down" } };
          }
          if (fn === "permdock_authz_version_for") {
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
  return { calls, client };
}

function claims(iat: number) {
  return {
    sub: "u1",
    role: "authenticated",
    iat,
    user_role: ["platform-admin"],
    memberships: [],
    authz_ver: 3,
  };
}

function setup(held: { roles: string[]; version: number; down?: boolean }) {
  const { calls, client } = database(held);
  const sources = postgrestSources(client, { api: {} });
  const memberships = claimsFirst(sources.memberships, {
    onStale: "reread",
    versions: memoryVersionCache({
      maxStaleMs: 5000,
      now: () => ({ epochMilliseconds: NOW * 1000 }),
    }),
  });
  return { calls, memberships };
}

const versionCalls = (calls: readonly string[]) =>
  calls.filter((fn) => fn === "permdock_authz_version_for").length;

describe("Supabase freshness", () => {
  it("maps iat to issuedAt", () => {
    expect(subjectFromSupabase(claims(NOW)).issuedAt).toBe(NOW);
    expect(
      subjectFromSupabase({ ...claims(NOW), iat: "x" }).issuedAt,
    ).toBeUndefined();
  });

  it("makes no RPC for a token minted within maxStaleMs", async () => {
    const { calls, memberships } = setup({
      roles: ["platform-admin"],
      version: 3,
    });
    const permdock = await getPermDock(
      policy,
      subjectFromSupabase(claims(NOW - 2)),
      { memberships, intent: "read" },
    );
    expect(calls).toStrictEqual([]);
    expect(permdock.can(permissions.organization.list)).toBe(true);
  });

  it("makes one version RPC for an older token and none after", async () => {
    const { calls, memberships } = setup({
      roles: ["platform-admin"],
      version: 3,
    });
    for (let index = 0; index < 5; index += 1) {
      await getPermDock(policy, subjectFromSupabase(claims(NOW - 3600)), {
        memberships,
        intent: "read",
      });
    }
    expect(versionCalls(calls)).toBe(1);
  });

  it("denies a revoked platform role on a write at once", async () => {
    const { calls, memberships } = setup({ roles: [], version: 4 });
    const reader = await getPermDock(
      policy,
      subjectFromSupabase(claims(NOW - 2)),
      { memberships, intent: "read" },
    );
    expect(reader.can(permissions.organization.list)).toBe(true);
    const writer = await getPermDock(
      policy,
      subjectFromSupabase(claims(NOW - 2)),
      { memberships, intent: "write" },
    );
    expect(versionCalls(calls)).toBe(1);
    expect(writer.can(permissions.organization.list)).toBe(false);
  });

  it("caches nothing when the RPC errors", async () => {
    const { calls, memberships } = setup({ roles: [], version: 3, down: true });
    for (let index = 0; index < 2; index += 1) {
      await getPermDock(policy, subjectFromSupabase(claims(NOW - 3600)), {
        memberships,
        intent: "read",
      });
    }
    expect(versionCalls(calls)).toBe(2);
  });
});
