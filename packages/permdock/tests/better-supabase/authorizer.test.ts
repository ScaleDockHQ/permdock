import type { AuthorizationRequest } from "better-supabase/server";

import { testAuthorizer } from "better-supabase/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { Permission } from "../../src/core/permission-types.ts";

import { authorizer } from "../../src/better-supabase/index.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
  deny,
  resource,
  role,
} from "../../src/index.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const USER = "22222222-2222-4222-8222-222222222222";

const Quote = z.object({ id: z.string(), organization_id: z.string() });

const relations = {
  organization: { field: "organization_id", memberOf: "organization" },
} as const;

const permissions = definePermissions({
  quote: resource(Quote, {
    id: "id",
    actions: ["read", "update", "delete"],
    collection: ["list"],
    relations,
  }),
  export: resource(Quote, {
    id: "id",
    actions: [],
    collection: ["run"],
    relations,
  }),
});
const { quote } = permissions;

const roles = defineRoles({ editor: { on: "organization" } });
const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { organization: { key: "organization_id" } },
    // SAFETY: the authorizer always passes a Subject, which this resolver returns unchanged.
    subject: (user: unknown) => user as never,
    roles: [
      role(
        roles.editor,
        [
          allow([quote.read, quote.update, quote.delete, quote.list]),
          deny(quote.delete),
          allow(permissions.export.run, { approval: "human" }),
        ],
        { on: "organization" },
      ),
    ],
  },
);

const claims = (tenant: string = ORG, memberships = [ORG]) => ({
  sub: USER,
  role: "authenticated",
  tenant_id: tenant,
  memberships: memberships.map((id) => ({
    scope: "organization",
    id,
    roles: ["editor"],
  })),
});

const request = (
  action: Permission,
  overrides: {
    type?: string;
    claims?: Record<string, unknown>;
    tenant?: string;
    properties?: Record<string, unknown>;
  } = {},
): AuthorizationRequest<Permission> => ({
  subject: {
    type: overrides.type ?? "user",
    id: USER,
    ...(overrides.claims === undefined
      ? {}
      : { properties: { claims: overrides.claims } }),
  },
  action,
  resource: {
    type: "quotes",
    ...(overrides.properties === undefined
      ? {}
      : { properties: overrides.properties }),
  },
  context: overrides.tenant === undefined ? {} : { tenant: overrides.tenant },
});

const pd = authorizer({ policy });
const row = { id: "q1", organization_id: ORG };

describe("authorizer", () => {
  it("conforms to better-supabase's authorizer contract", async () => {
    await testAuthorizer(pd, {
      permissions: [quote.read, quote.update],
      unknown: { ...quote.read, key: "nothing.here" },
      granted: {
        permission: quote.read,
        context: {
          actor: { kind: "user", id: USER },
          tenant: ORG,
          claims: claims(),
        },
      },
    });
  });

  it("names itself and keys a permission", () => {
    expect(pd).toMatchObject({ apiVersion: 1, name: "PermDock" });
    expect(pd.key(quote.read)).toBe("quote.read");
    // SAFETY: a value that is not a PermDock permission, to prove key() refuses it.
    expect(() => pd.key({ key: "x" } as never)).toThrow(TypeError);
  });

  it("grants a held permission for the claims' memberships", async () => {
    expect(
      await pd.evaluate(
        request(quote.read, { claims: claims(), tenant: ORG, properties: row }),
      ),
    ).toStrictEqual({ outcome: "granted" });
  });

  it("denies a permission a deny overrides", async () => {
    expect(
      await pd.evaluate(
        request(quote.delete, {
          claims: claims(),
          tenant: ORG,
          properties: row,
        }),
      ),
    ).toMatchObject({
      outcome: "denied",
      reason: expect.stringContaining("quote.delete"),
    });
  });

  it("returns the approval token for an approval-required grant", async () => {
    const outcome = await pd.evaluate(
      request(permissions.export.run, { claims: claims(), tenant: ORG }),
    );
    expect(outcome).toMatchObject({
      outcome: "approval-required",
      approval: { id: expect.any(String) },
    });
  });

  it("denies a tenant the claims hold no membership in", async () => {
    expect(
      await pd.evaluate(
        request(quote.list, { claims: claims(), tenant: OTHER }),
      ),
    ).toMatchObject({ outcome: "denied" });
  });

  it("denies without claims and for non-user subjects", async () => {
    for (const type of ["anon", "service"]) {
      expect(
        await pd.evaluate(
          request(quote.list, { type, claims: claims(), tenant: ORG }),
        ),
      ).toMatchObject({ outcome: "denied" });
    }
    expect(
      await pd.evaluate(request(quote.list, { tenant: ORG })),
    ).toMatchObject({ outcome: "denied" });
  });

  it("ignores forged memberships in the resource properties", async () => {
    expect(
      await pd.evaluate(
        request(quote.read, {
          tenant: ORG,
          properties: {
            ...row,
            claims: claims(),
            memberships: claims().memberships,
          },
        }),
      ),
    ).toMatchObject({ outcome: "denied" });
  });

  it("keeps an agent's act chain", async () => {
    const outcome = await pd.evaluate(
      request(quote.list, {
        type: "agent",
        tenant: ORG,
        claims: { ...claims(), act: { sub: "agent-1" } },
      }),
    );
    // An actor with no delegation denies (invariant 1).
    expect(outcome).toMatchObject({ outcome: "denied" });
  });

  it("denies an unknown permission and a throwing source", async () => {
    expect(
      // SAFETY: a value that is not a PermDock permission, to prove evaluate refuses it.
      await pd.evaluate(request({ key: "x" } as never, { claims: claims() })),
    ).toMatchObject({ outcome: "denied" });
    const throwing = authorizer({
      policy,
      options: {
        // SAFETY: a deliberately broken source; only its throw matters.
        memberships: {
          async load() {
            throw new Error("down");
          },
        } as never,
      },
    });
    expect(
      await throwing.evaluate(
        request(quote.list, { claims: claims(), tenant: ORG }),
      ),
    ).toMatchObject({ outcome: "denied" });
  });

  it("answers a batch in order with one instance per caller", async () => {
    const outcomes = await pd.evaluations!([
      request(quote.read, { claims: claims(), tenant: ORG, properties: row }),
      request(quote.delete, { claims: claims(), tenant: ORG, properties: row }),
      request(quote.read, { tenant: ORG, properties: row }),
    ]);
    expect(outcomes.map((o) => o.outcome)).toStrictEqual([
      "granted",
      "denied",
      "denied",
    ]);
  });

  it("resolves forOperation only when operations are given", () => {
    expect("forOperation" in pd).toBe(false);
    const withOperations = authorizer({
      policy,
      operations: { quotes: { list: quote.list } },
    });
    expect(withOperations.forOperation?.("quotes", "list")).toBe(quote.list);
    expect(withOperations.forOperation?.("quotes", "get")).toBeUndefined();
    expect(withOperations.forOperation?.("quotes", "drop")).toBeUndefined();
    expect(
      withOperations.forOperation?.("constructor", "list"),
    ).toBeUndefined();
  });
});
