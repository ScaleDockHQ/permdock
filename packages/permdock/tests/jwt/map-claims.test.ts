import type { StandardSchemaV1 } from "@standard-schema/spec";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  acceptMismatch,
  mapClaimsToSubject,
  validateCustomClaims,
} from "../../src/jwt/map-claims.ts";

const base = { iss: "https://idp.test", sub: "u1", exp: 2000 };

function principalOf(claims: Record<string, unknown>, options = {}) {
  const mapped = mapClaimsToSubject({ ...base, ...claims }, options);
  return mapped.subject.principal;
}

describe("mapClaimsToSubject principal", () => {
  it("is anonymous without a string sub", () => {
    for (const sub of [undefined, "", 7]) {
      const claims: Record<string, unknown> = { ...base, sub };
      expect(mapClaimsToSubject(claims, {}).subject.principal).toBeNull();
    }
  });

  it("splits space- and comma-separated role strings and reads SCIM value objects", () => {
    const cases: readonly [unknown, unknown][] = [
      ["admin editor", ["admin", "editor"]],
      ["admin,editor", ["admin", "editor"]],
      ["", undefined],
      [
        [{ value: "admin" }, { value: 1 }, null, "editor"],
        ["admin", "editor"],
      ],
      [{ admin: true }, undefined],
    ];
    for (const [roles, expected] of cases) {
      expect({ roles, mapped: principalOf({ roles })?.roles }).toEqual({
        roles,
        mapped: expected,
      });
    }
  });

  it("reads kind from a literal or a claim path", () => {
    const cases: readonly [string | undefined, unknown][] = [
      ["workload", "workload"],
      ["user", "user"],
      ["service", "service"],
      ["principal_type", "service"],
      ["missing", undefined],
      [undefined, undefined],
    ];
    for (const [kind, expected] of cases) {
      const options = kind === undefined ? {} : { claims: { kind } };
      expect({
        kind,
        mapped: principalOf({ principal_type: "service" }, options)?.kind,
      }).toEqual({ kind, mapped: expected });
    }
    expect(
      principalOf(
        { principal_type: "robot" },
        {
          claims: { kind: "principal_type" },
        },
      )?.kind,
    ).toBeUndefined();
  });

  it("reads assurance from default, renamed and nested paths", () => {
    const verified = {
      verification: { trust_framework: "eidas" },
      claims: { given_name: "Anne" },
    };
    expect(
      principalOf({
        acr: "aal2",
        amr: ["pwd", 1, "otp"],
        auth_time: 1000,
        verified_claims: verified,
      })?.assurance,
    ).toEqual({
      acr: "aal2",
      amr: ["pwd", "otp"],
      authTime: 1000,
      verified: [verified],
    });
    expect(
      principalOf(
        { level: "aal3", amr: ["hwk"] },
        { claims: { assurance: "level" } },
      )?.assurance,
    ).toEqual({ acr: "aal3", amr: ["hwk"] });
    expect(
      principalOf(
        { ext: { acr: "x", amr: ["y"], at: 5, vc: [verified] } },
        {
          claims: {
            assurance: {
              acr: "ext.acr",
              amr: "ext.amr",
              authTime: "ext.at",
              verified: "ext.vc",
            },
          },
        },
      )?.assurance,
    ).toEqual({ acr: "x", amr: ["y"], authTime: 5, verified: [verified] });
    expect(principalOf({ acr: 1 })?.assurance).toBeUndefined();
  });

  it("drops verified_claims entries without a trust framework or with forbidden keys", () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let depth = 0; depth < 20; depth += 1) {
      deep = { nested: deep };
    }
    const entries = [
      { verification: {}, claims: {} },
      { verification: { trust_framework: "x" }, claims: "no" },
      {
        verification: { trust_framework: "x" },
        claims: JSON.parse('{"__proto__":{"admin":true}}'),
      },
      { verification: { trust_framework: "x" }, claims: { list: [deep] } },
      "not-an-object",
    ];
    expect(
      principalOf({ verified_claims: entries })?.assurance,
    ).toBeUndefined();
  });

  it("copies the cnf members it knows onto the principal", () => {
    expect(
      principalOf({
        cnf: {
          jkt: "j",
          "x5t#S256": "x",
          jwk: { kty: "EC" },
          kid: "k",
          foo: 1,
        },
      })?.binding,
    ).toEqual({ jkt: "j", "x5t#S256": "x", jwk: { kty: "EC" }, kid: "k" });
    for (const cnf of [null, "jkt", ["jkt"], { jwk: null, kid: 1 }]) {
      expect({ cnf, binding: principalOf({ cnf })?.binding }).toEqual({
        cnf,
        binding: undefined,
      });
    }
  });
});

describe("mapClaimsToSubject memberships", () => {
  function memberships(value: unknown, options = {}) {
    return principalOf(
      { orgs: value },
      { claims: { memberships: "orgs" }, ...options },
    )?.memberships;
  }

  it("reads named-scope entries with within, via and expiry", () => {
    expect(
      memberships([
        {
          scope: "project",
          id: "p1",
          within: { tenant: "acme", bad: 1 },
          roles: ["editor"],
          via: "invite",
          expiresAt: 3000,
        },
        { scope: "project", id: "p2", within: "acme", roles: "viewer" },
      ]),
    ).toEqual([
      {
        scope: "project",
        id: "p1",
        within: { tenant: "acme" },
        roles: ["editor"],
        via: "invite",
        expiresAt: 3000,
      },
      { scope: "project", id: "p2", roles: ["viewer"] },
    ]);
  });

  it("reads tenant and org_id entries with a team", () => {
    expect(
      memberships([
        { tenant: "acme", roles: ["admin"], team: "eng" },
        { org_id: "globex", roles: "member" },
        { org_id: 7 },
        "ignored",
        null,
      ]),
    ).toEqual([
      { tenant: "acme", roles: ["admin"], team: "eng" },
      { tenant: "globex", roles: ["member"] },
    ]);
  });

  it("reads tenant maps of role arrays, role objects and Zitadel role maps", () => {
    expect(
      memberships({
        acme: ["admin"],
        globex: { roles: ["viewer"] },
        initech: { member: true },
        skipped: "x",
      }),
    ).toEqual([
      { tenant: "acme", roles: ["admin"] },
      { tenant: "globex", roles: ["viewer"] },
      { tenant: "initech", roles: [] },
    ]);
    expect(
      memberships({
        admin: { "org-1": "acme.test", "org-2": "globex.test" },
        viewer: { "org-1": "acme.test" },
      }),
    ).toEqual([
      { tenant: "org-1", roles: ["admin", "viewer"] },
      { tenant: "org-2", roles: ["admin"] },
    ]);
  });

  it("never reads a Zitadel map with a forbidden key or an empty map as roles", () => {
    expect(
      memberships(JSON.parse('{"admin":{"__proto__":"x"},"empty":{}}')),
    ).toEqual([
      { tenant: "admin", roles: [] },
      { tenant: "empty", roles: [] },
    ]);
  });

  it("adds group memberships in the active tenant only", () => {
    const options = {
      claims: { tenant: "org" },
      groupRoles: { eng: ["editor"] },
    };
    expect(
      principalOf({ org: "acme", groups: ["eng", "ops"] }, options)
        ?.memberships,
    ).toEqual([
      { tenant: "acme", roles: ["editor"], via: "group:eng" },
      { tenant: "acme", roles: [], via: "group:ops" },
    ]);
    expect(
      principalOf({ org: 1, groups: ["eng"] }, options)?.memberships,
    ).toBeUndefined();
  });
});

describe("mapClaimsToSubject actor and delegation", () => {
  it("reads act with a configured kind", () => {
    const mapped = mapClaimsToSubject(
      { ...base, act: { sub: "agent-1" }, cnf: { jkt: "j" } },
      { actor: { kind: "mcp-client" } },
    );
    expect({
      actor: mapped.subject.actor,
      binding: mapped.subject.principal?.binding,
      chain: mapped.subject.delegation?.chain,
    }).toEqual({
      actor: { id: "agent-1", kind: "mcp-client", binding: { jkt: "j" } },
      binding: undefined,
      chain: { sub: "agent-1" },
    });
  });

  it("marks an invalid act chain", () => {
    for (const act of [
      "agent",
      ["agent"],
      { sub: "" },
      { sub: "a", act: { sub: 1 } },
      { sub: "a", act: null },
    ]) {
      const mapped = mapClaimsToSubject({ ...base, act }, {});
      expect({
        act,
        invalidChain: mapped.invalidChain,
        principal: mapped.subject.principal,
      }).toEqual({ act, invalidChain: true, principal: null });
    }
  });

  it("uses an actor function and keeps the act claim as the chain", () => {
    const withActor = mapClaimsToSubject(
      { ...base, act: { sub: "x" }, scope: "read" },
      { actor: () => ({ id: "fn", kind: "service" }) },
    );
    expect({
      actor: withActor.subject.actor,
      delegation: withActor.subject.delegation,
    }).toEqual({
      actor: { id: "fn", kind: "service" },
      delegation: { scopes: ["read"], chain: { sub: "x" } },
    });
    const without = mapClaimsToSubject(base, { actor: () => undefined });
    expect(without.subject.actor).toBeUndefined();
  });

  it("reads delegation from renamed paths and drops it for id tokens", () => {
    const claims = {
      ...base,
      perms: "a b",
      rar: [{ type: "payment" }],
      gnap: [{ actions: ["read"] }],
      authorization_details: "not-an-array",
    };
    expect(
      mapClaimsToSubject(claims, {
        delegation: {
          scopes: "perms",
          authorizationDetails: "rar",
          access: "gnap",
        },
      }).subject.delegation,
    ).toEqual({
      scopes: ["a", "b"],
      authorizationDetails: [{ type: "payment" }],
      access: [{ actions: ["read"] }],
    });
    expect(
      mapClaimsToSubject({ ...base, scope: "read" }, { accept: "id-token" })
        .subject.delegation,
    ).toBeUndefined();
    expect(mapClaimsToSubject(base, {}).subject.delegation).toBeUndefined();
  });

  it("caps expiresAt at session_expiry and reads a renamed session claim", () => {
    const mapped = mapClaimsToSubject(
      { ...base, session_expiry: 1500, session: "s1" },
      { claims: { session: "session" } },
    );
    expect({
      expiresAt: mapped.subject.expiresAt,
      session: mapped.subject.session,
    }).toEqual({ expiresAt: 1500, session: "s1" });
    expect(
      mapClaimsToSubject({ iss: "x", sub: "u1", session_expiry: 1500 }, {})
        .subject.expiresAt,
    ).toBeUndefined();
  });
});

describe("custom claims", () => {
  it("keeps unreserved claims and validates them against the schema", () => {
    const schema = z.object({ plan: z.string() });
    expect(
      principalOf({ plan: "pro", name: "Anne", roles: ["x"] }, { schema })
        ?.claims,
    ).toEqual({ plan: "pro" });
    const invalid = mapClaimsToSubject({ ...base, plan: 1 }, { schema });
    expect({
      invalidClaims: invalid.invalidClaims,
      claims: invalid.subject.principal?.claims,
    }).toEqual({ invalidClaims: true, claims: undefined });
  });

  it("rejects an async schema", () => {
    const asyncSchema: StandardSchemaV1 = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async (value: unknown) => ({ value }),
      },
    };
    expect(validateCustomClaims({ a: 1 }, asyncSchema)).toEqual({ ok: false });
  });
});

describe("acceptMismatch", () => {
  const cases: readonly {
    readonly label: string;
    readonly claims: Record<string, unknown>;
    readonly typ?: string;
    readonly options: Parameters<typeof acceptMismatch>[2];
    readonly audience?: string | readonly string[];
    readonly expected: boolean;
  }[] = [
    {
      label: "id token with at+jwt typ",
      claims: { iat: 1 },
      typ: "at+jwt",
      options: { accept: "id-token" },
      expected: true,
    },
    {
      label: "id token with application/jwt typ",
      claims: { iat: 1, aud: "app" },
      typ: "application/JWT",
      options: { accept: "id-token" },
      expected: false,
    },
    {
      label: "id token without iat",
      claims: {},
      options: { accept: "id-token" },
      expected: true,
    },
    {
      label: "id token with several audiences and no azp",
      claims: { iat: 1, aud: ["a", "b"] },
      options: { accept: "id-token" },
      expected: true,
    },
    {
      label: "id token without aud",
      claims: { iat: 1 },
      options: { accept: "id-token" },
      expected: false,
    },
    {
      label: "id token with azp in a configured audience list",
      claims: { iat: 1, aud: ["a", "b"], azp: "a" },
      options: { accept: "id-token" },
      audience: ["a", "c"],
      expected: false,
    },
    {
      label: "id token with azp equal to the configured audience",
      claims: { iat: 1, aud: "a", azp: "a" },
      options: { accept: "id-token" },
      audience: "a",
      expected: false,
    },
    {
      label: "id token with azp and no configured audience",
      claims: { iat: 1, aud: "a", azp: "a" },
      options: { accept: "id-token" },
      expected: true,
    },
    {
      label: "id token with a non-string azp",
      claims: { iat: 1, aud: "a", azp: 1 },
      options: { accept: "id-token" },
      audience: "a",
      expected: true,
    },
    {
      label: "fapi2 access token without at+jwt",
      claims: {},
      typ: "jwt",
      options: { profile: "fapi2" },
      expected: true,
    },
    {
      label: "fapi2 access token with at+jwt",
      claims: {},
      typ: "at+jwt",
      options: { profile: "fapi2" },
      expected: false,
    },
    {
      label: "access token with a nonce",
      claims: { nonce: "n" },
      options: {},
      expected: true,
    },
    {
      label: "plain JWT access token for another first audience",
      claims: { aud: "b" },
      typ: "jwt",
      options: {},
      audience: ["a", "b"],
      expected: true,
    },
    {
      label: "plain JWT access token for the configured audience",
      claims: { aud: "a" },
      options: {},
      audience: "a",
      expected: false,
    },
    {
      label: "at+jwt access token for another audience",
      claims: { aud: "b" },
      typ: "at+jwt",
      options: {},
      audience: "a",
      expected: false,
    },
    {
      label: "access token with an aud array",
      claims: { aud: ["b"] },
      options: {},
      audience: "a",
      expected: false,
    },
  ];
  for (const item of cases) {
    it(item.label, () => {
      expect(
        acceptMismatch(item.claims, item.typ, item.options, item.audience),
      ).toBe(item.expected);
    });
  }
});
