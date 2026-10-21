import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { Permission } from "../../src/core/permission-types.ts";

import { bucketPolicy, topicPolicy } from "../../src/better-supabase/index.ts";
import {
  permissions as fixture,
  policy as fixturePolicy,
} from "../fixtures/named-scopes.ts";

const read = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const EXAMPLE = "../../../../apps/examples/next-better-supabase/";
const manifest = read(`${EXAMPLE}permdock.manifest.json`);
// SAFETY: the example catalog is a valid catalog document; the tests edit copies of it.
const catalog = read(`${EXAMPLE}permissions.catalog.json`) as {
  permissions: { key: string; rowConditions: boolean }[];
};

const permission = (key: string): Permission => ({
  key,
  scope: key.replace(".", ":"),
  resource: key.split(".")[0]!,
  action: key.split(".")[1]!,
  meta: {},
  kind: "instance",
});
const options = { manifest, catalog, scope: "organization" } as const;

describe("bucketPolicy", () => {
  it("checks catalog keys with the helpers at the scope", () => {
    const policy = bucketPolicy(
      {
        read: permission("quotes.read"),
        list: permission("quotes.list"),
        write: permission("quotes.update"),
        delete: permission("quotes.update"),
      },
      { ...options, segment: 2 },
    );
    expect(policy).toStrictEqual({
      access: {
        read: "quotes.read",
        list: "quotes.list",
        write: "quotes.update",
        delete: "quotes.update",
      },
      scope: "organization",
      segment: 2,
      sql: {
        idsWith: "permdock.permitted_{scope}_ids_by_permission({permission})",
        isPlatform: "permdock.permdock_has_permission({permission})",
      },
    });
    expect(Object.isFrozen(policy.access)).toBe(true);
  });

  it("refuses split keys, unknown keys and keys with row conditions", () => {
    const access = (key: string) => ({
      read: permission(key),
      write: permission("quotes.update"),
    });
    expect(() => bucketPolicy(access("quotes.read#1"), options)).toThrow(
      /split by row condition/u,
    );
    expect(() => bucketPolicy(access("quotes.delete"), options)).toThrow(
      /is not in permissions.catalog.json/u,
    );
    const conditioned = structuredClone(catalog);
    conditioned.permissions.find(
      (entry) => entry.key === "quotes.read",
    )!.rowConditions = true;
    expect(() =>
      bucketPolicy(access("quotes.read"), { ...options, catalog: conditioned }),
    ).toThrow(/has row conditions/u);
  });

  it("refuses a key checked at a scope it isn't granted at", () => {
    expect(() =>
      bucketPolicy(
        { read: permission("staff.read"), write: permission("staff.read") },
        { ...options, scope: "platform" },
      ),
    ).toThrow(/granted at organization, not at global/u);
  });

  it("refuses a scope the manifest doesn't declare", () => {
    expect(() =>
      bucketPolicy(
        { read: permission("quotes.read"), write: permission("quotes.read") },
        { ...options, scope: "team" },
      ),
    ).toThrow(/scope "team" is not in the manifest's rls.scopes/u);
  });
});

describe("topicPolicy", () => {
  it("checks receive and send", () => {
    expect(
      topicPolicy(
        { receive: permission("quotes.read"), send: permission("quotes.list") },
        { ...options, scope: "customer" },
      ),
    ).toStrictEqual({
      receive: "quotes.read",
      send: "quotes.list",
      scope: "customer",
      sql: {
        idsWith: "permdock.permitted_{scope}_ids_by_permission({permission})",
        isPlatform: "permdock.permdock_has_permission({permission})",
      },
    });
    expect(
      topicPolicy({ receive: permission("quotes.read") }, options),
    ).not.toHaveProperty("send");
  });
});

describe("policies from the policy definition", () => {
  const from = { policy: fixturePolicy, scope: "organization" } as const;

  it("checks the permissions without a manifest or a catalog", () => {
    expect(
      bucketPolicy(
        { read: fixture.asset.update, write: fixture.asset.update },
        { ...from, segment: 2 },
      ),
    ).toStrictEqual({
      access: { read: "asset.update", write: "asset.update" },
      scope: "organization",
      segment: 2,
      sql: {
        idsWith: "permdock.permitted_{scope}_ids_by_permission({permission})",
        isPlatform: "permdock.permdock_has_permission({permission})",
      },
    });
    expect(
      topicPolicy(
        { receive: fixture.asset.read },
        { policy: fixturePolicy, scope: "customer", schema: "authz" },
      ),
    ).toMatchObject({
      receive: "asset.read",
      sql: {
        idsWith: "authz.permitted_{scope}_ids_by_permission({permission})",
      },
    });
  });

  it("refuses a permission with a conditioned grant, a wrong scope and an unknown scope", () => {
    expect(() =>
      bucketPolicy(
        { read: fixture.quote.read, write: fixture.asset.update },
        from,
      ),
    ).toThrow(/has row conditions/u);
    expect(() =>
      bucketPolicy(
        { read: fixture.asset.update, write: fixture.asset.update },
        { policy: fixturePolicy, scope: "platform" },
      ),
    ).toThrow(/granted at organization, not at global/u);
    expect(() =>
      topicPolicy({ receive: fixture.asset.read }, { ...from, scope: "team" }),
    ).toThrow(/is not in the policy's scopes \(organization, customer\)/u);
  });

  it("keeps send, list, delete and the segment", () => {
    expect(
      topicPolicy(
        { receive: fixture.asset.read, send: fixture.asset.update },
        { ...from, segment: 3 },
      ),
    ).toMatchObject({ send: "asset.update", segment: 3 });
    expect(
      bucketPolicy(
        {
          read: fixture.asset.update,
          list: fixture.asset.update,
          write: fixture.asset.update,
          delete: fixture.asset.update,
        },
        from,
      ).access,
    ).toStrictEqual({
      read: "asset.update",
      list: "asset.update",
      write: "asset.update",
      delete: "asset.update",
    });
  });

  it("checks a permission granted globally at platform", () => {
    expect(
      topicPolicy(
        { receive: fixture.organization.read },
        { policy: fixturePolicy, scope: "platform" },
      ),
    ).toMatchObject({ receive: "organization.read", scope: "platform" });
  });
});
