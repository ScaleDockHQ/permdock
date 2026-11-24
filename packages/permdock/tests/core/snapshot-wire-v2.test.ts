import {
  array,
  assert,
  boolean,
  constant,
  constantFrom,
  property,
  record,
  subarray,
} from "fast-check";
import { describe, expect, it } from "vitest";

import type { Membership } from "../../src/core/subject.ts";
import type { Snapshot, SnapshotGrant } from "../../src/index.ts";

import { createClientStore } from "../../src/client/store.ts";
import { canonicalJson } from "../../src/core/canonical-json.ts";
import { clientBundle } from "../../src/core/client-bundle.ts";
import { fromSnapshot } from "../../src/core/from-snapshot.ts";
import { readSnapshot } from "../../src/core/snapshot-compact.ts";
import {
  expandedSnapshotFor,
  snapshotFor,
} from "../../src/core/snapshot-for.ts";
import { snapshotFromClaims } from "../../src/core/snapshot-sign.ts";
import { parseSnapshot } from "../../src/core/snapshot.ts";
import {
  allow,
  authenticated,
  definePermissions,
  definePolicy,
  deny,
  resource,
  role,
} from "../../src/index.ts";
import { acceptStored } from "../../src/react-native/storage.ts";
import v1 from "../fixtures/snapshot-v1.json" with { type: "json" };

const permissions = definePermissions({
  doc: resource({
    actions: ["read", "update"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
  file: resource({
    actions: ["read"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
  report: resource({ actions: ["read"] }),
});

const { doc, file, report } = permissions;

type User = {
  readonly id: string;
  readonly roles?: readonly string[];
  readonly tenant?: string;
  readonly memberships?: readonly Membership[];
};

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role("owner", [allow([doc.read, doc.update, file.read])], { on: "tenant" }),
    role(
      "member",
      [allow(file.read), allow(doc.read, { where: { status: "open" } })],
      { on: "tenant" },
    ),
    role("blocked", [deny(file.read)], { on: "tenant" }),
    role("auditor", [allow(report.read)]),
  ],
  grants: [
    allow(doc.read, {
      to: authenticated(),
      requires: file.read,
      where: { public: true },
    }),
    allow(doc.update, { to: authenticated(), requires: [file.read, doc.read] }),
    allow(report.read, { to: authenticated(), requires: file.read }),
  ],
  subject: (user: User) => ({
    id: user.id,
    roles: user.roles ?? [],
    ...(user.tenant === undefined ? {} : { tenant: user.tenant }),
    memberships: user.memberships ?? [],
  }),
});

const bundle = clientBundle(policy);
const ORGS = ["o1", "o2", "o3", "o4"] as const;

const membership = record({
  id: constantFrom(...ORGS),
  roles: subarray(["owner", "member", "blocked"], { minLength: 1 }),
  staff: boolean(),
}).map(({ id, roles, staff }): Membership => ({
  scope: "tenant",
  id,
  roles,
  ...(staff ? { via: "staff" } : {}),
}));

const user = record({
  id: constant("u1"),
  roles: subarray(["auditor"]),
  tenant: constantFrom(...ORGS),
  memberships: array(membership, { maxLength: 6 }),
});

const options = record({
  omitStatic: boolean(),
  omitAssignable: boolean(),
  all: boolean(),
});

function canonGrants(grants: readonly SnapshotGrant[]): string[] {
  return grants.map((grant) => canonicalJson(grant)).toSorted();
}

function canonHeader(value: {
  readonly grants: unknown;
  readonly issuedAt: unknown;
}): string {
  const { grants: _grants, issuedAt: _issuedAt, ...rest } = value;
  return canonicalJson(rest);
}

describe("snapshot wire v2", () => {
  it("decodes to the flat form the server evaluated", () => {
    assert(
      property(
        user,
        options,
        (subject, { omitStatic, omitAssignable, all }) => {
          const built = {
            tenant: subject.tenant,
            omitStatic,
            omitAssignable,
            ...(all ? { tenants: "all" as const } : {}),
          };
          const expanded = expandedSnapshotFor(policy, subject, built);
          const wire = parseSnapshot(
            JSON.parse(JSON.stringify(snapshotFor(policy, subject, built))),
          );
          const read = readSnapshot(wire, { bundle });
          expect(canonGrants(read.grants)).toStrictEqual(
            canonGrants(expanded.grants),
          );
          expect(canonHeader(read)).toBe(canonHeader(expanded));
        },
      ),
      { numRuns: 200 },
    );
  });

  it("writes each key's holding once in the requires table", () => {
    const subject = {
      id: "u1",
      tenant: "o1",
      memberships: ORGS.map((id): Membership => ({
        scope: "tenant",
        id,
        roles: ["member"],
      })),
    };
    const wire = snapshotFor(policy, subject, {
      tenant: "o1",
      tenants: "all",
      omitAssignable: true,
    });
    expect(wire.requires).toStrictEqual([
      [["doc.read"], []],
      [["file.read"], [0, 1, 2, 3]],
    ]);
    expect(JSON.stringify(wire.conditions)).not.toContain('"o2"');
    expect(wire.subject.principal?.memberships).toStrictEqual(
      ORGS.map((id) => [0, id]),
    );
    expect(wire.shapes).toStrictEqual([{ scope: "tenant", roles: ["member"] }]);
  });

  it("resolves nothing against a stale bundle", () => {
    const subject = {
      id: "u1",
      tenant: "o1",
      memberships: [{ scope: "tenant", id: "o1", roles: ["owner"] }],
    };
    const wire = snapshotFor(policy, subject, {
      tenant: "o1",
      omitStatic: true,
      omitAssignable: true,
    });
    const other = clientBundle(
      definePolicy(permissions, {
        scopes: { tenant: { key: "tenantId" } },
        roles: [role("owner", [allow(doc.read)], { on: "tenant" })],
        subject: (input: User) => ({ id: input.id, roles: [] }),
      }),
    );
    const row = { id: "d1", orgId: "o1", public: true };
    expect(
      fromSnapshot(wire, { bundle, tenant: "o1" }).can(doc.update, row),
    ).toBe(true);
    expect(readSnapshot(wire, { bundle: other }).grants).toStrictEqual([]);
    expect(
      fromSnapshot(wire, { bundle: other, tenant: "o1" }).can(doc.read, row),
    ).toBe(false);
    expect(fromSnapshot(wire, { tenant: "o1" }).can(doc.read, row)).toBe(false);
  });

  describe("a v1 document", () => {
    const document: unknown = v1;

    it("is refused by parseSnapshot and fromSnapshot", () => {
      expect(() => parseSnapshot(document)).toThrow(
        /unsupported snapshot version '1'/u,
      );
      // SAFETY: the fixture is a v1 document a stale tab may still hold.
      expect(() => fromSnapshot(document as Snapshot)).toThrow(/version '1'/u);
    });

    it("leaves the client store server-only", () => {
      const store = createClientStore({
        // SAFETY: as above.
        snapshot: document as Snapshot,
        server: false,
      });
      expect(store.get().status()).toBe("server-only");
      expect(store.permissionState(report.read).allowed).toBe(false);
    });

    it("is discarded by React Native storage and snapshotFromClaims", () => {
      expect(
        acceptStored(JSON.stringify(document), "u1", false),
      ).toBeUndefined();
      expect(snapshotFromClaims({ snapshot: document, sub: "u1" })).toBeNull();
    });
  });
});
