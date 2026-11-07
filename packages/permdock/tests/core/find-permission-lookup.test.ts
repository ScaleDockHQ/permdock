import { describe, expect, it } from "vitest";

import { resource } from "../../src/core/permission-leaf.ts";
import { findPermission } from "../../src/core/permission-registry.ts";
import { definePermissions } from "../../src/core/permissions.ts";

const permissions = definePermissions(
  { post: resource({ id: "id", actions: ["read", "update"] }) },
  { renamed: { "article.read": "post.read" } },
);

describe(findPermission, () => {
  it("finds a leaf by key, scope and former key, and nothing else", () => {
    expect(findPermission(permissions, "post.read")).toBe(
      permissions.post.read,
    );
    expect(findPermission(permissions, permissions.post.update.scope)).toBe(
      permissions.post.update,
    );
    expect(findPermission(permissions, "article.read")).toBe(
      permissions.post.read,
    );
    expect(findPermission(permissions, "post.delete")).toBeUndefined();
    expect(findPermission(permissions, "__proto__")).toBeUndefined();
  });
});
