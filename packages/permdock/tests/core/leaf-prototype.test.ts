import { describe, expect, it } from "vitest";
import { z } from "zod";

import { resource } from "../../src/core/permission-leaf.ts";
import { listPermissions } from "../../src/core/permission-registry.ts";
import { definePermissions } from "../../src/core/permissions.ts";

const permissions = definePermissions(
  {
    post: resource({
      id: "id",
      actions: {
        read: { title: "Read", x: { tier: "free" } },
        update: { readOnly: false, destructive: true },
      },
      collection: { create: {} },
      meta: { title: "Post", x: { area: "content" } },
    }),
    billing: resource({ actions: ["manage"] }),
  },
  {
    x: {
      action: z.object({ tier: z.string() }),
      resource: z.object({ area: z.string() }),
    },
  },
);

function nested(
  value: unknown,
  path: string,
  seen = new Set<unknown>(),
): string[] {
  if (value === null || typeof value !== "object" || seen.has(value)) {
    return [];
  }
  seen.add(value);
  const bad =
    Object.getPrototypeOf(value) === Object.prototype || Array.isArray(value)
      ? []
      : [path];
  return [
    ...bad,
    ...Object.entries(value).flatMap(([key, item]) =>
      nested(item, `${path}.${key}`, seen),
    ),
  ];
}

describe("permission leaves", () => {
  // A Server Component passes `permissions.*` to a Client Component, which React serialises: a null prototype anywhere fails there.
  it("are plain frozen JSON with Object.prototype at every level", () => {
    const leaves = listPermissions(permissions);
    expect(leaves.length).toBeGreaterThan(0);
    expect(nested(permissions, "permissions")).toEqual([]);
    for (const leaf of leaves) {
      expect(nested(leaf, leaf.key)).toEqual([]);
      expect(Object.isFrozen(leaf)).toBe(true);
      expect(Object.isFrozen(leaf.meta)).toBe(true);
    }
  });
});
