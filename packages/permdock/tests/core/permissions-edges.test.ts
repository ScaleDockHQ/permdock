import { describe, expect, it } from "vitest";

import { allow, deny } from "../../src/core/grant-builders.ts";
import { memoryRoleSource } from "../../src/core/memory-sources.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import {
  findPermission,
  getResource,
  listPermissions,
  mergePermissions,
} from "../../src/core/permission-registry.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { role } from "../../src/core/role-builder.ts";
import { tree } from "../fixtures/org-tree.ts";

describe("permission tree and builder edges", () => {
  it("merges permission trees, finds keys and refuses an empty merge or a bare resource", () => {
    const billing = definePermissions({
      billing: {
        invoice: resource({ actions: ["pay"] }),
      },
    });
    const extra = definePermissions({
      billing: {
        credit: resource({ actions: ["refund"] }),
      },
    });
    const merged = mergePermissions(billing, extra);
    expect(findPermission(merged, "billing.invoice.pay")?.action).toBe("pay");
    expect(findPermission(merged, "constructor")).toBeUndefined();
    expect(() => mergePermissions()).toThrow(/at least one tree/);
    // SAFETY: neither a schema nor options, the input the runtime guard refuses.
    expect(() => resource(undefined as never)).toThrow(
      /requires a schema or options/,
    );
    expect(tree.post.read.meta).toEqual({ title: "Read" });
  });

  it("refuses duplicate resources and actions and finds no prototype keys", () => {
    expect(() =>
      mergePermissions(
        definePermissions({ post: resource({ actions: ["read"] }) }),
        definePermissions({ post: resource({ actions: ["write"] }) }),
      ),
    ).toThrow(/duplicate resource name/);
    expect(findPermission(tree, "constructor")).toBeUndefined();
    expect(findPermission(tree, "post:read")?.action).toBe("read");
    // SAFETY: deliberately a permission tree where resource() expects a schema.
    expect(() => resource(tree as never, { actions: ["read"] })).toThrow(
      /must be a schema or options/,
    );
    expect(getResource(tree, "missing")).toBeUndefined();
    expect(getResource(tree, "constructor")).toBeUndefined();
    expect(listPermissions(tree.post.read)).toHaveLength(1);
    expect(() =>
      definePermissions({ post: resource({ actions: ["read", "read"] }) }),
    ).toThrow(/duplicate action/);
    expect(() =>
      definePermissions({
        post: resource({ actions: ["read"], collection: ["read"] }),
      }),
    ).toThrow(/duplicate action/);
  });

  it("role and policy builders check scopes, resources, limits and validate", () => {
    expect(
      role("limited", [
        allow(tree.post.read, { limit: { count: 1, per: 3600 } }),
      ]).grants[0]?.portable,
    ).toBe(false);
    expect(deny([tree.post.read, tree.post.create])).toHaveLength(2);
    expect(() =>
      definePolicy(tree, {
        roles: [role("lead", [allow(tree.post.read)], { on: "team" })],
        subject: () => ({ id: "u1" }),
      }),
    ).toThrow(/must declare 'team'/);
    expect(() =>
      role("broken", [allow(tree.post.read)], {
        on: [tree.post.read, tree.org.read],
      }),
    ).toThrow(/exactly one resource/);
    const neverPolicy = definePolicy(tree, {
      roles: [role("member", [allow(tree.post.read)])],
      subject: () => ({ id: "u1", roles: ["member"] }),
      validate: "never",
    });
    expect(neverPolicy.validate).toBe("never");
    const source = memoryRoleSource([]);
    expect(source.rolesFor("missing")).toEqual([]);
    expect(
      role("nested", [deny([tree.post.read, tree.post.create])]).grants,
    ).toHaveLength(2);
    expect(() => role("empty-on", [allow(tree.post.read)], { on: [] })).toThrow(
      /exactly one resource/,
    );
  });
});
