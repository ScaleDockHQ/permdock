import { describe, expect, it } from "vitest";

import type { SupabaseRpcClient } from "../../src/supabase/index.ts";

import { claimsFirst, getPermDock } from "../../src/index.ts";
import { postgrestSources } from "../../src/supabase/index.ts";
import { permissions, policy } from "../fixtures/named-scopes.ts";

type Held = { roles: string[]; version: number };

function database(held: Held) {
  const calls: string[] = [];
  const client: SupabaseRpcClient = {
    schema() {
      return {
        async rpc(fn) {
          calls.push(fn);
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
  return { calls, client };
}

const token = {
  principal: {
    id: "u1",
    roles: ["platform-admin"],
    memberships: [],
    authzVersion: 1,
  },
  context: {},
};

describe("sources at module scope", () => {
  it("reads subject_for once per instance and never reuses it in the next", async () => {
    const held: Held = { roles: ["platform-admin"], version: 2 };
    const { calls, client } = database(held);
    const sources = postgrestSources(client);
    const memberships = claimsFirst(sources.memberships, { onStale: "reread" });
    const first = await getPermDock(policy, token, {
      memberships,
      customRoles: sources.customRoles({ id: "u1" }),
    });
    expect(first.can(permissions.organization.list)).toBe(true);
    expect(calls.filter((fn) => fn === "subject_for")).toHaveLength(1);
    held.roles = [];
    held.version = 3;
    const second = await getPermDock(policy, token, {
      memberships,
      customRoles: sources.customRoles({ id: "u1" }),
    });
    expect(second.can(permissions.organization.list)).toBe(false);
    expect(calls.filter((fn) => fn === "subject_for")).toHaveLength(2);
    expect(calls.filter((fn) => fn === "authz_version_for")).toHaveLength(2);
  });

  it("reads the record directly outside an instance", async () => {
    const held: Held = { roles: [], version: 2 };
    const { calls, client } = database(held);
    const sources = postgrestSources(client);
    await sources.record("u1");
    await sources.record("u1");
    expect(calls).toStrictEqual(["subject_for", "subject_for"]);
  });
});
