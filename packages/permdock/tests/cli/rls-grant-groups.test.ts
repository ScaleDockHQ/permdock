import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";
import type { RoleBinding } from "../../src/index.ts";

import { compileGrants } from "../../src/cli/rls-compile.ts";
import { scopeList } from "../../src/core/scopes.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  principal,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions(
  {
    quote: resource({
      id: "id",
      actions: ["read"],
      relations: { org: { field: "orgId", memberOf: "tenant" } },
    }),
  },
  { renamed: { "offer.read": "quote.read" } },
);

const { quote } = permissions;

function policyWith(roles: readonly RoleBinding<"tenant">[]) {
  return definePolicy(permissions, {
    roles,
    scopes: { tenant: { key: "orgId" } },
    // SAFETY: SQL generation never calls the subject mapper; only the grants are read.
    subject: (user: unknown) => user as never,
  });
}

function keysOf(policy: ReturnType<typeof policyWith>): readonly string[] {
  const ctx: RlsSqlContext = {
    dialect: "supabase",
    tenantClaim: "tenant_id",
    scopes: scopeList(policy.scopes),
    gucPrefix: "app",
    tenantType: "text",
  };
  const compiled = compileGrants(policy, ctx, undefined, [], false);
  return [
    ...new Set(compiled.rolePermissions.map((row) => row.grantKey)),
  ].toSorted();
}

describe("grant groups", () => {
  it("names a condition group's grant key and keeps the positional keys of the others", () => {
    const keys = keysOf(
      policyWith([
        role("admin", [allow(quote.read)], { on: "tenant" }),
        role(
          "contact",
          [allow(quote.read, { where: { status: "sent" }, group: "sent" })],
          { on: "tenant" },
        ),
        role(
          "author",
          [allow(quote.read, { where: { ownerId: principal.id } })],
          { on: "tenant" },
        ),
      ]),
    );
    expect(keys).toEqual([
      "offer.read#1",
      "offer.read#3",
      "offer.read#sent",
      "quote.read#1",
      "quote.read#3",
      "quote.read#sent",
    ]);
  });

  it("keeps a named key when the other grants change", () => {
    const keys = keysOf(
      policyWith([
        role(
          "contact",
          [allow(quote.read, { where: { status: "sent" }, group: "sent" })],
          { on: "tenant" },
        ),
      ]),
    );
    expect(keys).toEqual(["offer.read#sent", "quote.read#sent"]);
  });

  it("refuses one group name on two conditions and two names on one condition", () => {
    expect(() =>
      keysOf(
        policyWith([
          role(
            "contact",
            [allow(quote.read, { where: { status: "sent" }, group: "open" })],
            { on: "tenant" },
          ),
          role(
            "author",
            [
              allow(quote.read, {
                where: { ownerId: principal.id },
                group: "open",
              }),
            ],
            { on: "tenant" },
          ),
        ]),
      ),
    ).toThrow(/share group 'open'/u);
    expect(() =>
      keysOf(
        policyWith([
          role(
            "contact",
            [allow(quote.read, { where: { status: "sent" }, group: "a" })],
            { on: "tenant" },
          ),
          role(
            "partner",
            [allow(quote.read, { where: { status: "sent" }, group: "b" })],
            { on: "tenant" },
          ),
        ]),
      ),
    ).toThrow(/name the groups a, b/u);
  });

  it("refuses a group name that is not a lower-case SQL suffix", () => {
    for (const group of ["Sent", "1st", "break-glass", "a b"]) {
      expect(() => allow(quote.read, { group })).toThrow(/group '/u);
    }
  });
});
