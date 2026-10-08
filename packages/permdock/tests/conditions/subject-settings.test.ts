import { describe, expect, it } from "vitest";

import type { Subject } from "../../src/core/subject.ts";

import {
  statementText,
  subjectStatements,
} from "../../src/conditions/subject-settings.ts";

const user: { readonly subject: Subject } = {
  subject: { principal: { id: "u1", tenant: "o1" }, context: {} },
};

const anonymous: { readonly subject: Subject } = {
  subject: { principal: null, context: {} },
};

function texts(holder: { readonly subject: Subject }, options = {}): string[] {
  return subjectStatements(holder, options).map(statementText);
}

describe("subjectStatements", () => {
  it("sets authenticated and the JWT claims for Supabase and Neon", () => {
    for (const dialect of ["supabase", "neon"] as const) {
      const statements = subjectStatements(user, {
        dialect,
        claims: { user_role: "admin", sub: "forged", role: "service_role" },
      });
      expect(statements.map(statementText)).toEqual([
        "select set_config('role', $1, true), set_config('request.jwt.claims', $2, true)",
      ]);
      expect(statements[0]?.values[0]).toBe("authenticated");
      expect(JSON.parse(statements[0]?.values[1] ?? "")).toEqual({
        user_role: "admin",
        sub: "u1",
        tenant_id: "o1",
        role: "authenticated",
      });
    }
  });

  it("sets one setting per claim under the guc prefix", () => {
    const statements = subjectStatements(user, {
      dialect: "guc",
      gucPrefix: "acme",
      tenantClaim: "org_id",
      claims: { memberships: [{ tenant: "o1" }] },
    });
    expect(statements.map(statementText)).toEqual([
      "select set_config('role', $1, true), set_config('acme.user_id', $2, true), " +
        "set_config('acme.memberships', $3, true), set_config('acme.org_id', $4, true), " +
        "set_config('acme.role', $5, true)",
    ]);
    expect(statements[0]?.values).toEqual([
      "authenticated",
      "u1",
      '[{"tenant":"o1"}]',
      "o1",
      "authenticated",
    ]);
  });

  it("uses anon without a principal and can keep the connection role", () => {
    expect(subjectStatements(anonymous)[0]?.values[0]).toBe("anon");
    expect(texts(user, { role: false })[0]).toBe(
      "select set_config('request.jwt.claims', $1, true)",
    );
  });

  it("writes the API-key claim with an empty sub for a service credential", () => {
    const service: { readonly subject: Subject } = {
      subject: {
        principal: {
          id: "svc_billing",
          kind: "service",
          tenant: "o1",
          credential: {
            id: "key_2",
            kind: "service",
            tenant: "o1",
            roles: ["developer"],
            permissions: [
              { permission: "task.read" },
              { permission: "task.update", ids: ["t1"] },
            ],
          },
        },
        context: {},
      },
    };
    const statements = subjectStatements(service);
    expect(JSON.parse(statements[0]?.values[1] ?? "")).toEqual({
      sub: "",
      tenant_id: "o1",
      role: "authenticated",
      api_key: {
        id: "key_2",
        tenant: "o1",
        roles: ["developer"],
        scopes: ["task.read"],
      },
    });
    expect(subjectStatements(service, { dialect: "guc" })[0]?.values[1]).toBe(
      "",
    );
  });

  it("keeps the owner as sub for a user credential and renames the claim fields", () => {
    const key: { readonly subject: Subject } = {
      subject: {
        principal: {
          id: "u1",
          credential: {
            id: "key_1",
            kind: "user",
            permissions: [{ permission: "task.read" }],
          },
        },
        context: {},
      },
    };
    const statements = subjectStatements(key, {
      apiKeys: { claim: "key", scopes: "allowed" },
    });
    expect(JSON.parse(statements[0]?.values[1] ?? "")).toEqual({
      sub: "u1",
      role: "authenticated",
      key: { id: "key_1", allowed: ["task.read"] },
    });
  });

  it("refuses any other role and unsafe setting names", () => {
    // SAFETY: a deliberately forbidden role to exercise subjectStatements' refusal.
    expect(() =>
      subjectStatements(user, { role: "service_role" as never }),
    ).toThrow(/authenticated or anon/);
    expect(() =>
      subjectStatements(user, { dialect: "guc", gucPrefix: "app'; drop" }),
    ).toThrow(/unsafe setting prefix/);
    expect(() =>
      subjectStatements(user, { dialect: "guc", claims: { "a.b": 1 } }),
    ).toThrow(/unsafe claim name/);
  });
});
