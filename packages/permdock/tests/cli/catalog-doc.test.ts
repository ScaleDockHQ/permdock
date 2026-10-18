import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { ScanResult } from "../../src/cli/types.ts";
import type { PolicyScopesInput } from "../../src/index.ts";

import { parseCatalog } from "../../src/catalog/parse.ts";
import { buildCatalog, catalogGrants } from "../../src/cli/catalog-doc.ts";
import { policyRowConditionKeys } from "../../src/core/row-conditions.ts";
import {
  allow,
  anyone,
  catalogFingerprint,
  definePermissions,
  definePolicy,
  deny,
  plan,
  principal,
  resource,
  role,
  supportAccess,
} from "../../src/index.ts";

const scan: ScanResult = {
  roots: [],
  definitionFiles: {},
  usages: {},
  unknown: [],
  dynamic: [],
  roleNames: ["clerk"],
  planNames: [],
  allowKeys: [],
  snapshots: [],
  unparsed: [],
};

const permissions = definePermissions({
  invoice: resource({ actions: ["pay", "void"], version: "updatedAt" }),
  note: resource({ actions: ["read"] }),
});

const policy = definePolicy(permissions, {
  roles: [
    role("clerk", [
      allow(permissions.invoice.pay, {
        approval: { staleOn: "resource-change" },
      }),
      allow(permissions.invoice.void, { approval: "human" }),
      allow(permissions.note.read),
    ]),
  ],
  subject: () => null,
});

describe("catalog app data", () => {
  const tree = definePermissions({
    invoice: resource({
      actions: ["pay"],
      meta: { title: "Invoice", x: { team: "billing" } },
    }),
    note: resource({ actions: ["read"] }),
  });
  const withMeta = definePolicy(tree, {
    roles: [
      role("clerk", [
        allow(tree.invoice.pay, {
          name: "clerk-pays",
          meta: { description: "Clerks pay invoices", x: { ticket: "FIN-1" } },
        }),
        allow(tree.note.read),
      ]),
    ],
    subject: () => null,
  });
  const catalog = buildCatalog(tree, scan, "2026-09-29T00:00:00Z", withMeta);

  it("carries resource meta and grant meta, and omits them when empty", () => {
    expect(catalog.resources["invoice"]?.meta).toEqual({
      title: "Invoice",
      x: { team: "billing" },
    });
    expect(catalog.resources["note"]).not.toHaveProperty("meta");
    const [pays, reads] = [
      catalog.grants?.find((grant) => grant.permission === "invoice.pay"),
      catalog.grants?.find((grant) => grant.permission === "note.read"),
    ];
    expect(pays?.meta).toEqual({
      description: "Clerks pay invoices",
      x: { ticket: "FIN-1" },
    });
    expect(reads).not.toHaveProperty("meta");
  });

  it("validates against catalog-v1", () => {
    expect(() =>
      parseCatalog(JSON.parse(JSON.stringify(catalog))),
    ).not.toThrow();
  });
});

describe("catalog resource versions", () => {
  const catalog = buildCatalog(
    permissions,
    scan,
    "2026-09-29T00:00:00Z",
    policy,
  );

  it("lists the version field of a resource that declares one", () => {
    expect(catalog.resources["invoice"]?.version).toBe("updatedAt");
    expect(catalog.resources["note"]).not.toHaveProperty("version");
  });

  it("carries staleOn in the approvals of a permission", () => {
    const approvals = (key: string): unknown =>
      catalog.permissions.find((item) => item.key === key)?.approvals;
    expect(approvals("invoice.pay")).toEqual([
      { by: { kind: "authenticated" }, staleOn: "resource-change" },
    ]);
    expect(approvals("invoice.void")).toEqual(["human"]);
    expect(catalogFingerprint(catalog)).toBe(catalog.fingerprint);
  });
});

describe("catalog rowConditions", () => {
  const rows = definePermissions({
    doc: resource({ actions: ["read", "update", "share"] }),
  });
  const conditioned = definePolicy(rows, {
    roles: [
      role("member", [
        allow(rows.doc.read),
        allow(rows.doc.update, { where: { locked: false } }),
      ]),
      role("lead", [allow(rows.doc.share, { to: plan("pro") })]),
    ],
    subject: () => null,
  });

  it("marks keys whose grants the SQL helpers cannot enforce", () => {
    const catalog = buildCatalog(
      rows,
      scan,
      "2026-09-29T00:00:00Z",
      conditioned,
    );
    const flag = (key: string): unknown =>
      catalog.permissions.find((item) => item.key === key)?.rowConditions;
    expect(flag("doc.read")).toBe(false);
    expect(flag("doc.update")).toBe(true);
    expect(flag("doc.share")).toBe(true);
  });

  it("marks every permission true without a policy, since the conditions are unknown", () => {
    const catalog = buildCatalog(rows, scan, "2026-09-29T00:00:00Z");
    expect(catalog.permissions[0]?.rowConditions).toBe(true);
  });

  it("flags a grant whose grantee list includes a plan", () => {
    const listed = definePolicy(rows, {
      roles: [],
      grants: [allow(rows.doc.share, { to: [plan("pro"), plan("team")] })],
      subject: () => null,
    });
    expect(policyRowConditionKeys(listed)).toEqual(new Set(["doc.share"]));
  });
});

describe("catalog approvals and roles", () => {
  const tree = definePermissions({
    doc: resource({
      actions: ["read", "sign"],
      relations: { tenant: { field: "tenant_id", memberOf: "tenant" } },
    }),
  });
  const owner = role("owner", [allow(tree.doc.sign, { approval: "human" })], {
    on: "tenant",
    min: 1,
    max: 2,
    transferOnly: true,
  });
  const signer = role("signer", [allow(tree.doc.sign, { approval: "human" })], {
    on: "tenant",
    min: 0,
    activation: { maxDuration: 14_400, justification: "required" },
  });
  const approver = role("approver", [allow(tree.doc.read)], {
    on: "tenant",
    activation: { justification: "optional", approval: "human" },
  });
  const reviewer = role("reviewer", [allow(tree.doc.read)], { on: tree.doc });
  const scopes: PolicyScopesInput = { tenant: { key: "tenant_id" } };
  const rolesPolicy = definePolicy(tree, {
    scopes,
    roles: [
      owner,
      signer,
      approver,
      reviewer,
      supportAccess({
        role: "support",
        actorRequired: true,
        consent: { by: "owner", durations: [3600, 3600, 86_400] },
        group: "vendor",
      }),
    ],
    subject: () => null,
  });
  const catalog = buildCatalog(
    tree,
    { ...scan, roleNames: [] },
    "2026-10-01T00:00:00Z",
    rolesPolicy,
  );
  const roleOf = (key: string): unknown =>
    catalog.roles?.find((item) => item.key === key);
  const scoped = buildCatalog(tree, scan, "2026-10-01T00:00:00Z", rolesPolicy);

  it("lists one approval per distinct requirement", () => {
    expect(
      catalog.permissions.find((item) => item.key === "doc.sign")?.approvals,
    ).toEqual(["human"]);
  });

  it("lists the declared scopes", () => {
    expect(catalog.scopes).toEqual([{ name: "tenant", key: "tenant_id" }]);
  });

  it("describes ownership, activation, resource and support roles", () => {
    expect({
      owner: roleOf("owner"),
      signer: roleOf("signer"),
      approver: roleOf("approver"),
      reviewer: roleOf("reviewer"),
      support: roleOf("support"),
    }).toEqual({
      owner: {
        key: "owner",
        on: "tenant",
        assignable: expect.any(Boolean),
        min: 1,
        max: 2,
        transferOnly: true,
      },
      signer: {
        key: "signer",
        on: "tenant",
        assignable: expect.any(Boolean),
        activation: { maxDuration: 14_400, justification: "required" },
      },
      approver: {
        key: "approver",
        on: "tenant",
        assignable: expect.any(Boolean),
        activation: { justification: "optional", approval: true },
      },
      reviewer: {
        key: "reviewer",
        on: "resource",
        assignable: expect.any(Boolean),
      },
      support: expect.objectContaining({
        key: "support",
        on: "tenant",
        for: ["support"],
        supportAccess: {
          actorRequired: true,
          group: "vendor",
          durations: [3600, 86_400],
        },
      }),
    });
  });

  it("omits roles when neither the scan nor the policy has any", () => {
    const bare = definePolicy(tree, { roles: [], subject: () => null });
    const empty = buildCatalog(
      tree,
      { ...scan, roleNames: [] },
      "2026-10-01T00:00:00Z",
      bare,
    );
    expect(empty).not.toHaveProperty("roles");
    expect(empty).not.toHaveProperty("scopes");
  });

  it("lists scanned roles as bare keys without a policy", () => {
    expect(buildCatalog(tree, scan, "2026-10-01T00:00:00Z").roles).toEqual([
      { key: "clerk" },
    ]);
    expect(
      buildCatalog(tree, { ...scan, roleNames: [] }, "2026-10-01T00:00:00Z"),
    ).not.toHaveProperty("roles");
  });

  it("lists a scanned role the policy does not bind as a bare key", () => {
    expect(roleOf("clerk")).toBeUndefined();
    expect(scoped.roles?.map((item) => item.key)).toEqual([
      "approver",
      "clerk",
      "owner",
      "reviewer",
      "signer",
      "support",
    ]);
    expect(scoped.roles?.[1]).toEqual({ key: "clerk" });
  });
});

describe("catalog oauthScopes", () => {
  const tree = definePermissions({
    task: resource({ actions: ["read", "update", "delete"] }),
    note: resource({ actions: ["read"] }),
  });
  const scoped = definePolicy(tree, {
    roles: [],
    oauthScopes: {
      "mcp:write": [tree.task.update, tree.task.read],
      "mcp:read": [tree.task.read, tree.note],
    },
    subject: () => null,
  });

  it("lists each coarse scope with its keys, sorted by code point", () => {
    const catalog = buildCatalog(tree, scan, "2026-10-18T00:00:00Z", scoped);
    expect(catalog.oauthScopes).toEqual([
      { scope: "mcp:read", permissions: ["note.read", "task.read"] },
      { scope: "mcp:write", permissions: ["task.read", "task.update"] },
    ]);
    expect(() => parseCatalog(JSON.stringify(catalog))).not.toThrow();
    expect(catalogFingerprint(catalog)).toBe(catalog.fingerprint);
  });

  it("omits oauthScopes when the policy declares none", () => {
    const bare = definePolicy(tree, { roles: [], subject: () => null });
    expect(
      buildCatalog(tree, scan, "2026-10-18T00:00:00Z", bare),
    ).not.toHaveProperty("oauthScopes");
  });

  it("rejects an entry without permissions", () => {
    const catalog = buildCatalog(tree, scan, "2026-10-18T00:00:00Z", scoped);
    expect(() =>
      parseCatalog(
        JSON.stringify({ ...catalog, oauthScopes: [{ scope: "mcp:read" }] }),
      ),
    ).toThrow("oauthScopes.0");
  });
});

describe("catalog grants", () => {
  const Doc = z.object({ id: z.string(), ownerId: z.string() });
  const grantsPermissions = definePermissions({
    doc: resource(Doc, { id: "id", actions: ["read", "update", "delete"] }),
  });
  const build = (declarationOrder: "a" | "b") => {
    const member = [
      allow(grantsPermissions.doc.read),
      allow(grantsPermissions.doc.update, {
        where: { ownerId: principal.id },
        fields: ["ownerId"],
        validFrom: "2023-11-14T22:13:20Z",
      }),
      deny(grantsPermissions.doc.delete, { name: "keep" }),
      allow(
        grantsPermissions.doc.delete,
        (row: { id: string }) => row.id !== "root",
      ),
    ];
    return definePolicy(grantsPermissions, {
      roles: [
        role("member", declarationOrder === "a" ? member : member.toReversed()),
      ],
      grants: [allow(grantsPermissions.doc.read, { to: anyone() })],
      subject: () => null,
    });
  };

  it("lists every code grant in canonical order, without closures", () => {
    const catalog = buildCatalog(
      grantsPermissions,
      scan,
      "2026-09-29T00:00:00Z",
      build("a"),
    );
    expect(catalog.grants).toEqual([
      {
        permission: "doc.delete",
        effect: "allow",
        role: "member",
        to: { kind: "role", role: "member", scope: "global" },
        scope: "global",
        portable: false,
      },
      {
        permission: "doc.delete",
        effect: "deny",
        role: "member",
        to: { kind: "role", role: "member", scope: "global" },
        scope: "global",
        name: "keep",
      },
      {
        permission: "doc.read",
        effect: "allow",
        role: "member",
        to: { kind: "role", role: "member", scope: "global" },
        scope: "global",
      },
      {
        permission: "doc.read",
        effect: "allow",
        role: null,
        to: { kind: "anyone" },
        scope: "global",
      },
      {
        permission: "doc.update",
        effect: "allow",
        role: "member",
        to: { kind: "role", role: "member", scope: "global" },
        scope: "global",
        where: { op: "eq", field: "ownerId", value: { ref: "principal.id" } },
        fields: ["ownerId"],
        validity: { from: "2023-11-14T22:13:20.000Z" },
      },
    ]);
    expect(catalogGrants(build("b"))).toEqual(catalog.grants);
  });

  it("is part of the fingerprint and validates against the schema", () => {
    const withGrants = buildCatalog(
      grantsPermissions,
      scan,
      "2026-09-29T00:00:00Z",
      build("a"),
    );
    const without = buildCatalog(
      grantsPermissions,
      scan,
      "2026-09-29T00:00:00Z",
    );
    expect(without).not.toHaveProperty("grants");
    expect(withGrants.fingerprint).not.toBe(without.fingerprint);
    expect(() => parseCatalog(JSON.stringify(withGrants))).not.toThrow();
    expect(() =>
      parseCatalog(
        JSON.stringify({
          ...withGrants,
          grants: [
            {
              permission: "doc.read",
              effect: "maybe",
              role: null,
              to: {},
              scope: "global",
            },
          ],
        }),
      ),
    ).toThrow("grants.0.effect");
  });
});
