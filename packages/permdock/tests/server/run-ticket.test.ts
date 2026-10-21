import { SignJWT, importJWK } from "jose";
import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";

import type { AuthEvent } from "../../src/core/event-types.ts";
import type { Principal } from "../../src/core/subject.ts";
import type {
  RunTicketAutomations,
  RunTicketInput,
  RunTicketSubjectOptions,
} from "../../src/server/index.ts";

import { RUN_TICKET_SCHEMA } from "../../src/cli/token-schemas.ts";
import { allow } from "../../src/core/grant-builders.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { memoryPrincipalSource } from "../../src/core/principal-source.ts";
import { role } from "../../src/core/role-builder.ts";
import { joseTokenSigner } from "../../src/jwt/signer.ts";
import { joseTokenVerifier } from "../../src/jwt/verifier.ts";
import {
  parseRunTicket,
  RUN_TICKET_CLAIMS,
  signRunTicket,
  subjectFromRunTicket,
} from "../../src/server/index.ts";

const PRIVATE_JWK = {
  crv: "Ed25519",
  d: "qco_Uh5slpzay2a-eC3woOxpC4DlS6aEzLtBRjrdtd4",
  x: "79ab4WR6Eb9LkefWpmh5ZlvjXg7wqVGNMwIEHQqduIQ",
  kty: "OKP",
  kid: "2026-09",
  alg: "Ed25519",
};
const { d: _d, ...PUBLIC_JWK } = PRIVATE_JWK;
const ISSUER = "https://app.example.com";
const AUDIENCE = "https://runs.example.com";

const signer = joseTokenSigner({
  key: PRIVATE_JWK,
  alg: "Ed25519",
  kid: "2026-09",
  issuer: ISSUER,
  audience: AUDIENCE,
});
const verifier = joseTokenVerifier({
  jwks: { keys: [PUBLIC_JWK] },
  algorithms: ["Ed25519"],
});

const permissions = definePermissions({
  doc: resource({
    actions: ["read", "update"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role("member", [allow([permissions.doc.read, permissions.doc.update])], {
      on: "tenant",
    }),
  ],
  subject: (user: Principal | null) => user,
});

const ann: Principal = {
  id: "u_ann",
  memberships: [{ scope: "tenant", id: "o1", roles: ["member"] }],
};
const principals = memoryPrincipalSource({ principals: [ann] });
const doc = { id: "d1", orgId: "o1" };

const automations = (
  version: number | string = 3,
  revoked = false,
): RunTicketAutomations => ({
  automation: (id) => (id === "auto_1" ? { id, version, revoked } : null),
});

/**
 * What a JavaScript caller can pass: any field, including an explicit
 * `undefined`.
 */
type Loose<T> = { readonly [K in keyof T]?: T[K] | undefined };

const base: RunTicketInput = {
  principal: "u_ann",
  kind: "automation",
  actor: { id: "auto_1", kind: "automation" },
  delegation: { scopes: [permissions.doc.read.scope] },
  automation: { id: "auto_1", version: 3 },
  tenant: "o1",
  trigger: { type: "doc.created", doc: "d1" },
  binding: { connector: "slack", tools: ["post-message"] },
  expiresIn: 300,
};

async function resolve(
  token: string | null | undefined,
  extra: Loose<RunTicketSubjectOptions> = {},
): Promise<{
  readonly subject: Awaited<ReturnType<typeof subjectFromRunTicket>>;
  readonly causes: readonly (string | undefined)[];
}> {
  const events: AuthEvent[] = [];
  const subject = await subjectFromRunTicket(token, {
    verifier,
    principals,
    automations: automations(),
    issuer: ISSUER,
    audience: AUDIENCE,
    onAuth: (event) => {
      events.push(event);
    },
    // SAFETY: an explicit `undefined` stands for a field a JavaScript caller left out.
    ...(extra as Partial<RunTicketSubjectOptions>),
  });
  return { subject, causes: events.map((event) => event.cause) };
}

function claimsOf(token: string): Record<string, unknown> {
  const [, payload = ""] = token.split(".");
  const parsed: unknown = JSON.parse(
    Buffer.from(payload, "base64url").toString("utf8"),
  );
  if (parsed === null || typeof parsed !== "object") {
    throw new TypeError("expected a claims object");
  }
  return { ...parsed };
}

async function rawToken(
  claims: Record<string, unknown>,
  typ = "vnd.permdock.run+jwt",
): Promise<string> {
  const key = await importJWK(PRIVATE_JWK, "Ed25519");
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "Ed25519", kid: "2026-09", typ })
    .sign(key);
}

describe("RunTicket", () => {
  it("round-trips into the principal, actor, delegation, trigger and run", async () => {
    const token = await signRunTicket(base, signer);
    const claims = claimsOf(token);
    expect(claims).toMatchObject({
      v: 1,
      iss: ISSUER,
      sub: "u_ann",
      aud: AUDIENCE,
      kind: "automation",
      act: { sub: "auto_1", kind: "automation" },
      scope: "doc:read",
      automation: { id: "auto_1", version: 3 },
      tenant: "o1",
    });
    expect(Number(claims["exp"]) - Number(claims["iat"])).toBe(300);
    expect(parseRunTicket(claims)).toStrictEqual(claims);
    expect(Object.isFrozen(parseRunTicket(claims)?.trigger)).toBe(true);

    const { subject, causes } = await resolve(token);
    expect(causes).toStrictEqual([]);
    expect(subject.principal).toMatchObject({ id: "u_ann", tenant: "o1" });
    expect(subject.principal?.runTicket.jti).toBe(claims["jti"]);
    expect(subject.actor).toStrictEqual({ id: "auto_1", kind: "automation" });
    expect(subject.delegation).toStrictEqual({ scopes: ["doc:read"] });
    expect(subject.context).toStrictEqual({
      trigger: { type: "doc.created", doc: "d1" },
      run: {
        id: claims["jti"],
        kind: "automation",
        automation: { id: "auto_1", version: 3 },
        binding: { connector: "slack", tools: ["post-message"] },
      },
    });
    const permdock = getPermDockSync(policy, subject);
    expect(permdock.can(permissions.doc.read, doc)).toBe(true);
    expect(permdock.can(permissions.doc.update, doc)).toBe(false);
  });

  it("signs a job with authorization_details, an id and an instant expiry", async () => {
    const expiresAt = Temporal.Now.instant().add({ minutes: 5 });
    const token = await signRunTicket(
      {
        principal: "u_ann",
        kind: "job",
        actor: { id: "w_1", kind: "job", act: { sub: "scheduler" } },
        delegation: {
          authorizationDetails: [{ type: "doc", actions: ["read"] }],
        },
        id: "run_1",
        expiresAt,
      },
      signer,
    );
    const claims = claimsOf(token);
    expect(claims["jti"]).toBe("run_1");
    expect(claims["exp"]).toBe(Math.floor(expiresAt.epochMilliseconds / 1000));
    const { subject } = await resolve(token);
    expect(subject.actor).toStrictEqual({ id: "w_1", kind: "job" });
    expect(subject.delegation).toStrictEqual({
      authorizationDetails: [{ type: "doc", actions: ["read"] }],
      chain: { sub: "w_1", kind: "job", act: { sub: "scheduler" } },
    });
    expect(subject.context).toStrictEqual({
      run: { id: "run_1", kind: "job" },
    });
  });

  it("defaults the actor kind to the ticket kind and takes a caller without an actor", async () => {
    const claims = claimsOf(await signRunTicket(base, signer));
    const token = await rawToken({
      ...claims,
      kind: "caller",
      automation: undefined,
      act: { sub: "c_1" },
    });
    expect((await resolve(token)).subject.actor).toStrictEqual({
      id: "c_1",
      kind: "caller",
    });
    const plain = await signRunTicket(
      {
        principal: "u_ann",
        kind: "caller",
        delegation: { scopes: [] },
        expiresIn: 60,
      },
      signer,
    );
    const { subject } = await resolve(plain);
    expect(subject.actor).toBeUndefined();
    expect(subject.principal?.tenant).toBeUndefined();
    expect(
      getPermDockSync(policy, subject).can(permissions.doc.read, doc),
    ).toBe(false);
  });

  it("refuses an automation that is missing, revoked or changed", async () => {
    const token = await signRunTicket(base, signer);
    const cases: readonly [Loose<RunTicketSubjectOptions>, string][] = [
      [{ automations: undefined }, "automation-unavailable"],
      [{ automations: automations(3, true) }, "automation-unavailable"],
      [{ automations: automations("3") }, "automation-changed"],
      [{ automations: automations(4) }, "automation-changed"],
      [{ automations: { automation: () => null } }, "automation-unavailable"],
      [
        {
          automations: {
            automation: () => {
              throw new Error("down");
            },
          },
        },
        "automation-unavailable",
      ],
      [
        {
          automations: {
            automation: async () => ({ id: "other", version: 3 }),
          },
        },
        "automation-unavailable",
      ],
    ];
    for (const [extra, cause] of cases) {
      const { subject, causes } = await resolve(token, extra);
      expect(subject.principal).toBeNull();
      expect(causes).toStrictEqual([cause]);
    }
  });

  it("refuses a principal that is gone, renamed or a throwing source", async () => {
    const token = await signRunTicket(base, signer);
    const sources: readonly RunTicketSubjectOptions["principals"][] = [
      memoryPrincipalSource({ principals: [] }),
      { principal: () => ({ id: "someone-else" }) },
      {
        principal: () => {
          throw new Error("down");
        },
      },
    ];
    for (const source of sources) {
      const { subject, causes } = await resolve(token, { principals: source });
      expect(subject.principal).toBeNull();
      expect(causes).toStrictEqual(["owner-unavailable"]);
    }
  });

  it("reuses the token causes for verification failures", async () => {
    const token = await signRunTicket(base, signer);
    const [header, , signature] = token.split(".");
    const tampered = Buffer.from(
      JSON.stringify({ ...claimsOf(token), scope: "doc:read doc:update" }),
    ).toString("base64url");
    expect(
      (await resolve(`${header}.${tampered}.${signature}`)).causes,
    ).toStrictEqual(["invalid-signature"]);
    expect(
      (await resolve(token, { audience: "https://other.example.com" })).causes,
    ).toStrictEqual(["wrong-audience"]);
    expect(
      (await resolve(token, { issuer: "https://evil.example.com" })).causes,
    ).toStrictEqual(["wrong-issuer"]);
    expect(
      (
        await resolve(
          await rawToken(claimsOf(token), "vnd.permdock.capability+jwt"),
        )
      ).causes,
    ).toStrictEqual(["wrong-token-type"]);
    expect(
      (
        await resolve(token, {
          verifier: {
            verify: async () => ({
              ok: true,
              claims: claimsOf(token),
              header: { alg: "Ed25519" },
            }),
          },
        })
      ).causes,
    ).toStrictEqual(["wrong-token-type"]);
    expect(
      (
        await resolve(token, {
          verifier: {
            verify: () => {
              throw new Error("down");
            },
          },
        })
      ).causes,
    ).toStrictEqual(["malformed"]);
    expect(
      (
        await resolve(token, {
          verifier: {
            verify: async () => ({
              ok: true,
              claims: {
                ...claimsOf(token),
                exp: 1_000_000_001,
                iat: 1_000_000_000,
              },
              header: {
                alg: "Ed25519",
                typ: "application/vnd.permdock.run+jwt",
              },
            }),
          },
        })
      ).causes,
    ).toStrictEqual(["expired"]);
    expect((await resolve("")).subject.principal).toBeNull();
    expect((await resolve(null)).causes).toStrictEqual([]);
  });

  it("rejects claims that break the kind and automation rules", async () => {
    const claims = claimsOf(await signRunTicket(base, signer));
    const broken: readonly Record<string, unknown>[] = [
      { ...claims, automation: undefined },
      { ...claims, kind: "job" },
      { ...claims, kind: "cron" },
      { ...claims, v: 2 },
      { ...claims, scope: undefined },
      { ...claims, scope: 7 },
      { ...claims, automation: { id: "auto_1", version: -1 } },
      { ...claims, automation: { id: "", version: 1 } },
      { ...claims, act: { kind: "automation" } },
      { ...claims, act: { sub: "a", act: { sub: "" } } },
      { ...claims, binding: { tools: ["a", "a"] } },
      { ...claims, binding: { connector: 1 } },
      { ...claims, binding: "slack" },
      { ...claims, trigger: [1] },
      { ...claims, trigger: { at: new Date() } },
      { ...claims, trigger: { n: Number.NaN } },
      { ...claims, authorization_details: [{ actions: [] }] },
      { ...claims, authorization_details: "doc" },
      { ...claims, tenant: "" },
      { ...claims, aud: [] },
      { ...claims, exp: claims["iat"] },
      { ...claims, jti: undefined },
    ];
    for (const value of broken) {
      expect(parseRunTicket(value)).toBeUndefined();
    }
    expect(parseRunTicket(null)).toBeUndefined();
    expect(parseRunTicket({ ...claims, aud: [AUDIENCE] })?.aud).toStrictEqual([
      AUDIENCE,
    ]);
    const token = await rawToken({ ...claims, kind: "job" });
    expect((await resolve(token)).causes).toStrictEqual(["invalid-claims"]);
  });

  it("is prototype-safe", async () => {
    const claims = claimsOf(await signRunTicket(base, signer));
    const inherited: unknown = Object.create({ ...claims });
    expect(parseRunTicket(inherited)).toBeUndefined();
    const polluted: unknown = JSON.parse(
      `{"__proto__":{"scope":"doc:update"},${JSON.stringify(claims).slice(1)}`,
    );
    expect(parseRunTicket(polluted)?.scope).toBe("doc:read");
    for (const trigger of [
      '{"__proto__":{"admin":true}}',
      '{"a":{"constructor":{"prototype":{"admin":true}}}}',
    ]) {
      const value: unknown = JSON.parse(trigger);
      expect(parseRunTicket({ ...claims, trigger: value })).toBeUndefined();
    }
    const token = await rawToken(
      // SAFETY: the JSON text is an object literal.
      JSON.parse(
        `{"__proto__":{"admin":true},${JSON.stringify(claims).slice(1)}`,
      ) as Record<string, unknown>,
    );
    const { subject } = await resolve(token);
    expect(subject.principal?.id).toBe("u_ann");
    expect(Object.prototype).not.toHaveProperty("admin");
    expect(Object.prototype).not.toHaveProperty("scope");
  });

  it("throws on input a verifier would refuse", () => {
    const bad: readonly Loose<RunTicketInput>[] = [
      { expiresIn: undefined },
      { expiresAt: Temporal.Now.instant().add({ minutes: 5 }) },
      { expiresIn: 0 },
      { expiresIn: 1.5 },
      {
        expiresIn: undefined,
        expiresAt: Temporal.Instant.from("2020-01-01T00:00:00Z"),
      },
      { automation: undefined },
      { kind: "job" },
      { actor: { id: "", kind: "automation" } },
      { actor: { id: "a", kind: "automation", act: { sub: 1 } } },
      { trigger: { at: new Date() } },
      { principal: "" },
      { id: "" },
    ];
    for (const extra of bad) {
      // SAFETY: an explicit `undefined` stands for a field a JavaScript caller left out.
      const input = { ...base, ...extra } as RunTicketInput;
      expect(() => signRunTicket(input, signer)).toThrow(/run ticket/u);
    }
  });
});

describe("RUN_TICKET_CLAIMS", () => {
  it("lists every claim parseRunTicket keeps and the run-v1 schema names", () => {
    const now = Math.floor(Date.now() / 1000);
    const full = {
      v: 1,
      iss: ISSUER,
      sub: "u_ann",
      aud: AUDIENCE,
      jti: "r1",
      iat: now,
      exp: now + 60,
      kind: "automation",
      act: { sub: "bot", kind: "automation" },
      scope: "doc:read",
      authorization_details: [{ type: "permdock" }],
      automation: { id: "auto_1", version: 3 },
      tenant: "o1",
      trigger: { event: "cron" },
      binding: { connector: "c1", tools: ["t1"] },
      extra: "dropped",
    };
    const parsed = parseRunTicket(full);
    expect(Object.keys(parsed ?? {}).toSorted()).toStrictEqual(
      [...RUN_TICKET_CLAIMS].toSorted(),
    );
    expect(
      Object.keys(
        // SAFETY: the schema literal declares `properties` as an object.
        RUN_TICKET_SCHEMA["properties"] as Record<string, unknown>,
      ).toSorted(),
    ).toStrictEqual([...RUN_TICKET_CLAIMS].toSorted());
    expect(Object.isFrozen(RUN_TICKET_CLAIMS)).toBe(true);
  });
});
