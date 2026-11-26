import { describe, expect, it, vi } from "vitest";

import type { SupabaseRpcClient } from "../../src/supabase/index.ts";

import {
  claimsFirst,
  getPermDock,
  memoryVersionCache,
} from "../../src/index.ts";
import { postgrestSources } from "../../src/supabase/index.ts";
import { permissions, policy } from "../fixtures/named-scopes.ts";

const asset = { id: "a1", organization_id: "acme", customer_id: "c1" };
const VERSION_FUNCTIONS = new Set([
  "authz_version_for",
  "custom_roles_version_for",
  "authz_versions_for",
]);

function database(options: { readonly combined: boolean }): {
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
            if (fn === "authz_versions_for") {
              return options.combined
                ? { data: { authz: 4, custom_roles: 7 }, error: null }
                : { data: null, error: { message: "not found" } };
            }
            if (fn === "authz_version_for") {
              return { data: 4, error: null };
            }
            if (fn === "custom_roles_version_for") {
              return { data: 7, error: null };
            }
            return {
              data: {
                id: "u1",
                active: true,
                roles: [],
                memberships: [
                  { scope: "organization", id: "acme", roles: ["auditor"] },
                ],
                customRoles: [
                  {
                    name: "auditor",
                    tenant: "acme",
                    scope: "organization",
                    grants: [{ permission: "asset.read" }],
                  },
                ],
                customRolesVersions: { acme: 7 },
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

const token = (issuedAt: number) => ({
  principal: {
    id: "u1",
    tenant: "acme",
    memberships: [{ scope: "organization", id: "acme", roles: ["auditor"] }],
    authzVersion: 4,
    customRolesVersion: 7,
    issuedAt,
  },
  context: {},
});

const versionReads = (calls: readonly string[]): number =>
  calls.filter((call) => VERSION_FUNCTIONS.has(call)).length;

/** One page: an instance per intent, then a derived one. */
async function page(
  sources: ReturnType<typeof postgrestSources>,
  versions: ReturnType<typeof memoryVersionCache>,
  issuedAt: number,
): Promise<void> {
  const user = token(issuedAt);
  for (const intent of ["read", "read", "database-write"] as const) {
    const permdock = await getPermDock(policy, user, {
      tenant: "acme",
      intent,
      memberships: claimsFirst(sources.memberships, {
        onStale: "reread",
        versions,
      }),
      customRoles: sources.customRoles(user.principal),
    });
    expect(permdock.can(permissions.asset.read, asset)).toBe(true);
    const derived = await permdock.derive({
      customRoles: sources.customRoles(user.principal),
    });
    expect(derived.can(permissions.asset.read, asset)).toBe(true);
  }
}

describe("version reads for a member with a custom role", () => {
  it("costs at most one read for a whole page, and none for the next", async () => {
    const { client, calls } = database({ combined: true });
    const sources = postgrestSources(client, { policy });
    const versions = memoryVersionCache();
    await page(sources, versions, Math.floor(Date.now() / 1000));
    expect(versionReads(calls)).toBeLessThanOrEqual(1);
    const first = versionReads(calls);
    await page(sources, versions, Math.floor(Date.now() / 1000));
    expect(versionReads(calls)).toBe(first);
  });

  it("falls back to the two single functions when the combined one is missing", async () => {
    const { client, calls } = database({ combined: false });
    const sources = postgrestSources(client, { policy });
    const versions = memoryVersionCache();
    await page(sources, versions, 0);
    await page(sources, versions, 0);
    expect(calls.filter((call) => call === "authz_versions_for")).toHaveLength(
      1,
    );
    expect(
      calls.filter((call) => call === "custom_roles_version_for"),
    ).toHaveLength(1);
  });

  it("reads both versions in one call when neither is cached", async () => {
    const { client, calls } = database({ combined: true });
    const sources = postgrestSources(client, { policy });
    await page(sources, memoryVersionCache(), 0);
    expect(calls.filter((call) => call === "authz_versions_for")).toHaveLength(
      1,
    );
    expect(calls).not.toContain("custom_roles_version_for");
  });
});

describe("a client that throws", () => {
  // SAFETY: a client whose schema() is missing throws when called, the way a
  // mocked admin client does.
  const broken = { schema: undefined } as unknown as SupabaseRpcClient;

  it.each([true, false])(
    "settles the version read and denies instead of hanging (combined: %s)",
    async (combined) => {
      const sources = postgrestSources(broken, {
        policy,
        ...(combined ? {} : { versionsFn: false }),
      });
      const user = token(0);
      const granted = await getPermDock(policy, user, {
        tenant: "acme",
        memberships: claimsFirst(sources.memberships, {
          onStale: "reread",
          versions: memoryVersionCache(),
        }),
        customRoles: sources.customRoles(user.principal),
      }).then(
        (permdock) => permdock.can(permissions.asset.read, asset),
        () => false,
      );
      expect(granted).toBe(false);
    },
    2000,
  );
});

describe("the development warning", () => {
  it("names a custom-role version read twice within a second", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { client } = database({ combined: false });
      const sources = postgrestSources(client, { policy, versionsFn: false });
      await page(sources, memoryVersionCache({ maxStaleMs: 0 }), 0);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("custom-role version");
    } finally {
      warn.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
