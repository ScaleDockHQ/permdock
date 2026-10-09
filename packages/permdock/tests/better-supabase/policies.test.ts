import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { Permission } from "../../src/core/permissions.ts";

import { bucketPolicy, topicPolicy } from "../../src/better-supabase/index.ts";

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
    expect(policy).toEqual({
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
      bucketPolicy(access("quotes.read"), {
        ...options,
        catalog: conditioned,
      }),
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
    ).toEqual({
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
