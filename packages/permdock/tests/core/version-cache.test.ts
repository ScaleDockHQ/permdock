import { describe, expect, it } from "vitest";

import type { MembershipSource } from "../../src/core/interfaces.ts";
import type { Membership, Principal, Subject } from "../../src/core/subject.ts";

import {
  allow,
  claimsFirst,
  definePermissions,
  definePolicy,
  getPermDock,
  memoryVersionCache,
  resource,
  role,
} from "../../src/index.ts";

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
  fresh: [permissions.doc.update],
  subject: (user: Principal | null) => user,
});

const row = { id: "d1", org_id: "T" };
const member: Membership = {
  scope: "organization",
  id: "T",
  roles: ["member"],
};

/** A database whose version and memberships the test changes. */
function database(initial: { version: number; memberships: Membership[] }) {
  const state = { ...initial, versionReads: 0, membershipReads: 0 };
  const source: MembershipSource = {
    async membershipsFor() {
      state.membershipReads += 1;
      return [...state.memberships];
    },
    async version() {
      state.versionReads += 1;
      await Promise.resolve();
      return state.version;
    },
  };
  return { state, source };
}

function clock(start: number) {
  const time = { ms: start };
  return { time, now: () => ({ epochMilliseconds: time.ms }) };
}

const START = 1_800_000_000_000;

function token(version: number, issuedAtMs?: number): Subject {
  return {
    principal: {
      id: "u1",
      roles: [],
      tenant: "T",
      memberships: [member],
      authzVersion: version,
    },
    context: {},
    ...(issuedAtMs === undefined
      ? {}
      : { issuedAt: Math.floor(issuedAtMs / 1000) }),
  };
}

describe(memoryVersionCache, () => {
  it("shares one version read across 10 concurrent instances", async () => {
    const { state, source } = database({ version: 3, memberships: [member] });
    const { now } = clock(START);
    const memberships = claimsFirst(source, {
      onStale: "reread",
      versions: memoryVersionCache({ maxStaleMs: 5000, now }),
    });
    const instances = await Promise.all(
      Array.from({ length: 10 }, () =>
        getPermDock(policy, token(3), { memberships, intent: "read" }),
      ),
    );
    expect(state.versionReads).toBe(1);
    expect(state.membershipReads).toBe(0);
    expect(instances.every((one) => one.can(permissions.doc.read, row))).toBe(
      true,
    );
  });

  it("makes no call for a token minted within maxStaleMs", async () => {
    const { state, source } = database({ version: 3, memberships: [member] });
    const { now } = clock(START);
    const memberships = claimsFirst(source, {
      onStale: "reread",
      versions: memoryVersionCache({ maxStaleMs: 5000, now }),
    });
    const permdock = await getPermDock(policy, token(3, START - 1000), {
      memberships,
      intent: "read",
    });
    expect(state.versionReads).toBe(0);
    expect(permdock.can(permissions.doc.read, row)).toBe(true);
  });

  it("reads live for every write and denies a revoked member at once", async () => {
    const { state, source } = database({ version: 3, memberships: [member] });
    const { now } = clock(START);
    const memberships = claimsFirst(source, {
      onStale: "reread",
      versions: memoryVersionCache({ maxStaleMs: 5000, now }),
    });
    await getPermDock(policy, token(3), { memberships, intent: "read" });
    expect(state.versionReads).toBe(1);
    state.version = 4;
    state.memberships = [];
    const reader = await getPermDock(policy, token(3), {
      memberships,
      intent: "read",
    });
    expect(state.versionReads).toBe(1);
    expect(reader.can(permissions.doc.read, row)).toBe(true);
    const writer = await getPermDock(policy, token(3), { memberships });
    expect(state.versionReads).toBe(2);
    expect(writer.can(permissions.doc.update, row)).toBe(false);
  });

  it("denies a revoked member's reads once maxStaleMs has passed", async () => {
    const { state, source } = database({ version: 3, memberships: [member] });
    const { time, now } = clock(START);
    const memberships = claimsFirst(source, {
      onStale: "reread",
      versions: memoryVersionCache({ maxStaleMs: 5000, now }),
    });
    await getPermDock(policy, token(3), { memberships, intent: "read" });
    state.version = 4;
    state.memberships = [];
    time.ms += 5001;
    const reader = await getPermDock(policy, token(3), {
      memberships,
      intent: "read",
    });
    expect(state.versionReads).toBe(2);
    expect(reader.can(permissions.doc.read, row)).toBe(false);
  });

  it("does not cache a failed read, which keeps the subject stale", async () => {
    let fail = true;
    let reads = 0;
    const source: MembershipSource = {
      membershipsFor: () => [],
      async version() {
        reads += 1;
        if (fail) {
          throw new Error("down");
        }
        return 3;
      },
    };
    const memberships = claimsFirst(source, {
      onStale: "reread",
      versions: memoryVersionCache({ maxStaleMs: 5000 }),
    });
    const failed = await getPermDock(policy, token(3), {
      memberships,
      intent: "read",
    });
    expect(failed.subject.stale).toBe(true);
    fail = false;
    const recovered = await getPermDock(policy, token(3), {
      memberships,
      intent: "read",
    });
    expect(reads).toBe(2);
    expect(recovered.subject.stale).toBeUndefined();
  });

  it("rereads after evict", async () => {
    const { state, source } = database({ version: 3, memberships: [member] });
    const versions = memoryVersionCache({ maxStaleMs: 5000 });
    const memberships = claimsFirst(source, { onStale: "reread", versions });
    await getPermDock(policy, token(3), { memberships, intent: "read" });
    state.version = 4;
    state.memberships = [];
    versions.evict("u1");
    const reader = await getPermDock(policy, token(3), {
      memberships,
      intent: "read",
    });
    expect(state.versionReads).toBe(2);
    expect(reader.can(permissions.doc.read, row)).toBe(false);
    expect(versions.stats()).toMatchObject({ reads: 2, evictions: 1 });
  });

  it("keeps at most maxEntries principals, dropping the least recently used", async () => {
    let reads = 0;
    const versions = memoryVersionCache({ maxStaleMs: 5000, maxEntries: 2 });
    const read = () => {
      reads += 1;
      return 1;
    };
    for (const id of ["a", "b", "a", "c", "a", "b"]) {
      await versions.current({ id }, read, { live: false });
    }
    expect(reads).toBe(4);
    expect(versions.stats().size).toBe(2);
  });

  it("raises the cached version from a newer token, so an older token rereads", async () => {
    const { state, source } = database({ version: 3, memberships: [member] });
    const memberships = claimsFirst(source, {
      onStale: "reread",
      versions: memoryVersionCache({ maxStaleMs: 5000 }),
    });
    await getPermDock(policy, token(3), { memberships, intent: "read" });
    await getPermDock(policy, token(4), { memberships, intent: "read" });
    expect(state.versionReads).toBe(1);
    await getPermDock(policy, token(3), { memberships, intent: "read" });
    expect(state.membershipReads).toBe(1);
  });

  it("ignores a read that an evict overtook", async () => {
    const { promise, resolve } = Promise.withResolvers<number>();
    const versions = memoryVersionCache({ maxStaleMs: 5000 });
    const pending = versions.current({ id: "u1" }, () => promise, {
      live: false,
    });
    versions.evict("u1");
    resolve(1);
    await pending;
    expect(versions.stats().size).toBe(0);
  });

  it("clamps maxStaleMs to a minute", () => {
    expect(memoryVersionCache({ maxStaleMs: 600_000 }).maxStaleMs).toBe(60_000);
    expect(memoryVersionCache({ maxStaleMs: -1 }).maxStaleMs).toBe(0);
  });
});
