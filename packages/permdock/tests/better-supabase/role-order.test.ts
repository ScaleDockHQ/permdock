import { describe, expect, it } from "vitest";

import type { CatalogDocument, CatalogRole } from "../../src/catalog/types.ts";

import { roleOrderFromCatalog } from "../../src/better-supabase/index.ts";
import { betterSupabaseCatalog } from "../../src/testing/fixtures/index.ts";

function catalog(roles: readonly CatalogRole[]): CatalogDocument {
  return {
    $schema: "https://permdock.com/schemas/catalog-v1.json",
    version: 1,
    generatedAt: "2026-10-21T00:00:00.000Z",
    generator: "test",
    resources: {},
    permissions: [],
    roles,
  };
}

describe("roleOrderFromCatalog", () => {
  it("puts a role before the roles it assigns", () => {
    expect(
      roleOrderFromCatalog(
        catalog([
          { key: "viewer", on: "org" },
          { key: "member", on: "org", assigns: ["viewer"] },
          { key: "admin", on: "org", assigns: ["member", "viewer"] },
        ]),
      ),
    ).toEqual(["admin", "member", "viewer"]);
  });

  it("keeps catalog order for unordered roles and inside an assigns cycle", () => {
    expect(
      roleOrderFromCatalog(
        catalog([
          { key: "billing", on: "org" },
          { key: "a", on: "org", assigns: ["b", "a"] },
          { key: "b", on: "org", assigns: ["a"] },
          { key: "support", on: "org" },
        ]),
      ),
    ).toEqual(["billing", "a", "b", "support"]);
  });

  it("keeps one scope and leaves the owner out", () => {
    expect(
      roleOrderFromCatalog(
        catalog([
          { key: "owner", on: "org", assigns: ["admin", "member"] },
          { key: "member", on: "org" },
          { key: "admin", on: "org", assigns: ["member"] },
          { key: "contact", on: "customer" },
          { key: "staff" },
        ]),
        { scope: "org", owner: "owner" },
      ),
    ).toEqual(["admin", "member"]);
  });

  it("orders the next-better-supabase catalog's organization roles", () => {
    const published = betterSupabaseCatalog;
    expect(
      roleOrderFromCatalog(published, {
        scope: "organization",
        owner: "owner",
      }),
    ).toEqual(["member"]);
    expect(Object.isFrozen(roleOrderFromCatalog(published))).toBe(true);
  });
});
