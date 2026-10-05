import { describe, expect, it, vi } from "vitest";

import type { Snapshot } from "../../src/core/interfaces.ts";
import type { CustomRole, Principal } from "../../src/core/subject.ts";
import type { LocalSnapshotData } from "../../src/react-native/local.ts";

import { principal } from "../../src/conditions/refs.ts";
import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { authenticated, relation } from "../../src/core/grantee.ts";
import { memoryRoleSource } from "../../src/core/interfaces.ts";
import { localSnapshotManifest } from "../../src/core/local-manifest.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import { allow, definePolicy, deny, role } from "../../src/core/policy.ts";
import { parseSnapshot } from "../../src/core/snapshot.ts";
import { defineRoles } from "../../src/core/vocabulary.ts";
import {
  buildLocalSnapshot,
  localSnapshot,
} from "../../src/react-native/local.ts";
import { memoryStorage } from "../../src/react-native/storage.ts";
import {
  connectSource,
  createNativeStore,
} from "../../src/react-native/store.ts";
import { testSnapshotSource } from "../../src/testing/conformance.ts";

const permissions = definePermissions({
  job: resource({
    id: "id",
    actions: ["read", "update", "close"],
    relations: {
      org: { field: "orgId", memberOf: "tenant" },
      team: { field: "teamId", memberOf: "team" },
      watcher: { field: "watcherId" },
    },
    levels: {
      own: { ownerId: principal.id },
      team: { teamId: { in: { ref: "principal.claims.team_ids" } } },
      all: {},
    },
  }),
  folder: resource({ id: "id", actions: ["read"] }),
  notice: resource({ id: "id", actions: ["read"] }),
  report: resource({
    id: "id",
    actions: ["read"],
    collection: ["export"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const roles = defineRoles({
  admin: { on: "tenant", assignable: true },
  member: { on: "tenant", assignable: true },
  lead: { on: "team", assignable: true },
  support: { assignable: true },
});

const { folder, job, notice, report } = permissions;

const policy = definePolicy(
  { permissions, roles },
  {
    scopes: {
      tenant: { key: "orgId" },
      team: { key: "teamId", within: "tenant" },
    },
    subject: (user: Principal | null) => user,
    roles: [
      role(roles.admin, [
        allow([job.read, job.update, job.close, report.read, report.export]),
        deny(job.close, { where: { locked: true } }),
      ]),
      role(roles.member, [
        allow(job.read, {
          where: { teamId: { in: { ref: "principal.claims.team_ids" } } },
        }),
        allow(job.update, { where: { ownerId: principal.id } }),
      ]),
      role(roles.lead, [allow([job.read, job.update])]),
      role(roles.support, [allow(job.read)]),
      role("editor", [allow(folder.read)], { on: folder }),
    ],
    grants: [
      allow(notice.read, { to: authenticated() }),
      allow(job.read, { to: relation(job, "watcher") }),
    ],
  },
);

const manifest = JSON.parse(JSON.stringify(localSnapshotManifest(policy)));

// Rows as a database returns them: entries a role source does not type-check.
const malformed: readonly CustomRole[] = JSON.parse(
  JSON.stringify([
    {
      tenant: "acme",
      name: "odd",
      grants: [
        { permission: "job.read", level: "nope" },
        { permission: "job.update", extra: 1 },
        { permission: "ghost.read" },
        { permission: "job.close", effect: "deny", level: "own" },
        "x",
        { permission: 3 },
      ],
    },
    {
      tenant: "acme",
      name: "mixed",
      includes: ["member", "ghost", 7],
      grants: [
        { permission: "job.read" },
        { permission: "job.update", level: "team" },
      ],
    },
  ]),
);

const customRoles: readonly CustomRole[] = [
  {
    tenant: "acme",
    name: "dispatcher",
    grants: [
      { permission: "job.read", level: "team" },
      { permission: "job.update", level: "own" },
    ],
  },
  {
    tenant: "acme",
    name: "auditor",
    includes: ["admin"],
    grants: [{ permission: "job.close", effect: "deny" }],
  },
  ...malformed,
  {
    tenant: "acme",
    name: "reader",
    includes: ["member"],
    grants: [
      { permission: "report.read" },
      { permission: "report.export" },
      { permission: "report.read", level: "own" },
    ],
  },
  {
    tenant: "acme",
    team: "t1",
    name: "squad",
    grants: [{ permission: "job.update" }],
  },
  {
    tenant: "acme",
    scope: "tenant",
    id: "acme",
    name: "pinned",
    grants: [{ permission: "job.read", level: "own" }],
  },
  {
    tenant: "acme",
    scope: "nowhere",
    name: "lost",
    grants: [{ permission: "job.read" }],
  },
  { scope: "global", name: "platform", grants: [{ permission: "job.read" }] },
  { tenant: "acme", name: "admin", grants: [{ permission: "job.close" }] },
];

const claims = { team_ids: ["t1"] };

const ann: Principal = {
  id: "ann",
  memberships: [
    { tenant: "acme", roles: ["admin"] },
    { tenant: "globex", roles: ["member"] },
  ],
};
const mo: Principal = {
  id: "mo",
  memberships: [{ tenant: "acme", roles: ["member"] }],
};

const users: readonly Principal[] = [
  ann,
  mo,
  { id: "lee", memberships: [{ tenant: "acme", team: "t1", roles: ["lead"] }] },
  {
    id: "dee",
    memberships: [{ tenant: "acme", roles: ["dispatcher", "pinned"] }],
  },
  {
    id: "aud",
    memberships: [{ tenant: "acme", roles: ["auditor", "reader"] }],
  },
  {
    id: "odd",
    memberships: [{ tenant: "acme", roles: ["odd", "mixed", "lost"] }],
  },
  { id: "sq", memberships: [{ tenant: "acme", team: "t1", roles: ["squad"] }] },
  { id: "sup", roles: ["support", "platform"], memberships: [] },
  {
    id: "ed",
    memberships: [{ on: { resource: "folder", id: "f1" }, roles: ["editor"] }],
  },
  { id: "ghost", memberships: [{ tenant: "acme", roles: ["stranger"] }] },
];

const rows = [
  {
    id: "j1",
    orgId: "acme",
    teamId: "t1",
    ownerId: "dee",
    locked: false,
    watcherId: "x",
  },
  {
    id: "j2",
    orgId: "acme",
    teamId: "t2",
    ownerId: "mo",
    locked: true,
    watcherId: "x",
  },
  {
    id: "j3",
    orgId: "globex",
    teamId: "t9",
    ownerId: "ann",
    locked: false,
    watcherId: "x",
  },
  { id: "f1" },
  { id: "f2" },
];

const checks = [
  job.read,
  job.update,
  job.close,
  folder.read,
  notice.read,
  report.read,
];

async function serverSnapshot(
  user: Principal,
  tenant: string | undefined,
): Promise<Snapshot> {
  const server = await createPermDock(
    policy,
    { ...user, claims },
    {
      ...(tenant === undefined ? {} : { tenant }),
      customRoles: memoryRoleSource(customRoles),
    },
  );
  return parseSnapshot(JSON.stringify(server.snapshot()));
}

function local(user: Principal, tenant: string | undefined): LocalSnapshotData {
  return {
    principal: {
      id: user.id,
      ...(user.roles === undefined ? {} : { roles: user.roles }),
      ...(tenant === undefined ? {} : { tenant }),
      memberships: user.memberships ?? [],
      attributes: { claims },
    },
    customRoles,
  };
}

describe("localSnapshot", () => {
  it("decides every check the way the server snapshot does", async () => {
    for (const user of users) {
      for (const tenant of ["acme", "globex", undefined]) {
        const serverRaw = await serverSnapshot(user, tenant);
        const server = fromSnapshot(serverRaw);
        const snapshot = buildLocalSnapshot(
          manifest,
          local(user, tenant),
          1_700_000_000,
        );
        const device = fromSnapshot(parseSnapshot(JSON.stringify(snapshot)));
        expect(snapshot.roles, `${user.id} in ${String(tenant)}`).toEqual(
          serverRaw.roles,
        );
        expect(device.can(report.export), `${user.id} report.export`).toBe(
          server.can(report.export),
        );
        for (const permission of checks) {
          for (const row of rows) {
            expect(
              device.can(permission, row),
              `${user.id} ${permission.key} ${row.id} in ${String(tenant)}`,
            ).toBe(server.can(permission, row));
          }
        }
      }
    }
  });

  it("answers an anonymous user like the server", async () => {
    const server = fromSnapshot(
      parseSnapshot(
        JSON.stringify((await createPermDock(policy, null)).snapshot()),
      ),
    );
    const device = fromSnapshot(
      buildLocalSnapshot(manifest, { principal: null }),
    );
    for (const permission of checks) {
      expect(device.can(permission, rows[0])).toBe(
        server.can(permission, rows[0]),
      );
    }
  });

  it("keeps relation grants on the server", () => {
    expect(
      manifest.grants.some(
        (grant: { permission: string; portable?: false }) =>
          grant.permission === "job.read" && grant.portable === false,
      ),
    ).toBe(true);
  });

  it("rejects a manifest it does not know", () => {
    expect(() =>
      buildLocalSnapshot({ ...manifest, v: 2 }, { principal: null }),
    ).toThrow("PermDock: unsupported local snapshot manifest");
    expect(() =>
      buildLocalSnapshot(JSON.parse("null"), { principal: null }),
    ).toThrow("PermDock: unsupported local snapshot manifest");
  });

  describe("conformance", () => {
    testSnapshotSource(
      localSnapshot({
        manifest,
        read: () => local(ann, "acme"),
        subscribe: () => () => undefined,
      }),
    );
  });

  it("hydrates a native store and follows changes", async () => {
    let user: Principal = mo;
    const listeners = new Set<() => void>();
    const source = localSnapshot({
      manifest,
      read: async () => local(user, "acme"),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
    const store = createNativeStore({ storage: memoryStorage() });
    const disconnect = connectSource(store, source);
    await vi.waitFor(() => {
      expect(store.get().can(job.read, rows[0])).toBe(true);
    });
    expect(store.get().can(job.close, rows[0])).toBe(false);
    user = ann;
    for (const listener of listeners) {
      listener();
    }
    await vi.waitFor(() => {
      expect(store.get().can(job.close, rows[0])).toBe(true);
    });
    disconnect();
    expect(listeners.size).toBe(0);
  });

  it("drops a read that settles after disconnect", async () => {
    const store = createNativeStore({ storage: memoryStorage() });
    const before = store.snapshot();
    const disconnect = connectSource(
      store,
      localSnapshot({ manifest, read: () => local(ann, "acme") }),
    );
    disconnect();
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(store.snapshot()).toBe(before);
  });

  it("writes no custom table for a policy without assignable roles", () => {
    const bare = definePolicy(permissions, {
      subject: (user: Principal | null) => user,
      grants: [allow(notice.read, { to: authenticated() })],
    });
    expect(localSnapshotManifest(bare)).toMatchObject({
      custom: {},
      roles: [],
    });
  });

  it("carries the rank of an assigns graph", () => {
    const ranked = definePolicy(
      { permissions, roles },
      {
        scopes: { tenant: { key: "orgId" } },
        subject: (user: Principal | null) => user,
        roles: [
          role(roles.admin, [allow(job.read)], { assigns: ["member"] }),
          role(roles.member, [allow(job.read)]),
        ],
      },
    );
    const rank = localSnapshotManifest(ranked).rank ?? [];
    expect(rank.indexOf("admin")).toBeLessThan(rank.indexOf("member"));
  });

  it("keeps the current snapshot when a read fails", async () => {
    const store = createNativeStore({ storage: memoryStorage() });
    const before = store.snapshot();
    const disconnect = connectSource(store, {
      get: () => Promise.reject(new Error("offline")),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.snapshot()).toBe(before);
    disconnect();
  });
});
