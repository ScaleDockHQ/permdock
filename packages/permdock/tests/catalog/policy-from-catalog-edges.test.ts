import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { CatalogDocument } from "../../src/catalog/index.ts";
import type { ScanResult } from "../../src/cli/types.ts";

import {
  policyFromCatalog,
  pushedPolicy,
  resourceSchemaFromJson,
} from "../../src/catalog/index.ts";
import { buildCatalog } from "../../src/cli/catalog-doc.ts";
import {
  actor,
  allow,
  breakGlass,
  getPermDockSync,
  definePermissions,
  definePlans,
  definePolicy,
  defineRoles,
  deny,
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
  roleNames: [],
  planNames: ["pro"],
  allowKeys: [],
  snapshots: [],
  unparsed: [],
};

const permissions = definePermissions(
  {
    billing: {
      invoice: resource(z.object({ id: z.string(), orgId: z.string() }), {
        actions: { read: { readOnly: true }, void: {} },
        collection: ["list"],
        relations: { org: { field: "orgId", memberOf: "organization" } },
      }),
    },
    patient: resource({
      actions: ["read"],
      parent: { field: "parentId", resource: "patient" },
      restricted: { field: "restricted", stops: ["parent"] },
      version: "updatedAt",
      disclosure: "hide",
    }),
  },
  { renamed: { "billing.invoice.view": "billing.invoice.read" } },
);

const roles = defineRoles({
  owner: { on: "organization", assignable: true },
  auditor: {},
});
const plans = definePlans({ pro: {} });

const policy = definePolicy(
  { permissions, roles, plans },
  {
    scopes: { organization: { key: "orgId" } },
    hostable: [permissions.billing],
    roles: [
      role("clerk", [allow(permissions.billing.invoice.read)], {
        on: "organization",
        activation: { justification: "required", approval: "human" },
      }),
      supportAccess({
        role: "support",
        on: "organization",
        consent: { by: "owner", durations: [3600] },
        forbid: [permissions.patient],
      }),
    ],
    grants: [
      allow(permissions.billing.invoice.list, { to: roles.owner }),
      allow(permissions.billing.invoice.read, {
        to: roles.auditor,
        purpose: ["audit"],
        name: "audit-read",
      }),
      allow(permissions.billing.invoice.void, {
        to: plans.pro,
        validUntil: "2030-01-01T00:00:00Z",
        name: "pro-void",
      }),
      deny(permissions.patient.read, {
        to: { kind: "anyone" },
        where: { restricted: { eq: true } },
        name: "restricted-record",
      }),
      breakGlass(permissions.patient.read, {
        overrides: ["restricted-record"],
        requires: { reason: true },
        maxDuration: 600,
        obligations: ["notify"],
      }),
    ],
    delegations: [
      {
        from: roles.owner,
        to: actor("eve"),
        permissions: [permissions.billing.invoice],
        validUntil: "2030-01-01T00:00:00Z",
      },
    ],
    subject: () => null,
  },
);

function catalogOf(): CatalogDocument {
  return JSON.parse(
    JSON.stringify(
      buildCatalog(permissions, scan, "2026-10-01T00:00:00Z", policy),
    ),
  );
}

const pushed = JSON.parse(JSON.stringify(pushedPolicy(policy)));

describe("policyFromCatalog structure", () => {
  const rebuilt = policyFromCatalog(catalogOf(), pushed);

  it("rebuilds nested resources, renames, levels of detail and meta", () => {
    expect(rebuilt.resources.get("invoice")).toMatchObject({
      path: "billing.invoice",
    });
    expect(rebuilt.resources.get("patient")).toMatchObject({
      restricted: "restricted",
      restrictedStops: ["parent"],
      parent: { field: "parentId", resource: "patient" },
      version: "updatedAt",
      disclosure: "hide",
    });
    expect(
      rebuilt.grants.find(
        (grant) => grant.permission.key === "billing.invoice.read",
      )?.permission.meta,
    ).toEqual({ readOnly: true });
  });

  it("carries scopes, plans, vocabulary roles, activation and support", () => {
    expect(rebuilt.scopes).toEqual([{ name: "organization", key: "orgId" }]);
    expect(rebuilt.vocabulary.plans).toHaveProperty("pro");
    expect(rebuilt.vocabulary.roles).toHaveProperty("owner");
    expect(rebuilt.vocabulary.roles).toHaveProperty("auditor");
    expect(rebuilt.rolesByName.get("clerk")?.activation).toEqual({
      justification: "required",
      approval: "human",
    });
    expect(rebuilt.rolesByName.get("support")?.support).toMatchObject({
      role: "support",
      consent: { by: [], durations: [3600] },
    });
    expect(rebuilt.delegations).toEqual(policy.delegations);
    expect(rebuilt.hostable).toEqual(policy.hostable);
  });

  it("keeps validity, purpose, names and break-glass on grants", () => {
    const named = (name: string) =>
      rebuilt.grants.find((grant) => grant.name === name);
    expect(named("pro-void")).toMatchObject({
      validity: { until: 1_893_456_000 },
    });
    expect(named("audit-read")).toMatchObject({ purpose: ["audit"] });
    expect(
      rebuilt.grants.find((grant) => grant.breakGlass !== undefined)
        ?.breakGlass,
    ).toMatchObject({ overrides: ["restricted-record"], maxDuration: 600 });
  });

  it("takes catalog scopes when the push has none, and passes the user through by default", () => {
    const { scopes: _scopes, ...unscoped } = pushed;
    const hosted = policyFromCatalog(catalogOf(), unscoped);
    expect(hosted.scopes).toEqual([{ name: "organization", key: "orgId" }]);
    const principal = { id: "u1", plans: ["pro"] };
    const permdock = getPermDockSync(hosted, principal);
    expect(hosted.subject(principal)).toBe(principal);
    expect(
      permdock.can(
        hosted.grants.find((grant) => grant.name === "pro-void")?.permission ??
          permissions.billing.invoice.void,
        { id: "i1", orgId: "o1" },
      ),
    ).toBe(true);
  });
});

function withoutRename(
  leaf: CatalogDocument["permissions"][number] | undefined,
): Omit<CatalogDocument["permissions"][number], "renamedFrom"> {
  if (leaf === undefined) {
    throw new Error("empty catalog");
  }
  const { renamedFrom: _renamed, ...rest } = leaf;
  return rest;
}

describe("policyFromCatalog refusals", () => {
  function refuses(
    mutate: (catalog: CatalogDocument) => unknown,
    message: RegExp,
    push: unknown = pushed,
  ): void {
    expect(() => policyFromCatalog(mutate(catalogOf()), push)).toThrow(message);
  }

  it("refuses a permission whose resource the catalog does not list", () => {
    refuses(
      (catalog) => ({
        ...catalog,
        resources: { patient: catalog.resources["patient"] },
      }),
      /resource 'invoice' is missing/u,
    );
  });

  it("refuses a key that does not end in its action", () => {
    refuses(
      (catalog) => ({
        ...catalog,
        permissions: catalog.permissions.map((leaf) =>
          leaf.key === "patient.read" ? { ...leaf, action: "write" } : leaf,
        ),
      }),
      /does not end in its action/u,
    );
  });

  it("refuses leaves of one resource on two paths", () => {
    refuses(
      (catalog) =>
        JSON.stringify(catalog).replaceAll(
          '"billing.invoice.void"',
          '"other.invoice.void"',
        ),
      /sits apart from resource 'invoice'/u,
    );
  });

  it("refuses a resource nested under another resource or on its path", () => {
    const extra =
      (key: string, resourceName: string) => (catalog: CatalogDocument) => ({
        ...catalog,
        resources: {
          ...catalog.resources,
          [resourceName]: { id: "id", schema: null },
        },
        permissions: [
          ...catalog.permissions,
          {
            ...withoutRename(catalog.permissions[0]),
            key,
            scope: key.replaceAll(".", ":"),
            resource: resourceName,
            action: "read",
          },
        ],
      });
    refuses(
      extra("patient.note.read", "note"),
      /nests under another resource/u,
    );
    refuses(extra("billing.invoice.read", "dup"), /duplicate key/u);
  });

  it("refuses what definePermissions refuses", () => {
    refuses(
      (catalog) => ({
        ...catalog,
        resources: {
          ...catalog.resources,
          patient: {
            ...catalog.resources["patient"],
            relations: { org: { edge: 1 } },
          },
        },
      }),
      /policyFromCatalog/u,
    );
  });

  it("refuses an invalid condition and an unknown delegation permission", () => {
    const badWhere = {
      ...pushed,
      grants: [{ ...pushed.grants[0], where: { op: "eq", field: 1 } }],
    };
    expect(() => policyFromCatalog(catalogOf(), badWhere)).toThrow(
      /is not a portable condition/u,
    );
    refuses(
      (catalog) => ({
        ...catalog,
        delegations: [
          { ...catalog.delegations?.[0], permissions: ["ghost.read"] },
        ],
      }),
      /delegations\.0\.permissions\.0: delegation 'ghost.read' is not a declared permission key/u,
    );
    refuses(
      (catalog) => ({
        ...catalog,
        delegations: [
          {
            ...catalog.delegations?.[0],
            from: { kind: "actor", actor: "eve" },
          },
        ],
      }),
      /delegations\[0\] is invalid/u,
    );
  });
});

describe("resourceSchemaFromJson keywords", () => {
  const validate = (schema: unknown, value: unknown) =>
    resourceSchemaFromJson(schema)?.["~standard"].validate(value);

  it("interprets the supported subset", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      title: "Row",
      type: "object",
      required: ["id"],
      additionalProperties: false,
      $defs: { tag: { type: "string", minLength: 1, maxLength: 3 } },
      properties: {
        id: { type: "string", pattern: "^r" },
        tags: {
          type: "array",
          items: { $ref: "#/$defs/tag" },
          minItems: 0,
          maxItems: 2,
          uniqueItems: true,
        },
        n: { type: ["number", "null"], exclusiveMaximum: 10, minimum: 0 },
        kind: { anyOf: [{ const: "a" }, { enum: ["b"] }] },
        both: { allOf: [{ type: "integer" }, { maximum: 3 }] },
        one: { oneOf: [{ type: "string" }, { type: "boolean" }] },
        any: true,
        none: false,
        extra: { type: "object", additionalProperties: { type: "string" } },
      },
    };
    expect(validate(schema, { id: "r1", tags: ["a"], n: null })).toEqual({
      value: { id: "r1", tags: ["a"], n: null },
    });
    for (const bad of [
      { id: "x" },
      { id: "r", tags: ["abcd"] },
      { id: "r", tags: ["a", "b", "c"] },
      { id: "r", n: 10 },
      { id: "r", kind: "c" },
      { id: "r", both: 4 },
      { id: "r", none: 1 },
      { id: "r", extra: { a: 1 } },
      { id: "r", other: 1 },
      { id: "r", one: 1 },
    ]) {
      expect(validate(schema, bad)).toHaveProperty("issues");
    }
    expect(validate(schema, { id: "r", fn: () => 1 })).toHaveProperty("issues");
  });

  it("refuses shapes outside the subset", () => {
    for (const schema of [
      "string",
      { type: "date" },
      { pattern: 1 },
      { minimum: "1" },
      { minimum: Number.POSITIVE_INFINITY },
      { $ref: "https://example.com/s.json" },
      { properties: [] },
      { properties: { a: { not: {} } } },
      { anyOf: {} },
      { anyOf: [{ if: true }] },
      { items: { else: {} } },
    ]) {
      expect(validate(schema, "x")).toEqual({
        issues: [{ message: expect.stringMatching(/does not interpret/u) }],
      });
    }
  });

  it("reports a $ref to a missing definition as an issue", () => {
    expect(validate({ $ref: "#/$defs/missing" }, "x")).toEqual({
      issues: [{ message: "Unresolvable $ref" }],
    });
  });
});
