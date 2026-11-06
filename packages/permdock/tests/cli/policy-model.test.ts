import { describe, expect, it } from "vitest";

import { policyModel } from "../../src/cli/generate/model.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions({
  doc: resource({
    actions: ["read"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  subject: () => null,
  roles: [
    role(
      "admin",
      [
        allow(permissions.doc.read, {
          where: { op: "eq", field: "status", value: "open" },
        }),
        allow(permissions.doc.read, () => false),
      ],
      { on: "tenant" },
    ),
  ],
});

describe(policyModel, () => {
  const model = policyModel(policy);

  it("round-trips through structuredClone", () => {
    expect(structuredClone(model)).toStrictEqual(model);
  });

  it("keeps the leaf and drops the closure", () => {
    expect(model.permissions).toStrictEqual([
      {
        key: "doc.read",
        resource: "doc",
        action: "read",
        scope: permissions.doc.read.scope,
        meta: permissions.doc.read.meta,
      },
    ]);
    expect(model.roles[0]?.grants[0]?.where).toStrictEqual({
      portable: true,
      condition: { op: "eq", field: "status", value: "open" },
    });
    expect(model.roles[0]?.grants[1]?.where).toStrictEqual({
      portable: false,
      key: "doc.read",
    });
    expect(JSON.stringify(model)).not.toContain("function");
  });
});
