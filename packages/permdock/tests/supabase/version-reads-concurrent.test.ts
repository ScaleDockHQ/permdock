import { describe, expect, it } from "vitest";

import type { SupabaseRpcClient } from "../../src/supabase/index.ts";

import { sourceMemo } from "../../src/core/source-memo.ts";
import {
  customRoleSource,
  getPermDock,
  memorySubjectCache,
} from "../../src/index.ts";
import { postgrestSources } from "../../src/supabase/index.ts";
import { permissions, policy } from "../fixtures/named-scopes.ts";

const TENANTS = ["o1", "o2", "o3", "o4", "o5"];
const tenantOf = (args: unknown): string =>
  typeof args === "object" && args !== null
    ? String(Reflect.get(args, "p_tenant"))
    : "";
const version = (tenant: string) => 10 + TENANTS.indexOf(tenant);

function database(): {
  readonly client: SupabaseRpcClient;
  readonly calls: { readonly fn: string; readonly args: unknown }[];
} {
  const calls: { readonly fn: string; readonly args: unknown }[] = [];
  return {
    calls,
    client: {
      schema() {
        return {
          async rpc(fn, args) {
            calls.push({ fn, args });
            const tenant = tenantOf(args);
            if (fn === "authz_versions_for") {
              return {
                data: { authz: 4, custom_roles: version(tenant) },
                error: null,
              };
            }
            if (fn === "authz_version_for") {
              return { data: 4, error: null };
            }
            if (fn === "custom_roles_version_for") {
              return { data: version(tenant), error: null };
            }
            return {
              data: {
                id: "u1",
                active: true,
                roles: [],
                memberships: TENANTS.map((id) => ({
                  scope: "organization",
                  id,
                  roles: ["auditor"],
                })),
                customRoles: TENANTS.map((id) => ({
                  name: "auditor",
                  tenant: id,
                  scope: "organization",
                  grants: [{ permission: "asset.read" }],
                })),
                customRolesVersions: Object.fromEntries(
                  TENANTS.map((id) => [id, version(id)]),
                ),
                authzVersion: 4,
              },
              error: null,
            };
          },
        };
      },
    },
  };
}

const principal = {
  id: "u1",
  memberships: TENANTS.map((id) => ({
    scope: "organization",
    id,
    roles: ["auditor"],
  })),
};

function within<T>(ms: number, work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`did not settle within ${String(ms)} ms`));
      }, ms);
    }),
  ]);
}

describe("version reads of several tenants in one tick", () => {
  it("settles every tenant's roles read on one memo, with its own version", async () => {
    const { client, calls } = database();
    const roles = postgrestSources(client, {
      policy,
      subjects: memorySubjectCache(),
    }).customRoles(principal);
    const memo = sourceMemo();
    const read = Promise.all(
      TENANTS.map((tenant) =>
        Promise.resolve(roles.rolesFor(tenant, { held: ["auditor"], memo })),
      ),
    );
    const loaded = await within(2000, read);
    expect(loaded.map((list) => list.map((role) => role.tenant))).toStrictEqual(
      TENANTS.map((tenant) => [tenant]),
    );
    const asked = calls
      .filter(
        (call) =>
          call.fn === "custom_roles_version_for" ||
          call.fn === "authz_versions_for",
      )
      .map((call) => tenantOf(call.args))
      .toSorted();
    expect(asked).toStrictEqual(TENANTS);
  });

  it("settles a derive that reads every tenant through the instance's memo", async () => {
    const { client } = database();
    const sources = postgrestSources(client, {
      policy,
      subjects: memorySubjectCache(),
    });
    const permdock = await within(
      2000,
      getPermDock(
        policy,
        { principal, context: {} },
        {
          memberships: sources.memberships,
          customRoles: sources.customRoles(principal),
        },
      ),
    );
    const derived = await within(
      2000,
      permdock.derive({
        customRoles: customRoleSource({
          rolesFor: (tenant, context) =>
            tenant === "o3"
              ? []
              : sources.customRoles(principal).rolesFor(tenant, context),
        }),
      }),
    );
    const asset = (tenant: string) => ({
      id: "a",
      organization_id: tenant,
      customer_id: "c",
    });
    expect(derived.tenant("o1").can(permissions.asset.read, asset("o1"))).toBe(
      true,
    );
    expect(derived.tenant("o3").can(permissions.asset.read, asset("o3"))).toBe(
      false,
    );
  });

  it("rejects every queued read when the database call fails", async () => {
    const failing: SupabaseRpcClient = {
      schema() {
        return {
          rpc() {
            return Promise.reject(new Error("down"));
          },
        };
      },
    };
    const roles = postgrestSources(failing, {
      policy,
      subjects: memorySubjectCache(),
    }).customRoles(principal);
    const memo = sourceMemo();
    const settled = await within(
      2000,
      Promise.allSettled(
        TENANTS.map((tenant) =>
          Promise.resolve(roles.rolesFor(tenant, { held: ["auditor"], memo })),
        ),
      ),
    );
    expect(settled).toHaveLength(TENANTS.length);
  });
});
