import { describe, expect, it } from "vitest";

import type {
  CustomRoleSource,
  EntitlementSource,
  MembershipSource,
} from "../../src/core/interfaces.ts";
import type { Membership, Principal, Subject } from "../../src/core/subject.ts";

import { buildInstance } from "../../src/core/build-instance.ts";
import {
  allow,
  claimsFirst,
  definePermissions,
  definePolicy,
  instanceCache,
  memoryVersionCache,
  resource,
  role,
} from "../../src/index.ts";
import { testInstanceCache } from "../../src/testing/index.ts";

const Doc = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
} as const;

const permissions = definePermissions({
  doc: resource(Doc, {
    id: "id",
    actions: ["read", "update"],
    relations: { org: { field: "org_id", memberOf: "organization" } },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { organization: { key: "org_id" } },
  roles: [
    role("member", [allow([permissions.doc.read, permissions.doc.update])], {
      on: "organization",
    }),
  ],
  subject: (user: Principal | null) => user,
});

const member: Membership = {
  scope: "organization",
  id: "T",
  roles: ["member"],
};

function database(version: number) {
  const state = { version, versionReads: 0, membershipReads: 0 };
  const source: MembershipSource = {
    async membershipsFor() {
      state.membershipReads += 1;
      return [member];
    },
    async version() {
      state.versionReads += 1;
      return state.version;
    },
  };
  return { state, source };
}

function token(version?: number, id = "u1"): Subject {
  return {
    principal: {
      id,
      roles: [],
      tenant: "T",
      memberships: [member],
      ...(version === undefined ? {} : { authzVersion: version }),
    },
    context: {},
  };
}

function clock(start: number) {
  const time = { ms: start };
  return { time, now: () => time.ms };
}

describe("the instance cache", () => {
  it("reuses an instance while the version holds and rebuilds after a bump", async () => {
    const db = database(1);
    const versions = memoryVersionCache({ maxStaleMs: 0 });
    const instances = instanceCache();
    const sources = {
      memberships: claimsFirst(db.source, { versions, onStale: "reread" }),
      instances,
    };
    const first = await buildInstance({ policy, user: token(1), sources });
    const second = await buildInstance({ policy, user: token(1), sources });
    expect(second.permdock).toBe(first.permdock);
    expect(instances.stats()).toMatchObject({ builds: 1, hits: 1 });

    db.state.version = 2;
    versions.evict("u1");
    const third = await buildInstance({ policy, user: token(1), sources });
    expect(third.permdock).not.toBe(first.permdock);
    expect(instances.stats().builds).toBe(2);
  });

  it("builds every instance whose version is unknown", async () => {
    const instances = instanceCache();
    const sources = { instances };
    const first = await buildInstance({ policy, user: token(), sources });
    const second = await buildInstance({ policy, user: token(), sources });
    expect(second.permdock).not.toBe(first.permdock);
    expect(instances.stats().size).toBe(0);
  });

  it("caches a write instance on a known version and keys intents apart", async () => {
    const instances = instanceCache();
    const sources = { instances };
    const read = await buildInstance({
      policy,
      user: token(1),
      sources,
      scope: { intent: "read", version: { known: 4 } },
    });
    const write = await buildInstance({
      policy,
      user: token(1),
      sources,
      scope: { intent: "write", version: { known: 4 } },
    });
    const again = await buildInstance({
      policy,
      user: token(1),
      sources,
      scope: { intent: "write", version: { known: 4 } },
    });
    expect(write.permdock).not.toBe(read.permdock);
    expect(again.permdock).toBe(write.permdock);
  });

  it("keys subjects, claims and sources apart, not the adapter", async () => {
    const instances = instanceCache();
    const sources = { instances };
    const other = { instances, memberships: database(1).source };
    const scope = { version: { known: 1 } };
    const base = await buildInstance({
      policy,
      user: token(1),
      sources,
      scope,
    });
    const user = await buildInstance({
      policy,
      user: token(1, "u2"),
      sources,
      scope,
    });
    const claims = await buildInstance({
      policy,
      user: { ...token(1), context: { plan: "pro" } },
      sources,
      scope,
    });
    const adapter = await buildInstance({
      policy,
      user: token(1),
      sources: other,
      scope,
    });
    expect(
      new Set([base, user, claims, adapter].map((b) => b.permdock)).size,
    ).toBe(4);
    const sameSources = await buildInstance({
      policy,
      user: token(1),
      sources: { instances },
      scope,
      wrap: (permdock) => ({ ...permdock }),
    });
    expect(sameSources.permdock).not.toBe(base.permdock);
    expect(instances.stats().hits).toBe(1);
  });

  it("expires entries after maxAgeMs and evicts a principal", async () => {
    const { time, now } = clock(1000);
    const instances = instanceCache({ maxAgeMs: 100, now });
    const sources = { instances };
    const scope = { version: { known: 1 } };
    const first = await buildInstance({
      policy,
      user: token(1),
      sources,
      scope,
    });
    time.ms += 101;
    const second = await buildInstance({
      policy,
      user: token(1),
      sources,
      scope,
    });
    expect(second.permdock).not.toBe(first.permdock);
    instances.evict("u1");
    const third = await buildInstance({
      policy,
      user: token(1),
      sources,
      scope,
    });
    expect(third.permdock).not.toBe(second.permdock);
    expect(instances.maxAgeMs).toBe(100);
    expect(instanceCache({ maxAgeMs: 10_000_000 }).maxAgeMs).toBe(60_000);
  });

  it("shares a build in flight and drops a rejected one", async () => {
    const instances = instanceCache();
    const key = {
      principal: "u1",
      version: 1,
      intent: "read",
      parts: {},
    } as const;
    let builds = 0;
    const build = async () => {
      builds += 1;
      return builds;
    };
    const [a, b] = await Promise.all([
      instances.instance(key, [], build),
      instances.instance(key, [], build),
    ]);
    expect([a, b, builds]).toStrictEqual([1, 1, 1]);
    const failing = { ...key, principal: "u2" };
    await expect(
      instances.instance(failing, [], async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await instances.instance(failing, [], async () => 7)).toBe(7);
  });

  it("keeps custom roles per held roles and entitlements per principal", async () => {
    const instances = instanceCache();
    let roleReads = 0;
    const roles: CustomRoleSource = {
      rolesFor: (_tenant, context) => {
        roleReads += 1;
        return (context?.held ?? []).includes("editor")
          ? [{ name: "editor", tenant: "T", grants: [] }]
          : [];
      },
    };
    const cachedRoles = instances.customRoles(roles);
    expect(await cachedRoles.rolesFor("T", { held: [] })).toStrictEqual([]);
    expect(await cachedRoles.rolesFor("T", { held: ["editor"] })).toHaveLength(
      1,
    );
    await cachedRoles.rolesFor("T", { held: [] });
    expect(roleReads).toBe(2);

    let entitlementReads = 0;
    const entitlements: EntitlementSource = {
      entitlementsFor: (principal) => {
        entitlementReads += 1;
        return principal.id === "u1" ? ["pro"] : [];
      },
    };
    const cachedEntitlements = instances.entitlements(entitlements);
    expect(
      await cachedEntitlements.entitlementsFor({ id: "u1" }, {}),
    ).toStrictEqual(["pro"]);
    expect(
      await cachedEntitlements.entitlementsFor({ id: "u2" }, {}),
    ).toStrictEqual([]);
    await cachedEntitlements.entitlementsFor({ id: "u1" }, {});
    expect(entitlementReads).toBe(2);
    instances.evict("u1");
    await cachedEntitlements.entitlementsFor({ id: "u1" }, {});
    expect(entitlementReads).toBe(3);
  });
});

describe("instanceCache conformance", () => {
  testInstanceCache(instanceCache());
});
