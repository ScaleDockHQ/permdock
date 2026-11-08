import { describe, expect, it } from "vitest";

import type { MembershipSource, SubjectRecord } from "../../src/index.ts";

import { rereadStale, staleness } from "../../src/core/freshness.ts";
import { filterIds, permittedScopeIds } from "../../src/core/may-use.ts";
import { readSubjectRecord } from "../../src/core/subject-cache.ts";
import {
  claimsFirst,
  composeMemberships,
  fromSnapshot,
  getPermDock,
  getPermDockSync,
  instanceCache,
  memorySubjectCache,
} from "../../src/index.ts";
import { permissions, policy } from "../fixtures/named-scopes.ts";

const base: MembershipSource = { membershipsFor: () => [] };
const query = { id: "u1", tenant: "acme" };

describe("customRolesVersion on composed and claims-first sources", () => {
  it("reports the highest version any source reads and none when no source can", async () => {
    const composed = composeMemberships([
      { ...base, customRolesVersion: () => 3 },
      { ...base, customRolesVersion: () => Promise.resolve(7) },
      { ...base, customRolesVersion: () => undefined },
      base,
    ]);
    expect(await composed.customRolesVersion?.(query)).toBe(7);
    const none = composeMemberships([
      { ...base, customRolesVersion: () => undefined },
    ]);
    expect(await none.customRolesVersion?.(query)).toBeUndefined();
    expect(composeMemberships([base]).customRolesVersion).toBeUndefined();
  });

  it("forwards the lookup through claimsFirst", async () => {
    const wrapped = claimsFirst({ ...base, customRolesVersion: () => 5 });
    expect(await wrapped.customRolesVersion?.(query)).toBe(5);
    expect(claimsFirst(base).customRolesVersion).toBeUndefined();
  });
});

describe("subject records and the tenant versions", () => {
  const read = (extra: Record<string, unknown>): SubjectRecord | undefined =>
    readSubjectRecord({ id: "u1", active: true, ...extra });

  it("reads the versions as numbers or numeric strings and drops the rest", () => {
    expect(
      read({ customRolesVersions: { a: 3, b: "4", c: "x", d: 1.5 } })
        ?.customRolesVersions,
    ).toStrictEqual({ a: 3, b: 4 });
    expect(read({ customRolesVersions: "no" })?.customRolesVersions).toBe(
      undefined,
    );
    expect(read({ customRolesVersions: {} })?.customRolesVersions).toBe(
      undefined,
    );
  });

  const seeded = (versions: Record<string, number> | undefined) => {
    const cache = memorySubjectCache();
    void cache.seed({
      id: "u1",
      active: true,
      roles: [],
      memberships: [],
      customRoles: [],
      authzVersion: 4,
      ...(versions === undefined ? {} : { customRolesVersions: versions }),
    });
    return cache;
  };

  it("serves a record at the versions it holds and no other", async () => {
    const cache = seeded({ acme: 7 });
    expect(await cache.record("u1", 4, { acme: 7 })).not.toBeNull();
    expect(await cache.record("u1", 4, { acme: 8 })).toBeNull();
    expect(await cache.record("u1", 4)).toBeNull();
  });

  it("keeps a record that is ahead of the version asked and drops one behind it", async () => {
    const ahead = seeded({ acme: 9 });
    expect(await ahead.record("u1", 4, { acme: 8 })).toBeNull();
    expect(await ahead.record("u1", 4)).not.toBeNull();
    const behind = seeded({ acme: 6 });
    expect(await behind.record("u1", 4, { acme: 8 })).toBeNull();
    expect(await behind.record("u1", 4)).toBeNull();
    const missing = seeded(undefined);
    expect(await missing.record("u1", 4, { acme: 1 })).toBeNull();
    expect(await missing.record("u1", 4)).toBeNull();
  });
});

describe("the instance key when the tenant version cannot be read", () => {
  const principal = {
    id: "u1",
    tenant: "acme",
    memberships: [
      { scope: "organization", id: "acme", roles: ["auditor"], via: "staff" },
    ],
    authzVersion: 4,
  };

  const build = async (
    customRolesVersion: NonNullable<MembershipSource["customRolesVersion"]>,
    version: { known: number; customRoles?: number },
  ) => {
    const instances = instanceCache();
    const options = {
      tenant: "acme",
      instances,
      version,
      memberships: { ...base, customRolesVersion },
    };
    await getPermDock(policy, { principal, context: {} }, options);
    await getPermDock(policy, { principal, context: {} }, options);
    return instances.stats();
  };

  it("builds each time when the version throws or is not a version", async () => {
    expect(
      (await build(() => Promise.reject(new Error("down")), { known: 4 })).hits,
    ).toBe(0);
    expect((await build(() => undefined, { known: 4 })).hits).toBe(0);
  });

  it("shares the instance when the request already read the version", async () => {
    const stats = await build(() => undefined, { known: 4, customRoles: 7 });
    expect(stats.hits).toBeGreaterThan(0);
  });
});

describe("listing helpers outside the common path", () => {
  const subject = {
    principal: {
      id: "u1",
      tenant: "acme",
      memberships: [
        {
          scope: "organization",
          id: "acme",
          roles: ["owner"],
          via: "staff" as const,
        },
      ],
    },
    context: {},
  };
  const permdock = getPermDockSync(policy, subject);

  it("takes a scope by name or alias and lists nothing for an unknown one", () => {
    const ask = (scope: string) =>
      permdock.permittedScopeIds(permissions.asset.read, { scope });
    expect(ask("organization")).toStrictEqual(ask("tenant"));
    expect(ask("nowhere")).toStrictEqual([]);
  });

  it("answers the helpers on an instance built from a snapshot", () => {
    const local = fromSnapshot(permdock.snapshot({ tenants: "all" }));
    expect(local.mayUseMany([permissions.asset.read])).toStrictEqual([
      local.mayUse(permissions.asset.read),
    ]);
    expect(local.filterIds(permissions.asset.read, ["acme"])).toStrictEqual([]);
    expect(local.filterIds(permissions.asset.read, [])).toStrictEqual([]);
  });
});

describe("listings and freshness that fail", () => {
  it("list nothing from an instance whose snapshot throws", () => {
    const broken = {
      subject: { principal: null, context: {} },
      permissions: {},
      snapshot: () => {
        throw new Error("no snapshot");
      },
    };
    // SAFETY: the two listings read only subject, permissions and snapshot of the instance.
    const permdock = broken as never;
    expect(permittedScopeIds(permdock, permissions.asset.read)).toStrictEqual(
      [],
    );
    expect(filterIds(permdock, permissions.asset.read, ["a"])).toStrictEqual(
      [],
    );
  });

  const principal = { id: "u1", memberships: [], authzVersion: 1 };

  it("reads a stale token live when its global roles cannot be read", async () => {
    const auth: never[] = [];
    const reread = rereadStale(
      { ...base, version: () => 5 },
      principal,
      undefined,
      {},
      () => [],
      auth,
      () => {
        throw new Error("down");
      },
    );
    expect(await reread.roles).toStrictEqual([]);
  });

  it("marks a token stale when the version cannot be read", async () => {
    const fresh = { fresh: ["asset.read"] };
    const ask = (version: MembershipSource["version"]) =>
      staleness(
        // SAFETY: staleness reads only policy.fresh.
        fresh as never,
        principal,
        { ...base, ...(version === undefined ? {} : { version }) },
        { live: false, stale: undefined, issuedAt: undefined, context: {} },
        [],
      );
    expect(await ask(() => Promise.reject(new Error("down")))).toBe(true);
    expect(
      await ask(() => {
        throw new Error("down");
      }),
    ).toBe(true);
    expect(await ask(undefined)).toBe(true);
  });
});

describe("sources that fail while the subject is built", () => {
  const subject = {
    principal: {
      id: "u1",
      tenant: "acme",
      memberships: [
        { scope: "organization", id: "acme", roles: ["owner"], via: "staff" },
      ],
    },
    context: {},
  };

  it("refuses a synchronous build over an asynchronous source", () => {
    expect(() =>
      getPermDockSync(policy, subject, {
        memberships: { membershipsFor: () => Promise.resolve([]) },
      }),
    ).toThrow(/getPermDockSync got a Promise/u);
  });

  it("keeps the subject when an entitlement source throws or rejects", async () => {
    for (const entitlementsFor of [
      () => {
        throw new Error("down");
      },
      () => Promise.reject(new Error("down")),
    ]) {
      const permdock = await getPermDock(policy, subject, {
        tenant: "acme",
        entitlements: { entitlementsFor },
      });
      expect(permdock.subject.principal?.id).toBe("u1");
    }
  });
});
