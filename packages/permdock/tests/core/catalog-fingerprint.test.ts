import { describe, expect, it } from "vitest";

import { catalogFingerprint } from "../../src/core/catalog-fingerprint.ts";

const catalog = {
  $schema: "https://permdock.com/schemas/catalog-v1.json",
  version: 1,
  generatedAt: "2026-09-28T10:00:00.000Z",
  generator: "permdock 0.1.0",
  resources: { post: { id: "id", schema: null } },
  permissions: [
    {
      key: "post.read",
      scope: "post:read",
      resource: "post",
      action: "read",
      arity: "instance",
      meta: {},
      usages: [{ file: "src/a.ts", line: 1, call: "can" }],
      hostable: true,
    },
  ],
  roles: [{ key: "member", assignable: true }],
};

describe("catalogFingerprint", () => {
  it("is stable across key order, whitespace, clock, generator and usages", () => {
    const reordered: unknown = JSON.parse(
      JSON.stringify({
        roles: catalog.roles,
        permissions: catalog.permissions.map((permission) => ({
          ...permission,
          usages: [],
        })),
        resources: catalog.resources,
        version: 1,
        $schema: catalog.$schema,
        generatedAt: "2030-01-01T00:00:00.000Z",
        generator: "permdock 9.9.9",
        fingerprint: "stale",
      }),
    );
    expect(catalogFingerprint(reordered)).toBe(catalogFingerprint(catalog));
  });

  it("changes when the contract changes", () => {
    expect(
      catalogFingerprint({
        ...catalog,
        roles: [{ key: "member", assignable: false }],
      }),
    ).not.toBe(catalogFingerprint(catalog));
  });

  it("is base64url SHA-256 over sorted-key JSON", () => {
    expect(catalogFingerprint({ b: 1, a: [true, null] })).toBe(
      "UXBaLJ6z5-QQpY9pancMOsOIWgz0Prf8iPXkfBHU0w0",
    );
  });

  it("rejects a non-object", () => {
    expect(() => catalogFingerprint([])).toThrow(TypeError);
  });
});
