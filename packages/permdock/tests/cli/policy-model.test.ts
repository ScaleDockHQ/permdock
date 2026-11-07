import { describe, expect, it } from "vitest";
import { z } from "zod";

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
    const where = model.roles[0]?.grants[0]?.where;
    expect(where?.portable).toBe(true);
    if (where?.portable === true) {
      expect(where.condition).toStrictEqual({
        op: "eq",
        field: "status",
        value: "open",
      });
      expect(where.rls).toContain("open");
      expect(where.stream).toContain("open");
      expect(where.stream).not.toContain("<>");
    }
    expect(model.roles[0]?.grants[1]?.where).toStrictEqual({
      portable: false,
      key: "doc.read",
    });
    expect(JSON.stringify(model)).not.toContain("function");
  });

  it("carries the resource JSON Schema and meta, clone-safe", () => {
    const typed = definePermissions({
      note: resource(z.object({ id: z.string(), body: z.string() }), {
        id: "id",
        actions: ["read"],
        meta: { title: "Note" },
      }),
    });
    const withSchema = policyModel(
      definePolicy(typed, { subject: () => null, roles: [] }),
    );
    const note = withSchema.resources[0];
    expect(note?.schema).toMatchObject({
      type: "object",
      properties: { id: { type: "string" }, body: { type: "string" } },
    });
    expect(note?.meta).toStrictEqual({ title: "Note" });
    expect(structuredClone(withSchema)).toStrictEqual(withSchema);
  });

  it("answers null for a resource with no schema", () => {
    expect(model.resources[0]?.schema).toBeNull();
    expect(model.resources[0]?.meta).toStrictEqual({});
  });
});
