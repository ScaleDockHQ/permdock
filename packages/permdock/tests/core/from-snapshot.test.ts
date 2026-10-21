import { describe, expect, it, vi } from "vitest";

import type { Snapshot, SnapshotGrant } from "../../src/core/snapshot-types.ts";

import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
} from "../../src/core/errors.ts";
import { emptySnapshot, fromSnapshot } from "../../src/core/from-snapshot.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { defineRoles } from "../../src/core/vocabulary.ts";
import {
  activate,
  decideRoleChange,
  simulateArazzo,
  whoCan,
} from "../../src/index.ts";
import { reasonOf } from "../fixtures/decisions.ts";
import {
  adminUser,
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

describe("fromSnapshot", () => {
  it("answers the same portable checks as the server instance", async () => {
    const server = getPermDockSync(policy, memberUser);
    const snapshot = server.snapshot();
    if (snapshot instanceof Promise) {
      throw new TypeError("expected JSON snapshot");
    }
    const client = fromSnapshot(snapshot);
    expect(client.can(permissions.post.read, ownPost)).toBe(true);
    expect(client.can(permissions.post.create)).toBe(true);
    expect(client.can(permissions.post.update, ownPost)).toBe(true);
    expect(client.can(permissions.post.update, otherPost)).toBe(false);
    expect(client.can(permissions.post.publish, ownPost)).toBe(false);
    expect(client.decide(permissions.post.delete, ownPost).outcome).toBe(
      "approval-required",
    );
    expect(
      client.filter(permissions.post.update, [ownPost, otherPost]),
    ).toStrictEqual([ownPost]);
    expect(client.where(permissions.post.update).partial).toBe(false);
  });

  it("keeps deny-overrides-allow for admin publish", async () => {
    const server = getPermDockSync(policy, adminUser);
    const snapshot = server.snapshot();
    if (snapshot instanceof Promise) {
      throw new TypeError("expected JSON snapshot");
    }
    const client = fromSnapshot(snapshot);
    expect(client.can(permissions.post.publish, ownPost)).toBe(true);
    expect(client.can(permissions.post.publish, otherPost)).toBe(false);
    expect(client.decide(permissions.post.publish, otherPost).outcome).toBe(
      "denied",
    );
  });

  it("fails closed for anonymous and unknown include", async () => {
    const server = getPermDockSync(policy, null);
    const snapshot = server.snapshot();
    if (snapshot instanceof Promise) {
      throw new TypeError("expected JSON snapshot");
    }
    const client = fromSnapshot(snapshot);
    expect(client.can(permissions.post.read, ownPost)).toBe(false);
    expect(client.decide(permissions.post.read, ownPost).outcome).toBe(
      "denied",
    );
  });

  it("treats portable false and include misses as server-only denials", async () => {
    const server = getPermDockSync(policy, memberUser);
    const full = server.snapshot();
    if (full instanceof Promise) {
      throw new TypeError("expected JSON snapshot");
    }
    const scoped = fromSnapshot({ ...full, include: ["billing"] });
    const decision = scoped.decide(permissions.post.update, ownPost);
    expect(decision.outcome).toBe("denied");
    if (decision.outcome === "denied") {
      expect(decision.denials[0]?.reason).toBe("opaque-condition");
    }
    const opaque = fromSnapshot({
      ...full,
      grants: full.grants.map((grant) => {
        if (grant.permission !== "post.update") {
          return grant;
        }
        return {
          permission: grant.permission,
          effect: grant.effect,
          role: grant.role,
          to: grant.to,
          portable: false as const,
        };
      }),
    });
    const closed = opaque.decide(permissions.post.update, ownPost);
    expect(closed.outcome).toBe("denied");
    if (closed.outcome === "denied") {
      expect(closed.denials[0]?.reason).toBe("opaque-condition");
    }
  });

  it("throws the same assert errors as the server", async () => {
    const server = getPermDockSync(policy, memberUser);
    const snapshot = server.snapshot();
    if (snapshot instanceof Promise) {
      throw new TypeError("expected JSON snapshot");
    }
    const client = fromSnapshot(snapshot);
    expect(() => client.assert(permissions.post.publish, ownPost)).toThrow(
      PermDockDeniedError,
    );
  });

  it("exposes snapshot tenants and derived tenant instances", async () => {
    const server = getPermDockSync(policy, memberUser);
    const snapshot = server.snapshot();
    if (snapshot instanceof Promise) {
      throw new TypeError("expected JSON snapshot");
    }
    const client = fromSnapshot(snapshot);
    expect(client.tenants()).toStrictEqual(snapshot.tenants);
    expect(client.memberships()).toStrictEqual(
      snapshot.subject.principal?.memberships ?? [],
    );
    expect(client.heldRoles().some((item) => item.key === "member")).toBe(true);
    expect(client.assignableRoles()).toStrictEqual([]);
    const other = client.tenant("missing");
    expect(other.subject.principal?.tenant).toBeUndefined();
  });

  it("intersects GNAP access on the snapshot subject", async () => {
    const server = getPermDockSync(policy, {
      principal: { id: "u1", roles: ["admin"] },
      context: {},
      delegation: {
        access: [{ type: "post", actions: ["read"], identifier: "p1" }],
      },
    });
    const snapshot = server.snapshot();
    if (snapshot instanceof Promise) {
      throw new TypeError("expected JSON snapshot");
    }
    const client = fromSnapshot(snapshot);
    expect(client.can(permissions.post.read, ownPost)).toBe(true);
    expect(client.can(permissions.post.publish, ownPost)).toBe(false);
  });
});

const docs = definePermissions({
  doc: resource({
    actions: ["read", "update", "delete"],
    collection: ["create"],
  }),
});

const vocabulary = defineRoles({
  owner: { on: "tenant", assignable: true, meta: { audience: "staff" } },
  member: { on: "tenant", assignable: true, meta: { audience: "staff" } },
  contact: { on: "tenant", assignable: false, meta: { audience: "portal" } },
  hidden: { on: "tenant", assignable: true },
});

const toMember = { kind: "role", role: "member", scope: "global" } as const;

function snapshotGrant(
  permission: string,
  extra: Partial<SnapshotGrant> = {},
): SnapshotGrant {
  return {
    permission,
    effect: "allow",
    role: "member",
    to: toMember,
    ...extra,
  };
}

function docSnapshot(extra: Partial<Snapshot> = {}): Snapshot {
  return {
    v: 1,
    issuedAt: "1970-01-01T00:00:01Z",
    subject: {
      principal: {
        id: "u1",
        roles: ["member"],
        tenant: "t1",
        memberships: [
          { scope: "tenant", id: "t1", roles: ["owner", "member"] },
          { scope: "tenant", id: "t2", roles: ["contact", "member"] },
          { scope: "tenant", id: "t3", roles: ["member"], expiresAt: 10 },
        ],
      },
      context: {},
    },
    roles: ["owner", "member"],
    audiences: ["staff"],
    grants: [
      snapshotGrant("doc.read"),
      snapshotGrant("doc.create"),
      snapshotGrant("doc.update", { fields: ["title"] }),
      snapshotGrant("doc.update", { effect: "deny", fields: ["secret"] }),
      snapshotGrant("doc.delete", { approval: "human" }),
    ],
    tenants: ["t1", "t2"],
    vocabulary: { roles: vocabulary },
    ...extra,
  };
}

describe("fromSnapshot instance surface", () => {
  const row = { id: "d1", title: "T", secret: "S", body: "B" };

  it("asserts grants and throws approval and denial errors with a resource ref", () => {
    const client = fromSnapshot(docSnapshot());
    expect(client.assert(docs.doc.read, row).outcome).toBe("granted");
    expect(() => client.assert(docs.doc.delete, row)).toThrow(
      PermDockApprovalRequiredError,
    );
    const ref = (data: unknown, permission = docs.doc.update) => {
      try {
        client.assert(permission, data, { field: "secret" });
      } catch (error) {
        if (error instanceof PermDockDeniedError) {
          return error.resource;
        }
      }
      return undefined;
    };
    expect(ref(row)).toStrictEqual({ type: "doc", id: "d1" });
    expect(ref({ title: "no id" })).toStrictEqual({ type: "doc" });
    const empty = fromSnapshot(emptySnapshot());
    let collectionRef: unknown;
    try {
      empty.assert(docs.doc.create, { id: "ignored" });
    } catch (error) {
      if (error instanceof PermDockDeniedError) {
        collectionRef = error.resource;
      }
    }
    expect(collectionRef).toStrictEqual({ type: "doc" });
  });

  it("picks only the fields a field-scoped grant allows", () => {
    const client = fromSnapshot(docSnapshot());
    expect(client.pick(docs.doc.update, row)).toStrictEqual({ title: "T" });
    expect(client.pick(docs.doc.read, row)).toStrictEqual(row);
    // SAFETY: pick guards non-object rows at run time; the cast feeds it one.
    expect(client.pick(docs.doc.read, null as unknown as object)).toStrictEqual(
      {},
    );
    expect(
      fromSnapshot(emptySnapshot()).pick(docs.doc.read, row),
    ).toStrictEqual({});
  });

  it("lists the granted actions of a resource node", () => {
    const client = fromSnapshot(docSnapshot());
    expect(client.actions(docs.doc, row).map((leaf) => leaf.key)).toStrictEqual(
      ["doc.read", "doc.update", "doc.create"],
    );
  });

  it("simulates pairs, Arazzo input and role previews over the snapshot grants", () => {
    const client = fromSnapshot(docSnapshot());
    const pairs = client.simulate([
      [docs.doc.read, row],
      [docs.doc.delete, row],
    ]);
    expect(pairs.map((decision) => decision.outcome)).toStrictEqual([
      "granted",
      "approval-required",
    ]);
    const plan = simulateArazzo(client, { arazzo: {}, openapi: {} });
    expect(plan.outcome).toBe("denied");

    const asOwner = client.simulate({ roles: [vocabulary.owner, "contact"] });
    const ownerView = asOwner.snapshot();
    if (typeof ownerView === "string" || ownerView instanceof Promise) {
      throw new TypeError("expected a JSON snapshot");
    }
    expect({
      simulated: ownerView.simulated,
      roles: ownerView.subject.principal?.roles,
    }).toStrictEqual({ simulated: true, roles: ["owner", "contact"] });
    expect(asOwner.can(docs.doc.read, row)).toBe(true);
    expect(asOwner.can(docs.doc.update, row, { field: "secret" })).toBe(false);

    const moved = client.simulate({
      memberships: [{ tenant: "t9", roles: ["member"] }],
      tenant: "t9",
    });
    expect(moved.subject.principal?.tenant).toBe("t9");
    expect(moved.memberships()).toStrictEqual([
      { scope: "tenant", id: "t9", roles: ["member"] },
    ]);

    const anonymous = fromSnapshot(emptySnapshot()).simulate({
      roles: ["member"],
    });
    expect(anonymous.subject.principal).toBeNull();
    expect(anonymous.memberships()).toStrictEqual([]);
  });

  it("derives tenant and team instances and their held roles", () => {
    const client = fromSnapshot(docSnapshot());
    expect(client.heldRoles().map((leaf) => leaf.key)).toStrictEqual([
      "owner",
      "member",
    ]);
    const t2 = client.tenant("t2");
    expect(t2.subject.principal?.tenant).toBe("t2");
    expect(
      t2.heldRoles({ tenant: "t2" }).map((leaf) => leaf.key),
    ).toStrictEqual(["member", "contact"]);
    expect(client.heldRoles({ scope: "nowhere" })).toStrictEqual([]);
    const teamed = t2.team("blue");
    expect(teamed.subject.principal?.tenant).toBe("t2");
    expect(teamed.can(docs.doc.read, row)).toBe(true);
    const unknown = fromSnapshot(docSnapshot({ vocabulary: {} }));
    expect(unknown.heldRoles().map((leaf) => leaf.assignable)).toStrictEqual([
      false,
      false,
    ]);
  });

  it("reads audiences from the snapshot or from the held roles of another tenant", () => {
    const client = fromSnapshot(docSnapshot());
    expect(client.audiences()).toStrictEqual(["staff"]);
    expect(client.tenant("t2").audiences()).toStrictEqual(["staff", "portal"]);
    const expired = client.tenant("t3");
    expect(expired.subject.principal?.tenant).toBeUndefined();
    expect(expired.audiences()).toStrictEqual(["staff"]);
    const { audiences: _audiences, ...withoutAudiences } = docSnapshot();
    expect(fromSnapshot(withoutAudiences).audiences()).toStrictEqual([]);
  });

  it("answers server-only questions with closed, non-granting results", async () => {
    const client = fromSnapshot(docSnapshot());
    await expect(client.prefetchRelations(docs.doc.read, [row])).resolves.toBe(
      undefined,
    );
    await expect(whoCan(client, docs.doc.read, row)).resolves.toStrictEqual({
      permission: "doc.read",
      holders: [],
      complete: false,
    });
    const change = decideRoleChange(client, {
      kind: "assign",
      role: "member",
      scope: "tenant",
      id: "t1",
      target: { id: "u2" },
    });
    expect(change).toStrictEqual({
      outcome: "denied",
      change: {
        kind: "assign",
        role: "member",
        scope: "tenant",
        id: "t1",
        target: { id: "u2" },
      },
      denials: [{ role: null, reason: "unsupported" }],
    });
    const activation = activate(client, {
      role: "owner",
      scope: "tenant",
      id: "t1",
    });
    expect(activation.outcome).toBe("denied");
    const unsubscribe = client.on("decision", () => undefined);
    expect(unsubscribe()).toBeUndefined();
  });

  it("lists assignable roles from the snapshot entry or the held assignable roles", () => {
    const permission = docs.doc.read;
    const withEntries = fromSnapshot(
      docSnapshot({
        assignable: [
          {
            tenant: "t1",
            roles: ["member", "custom"],
            permissions: [permission],
          },
        ],
      }),
    );
    expect(
      withEntries.assignableRoles().map((leaf) => [leaf.key, leaf.assignable]),
    ).toStrictEqual([
      ["member", true],
      ["custom", true],
    ]);
    expect(withEntries.assignableRoles({ tenant: "t2" })).toStrictEqual([]);
    expect(withEntries.assignablePermissions()).toStrictEqual([permission]);
    expect(withEntries.assignablePermissions({ tenant: "t2" })).toStrictEqual(
      [],
    );

    const derived = fromSnapshot(docSnapshot());
    expect(derived.assignableRoles().map((leaf) => leaf.key)).toStrictEqual([
      "owner",
      "member",
    ]);
    expect(
      derived.assignableRoles({ tenant: "t2" }).map((leaf) => leaf.key),
    ).toStrictEqual(["member"]);
    const anonymous = fromSnapshot(emptySnapshot());
    expect(anonymous.assignablePermissions()).toStrictEqual([]);
    expect(anonymous.assignableRoles()).toStrictEqual([]);
  });

  it("denies every check on the empty snapshot", () => {
    const client = fromSnapshot(emptySnapshot());
    expect(reasonOf(client.decide(docs.doc.read, { id: "d1" }))).toBe(
      "anonymous",
    );
    expect(client.tenants()).toStrictEqual([]);
    expect(client.roles).toStrictEqual({});
    expect(client.plans).toStrictEqual({});
  });

  // A Cache Components prerender rejects Date.now() in a Client Component, and
  // a provider awaiting its snapshotPromise decides against the empty snapshot.
  it("decides on the empty snapshot without reading the clock", () => {
    const clock = vi.spyOn(Date, "now");
    try {
      const client = fromSnapshot(emptySnapshot());
      expect(client.can(docs.doc.read, { id: "d1" })).toBe(false);
      expect(clock).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
});
