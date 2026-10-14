import { Temporal } from "temporal-polyfill";
import { describe, expect, it } from "vitest";

import type { AuthEvent } from "../../src/core/event-types.ts";
import type { TokenVerifier } from "../../src/core/interfaces.ts";
import type { Principal } from "../../src/core/subject.ts";
import type { SupportSession } from "../../src/core/support-session.ts";

import { joseTokenSigner } from "../../src/jwt/signer.ts";
import { joseTokenVerifier } from "../../src/jwt/verifier.ts";
import {
  signSupportSession,
  subjectFromSupportSession,
} from "../../src/server/index.ts";
import {
  permdockFor,
  permissions,
  person,
  userSubject,
} from "../fixtures/automation.ts";

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
const AUDIENCE = "https://app.example.com/support";

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

function sessionFrom(now = Date.now()): SupportSession {
  return {
    v: 1,
    id: "ss_1",
    principal: "u_customer",
    actor: "u_staff",
    tenant: "o_1",
    reason: "Ticket 4411",
    permissions: ["invoice.read"],
    startedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(),
  };
}

function setup(
  people: readonly Principal[] = [
    person("u_customer", ["owner"]),
    person("u_staff", ["billing"]),
  ],
) {
  const directory = new Map(people.map((entry) => [entry.id, entry]));
  const causes: unknown[] = [];
  return {
    causes,
    options: {
      verifier,
      principals: { principal: (id: string) => directory.get(id) ?? null },
      permissions,
      audience: AUDIENCE,
      issuer: ISSUER,
      onAuth: (event: AuthEvent): void => {
        causes.push(event.cause);
      },
    },
  };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

describe("subjectFromSupportSession: failures are anonymous", () => {
  it("reports malformed when the verifier throws", async () => {
    const { options, causes } = setup();
    const subject = await subjectFromSupportSession("a.b.c", {
      ...options,
      verifier: {
        verify: () => Promise.reject(new Error("jwks down")),
      },
    });
    expect(subject.principal).toBeNull();
    expect(causes).toEqual(["malformed"]);
  });

  it("reports malformed when the verified result throws on read", async () => {
    const { options, causes } = setup();
    const subject = await subjectFromSupportSession("a.b.c", {
      ...options,
      verifier: {
        verify: () =>
          Promise.resolve({
            ok: true,
            header: { alg: "Ed25519", typ: "vnd.permdock.support-session+jwt" },
            get claims(): never {
              throw new Error("claims unreadable");
            },
          }),
      },
    });
    expect(subject.principal).toBeNull();
    expect(causes).toEqual(["malformed"]);
  });

  it("refuses a token signed with another typ, also through a verifier that accepts several", async () => {
    const { options, causes } = setup();
    const shared: TokenVerifier = {
      verify: (token, expectations) =>
        verifier.verify(token, {
          ...expectations,
          typ: [
            "vnd.permdock.support-session+jwt",
            "vnd.permdock.capability+jwt",
          ],
        }),
    };
    const token = await signer.sign(
      {
        v: 1,
        sub: "u_customer",
        act: { sub: "u_staff", kind: "support" },
        tenant: "o_1",
        reason: "Ticket 4411",
        permissions: ["invoice.read"],
      },
      {
        typ: "vnd.permdock.capability+jwt",
        expiresAt: nowSeconds() + 600,
        issuedAt: nowSeconds(),
        jti: "ss_1",
      },
    );
    expect(
      (await subjectFromSupportSession(token, options)).principal,
    ).toBeNull();
    expect(
      (
        await subjectFromSupportSession(token, {
          ...options,
          verifier: shared,
        })
      ).principal,
    ).toBeNull();
    expect(causes).toEqual(["wrong-token-type", "wrong-token-type"]);
  });

  it("refuses claims that are not a support session", async () => {
    const { options, causes } = setup();
    const claims = [
      { v: 1, sub: "u_customer", tenant: "o_1" },
      {
        v: 1,
        sub: "u_customer",
        act: { sub: "u_staff", kind: "agent" },
        tenant: "o_1",
        reason: "Ticket 4411",
        permissions: ["invoice.read"],
      },
      {
        v: 1,
        sub: "u_customer",
        act: { sub: "u_staff", kind: "support", act: { sub: "u_boss" } },
        tenant: "o_1",
        reason: "Ticket 4411",
        permissions: ["invoice.read"],
      },
    ];
    for (const payload of claims) {
      const token = await signer.sign(payload, {
        typ: "vnd.permdock.support-session+jwt",
        expiresAt: nowSeconds() + 600,
        issuedAt: nowSeconds(),
        jti: "ss_1",
      });
      expect(
        (await subjectFromSupportSession(token, options)).principal,
      ).toBeNull();
    }
    expect(causes).toEqual([
      "invalid-claims",
      "invalid-claims",
      "invalid-claims",
    ]);
  });

  it("denies an expired session even when the verifier's clock tolerance accepts it", async () => {
    const { options, causes } = setup();
    const token = await signSupportSession(
      sessionFrom(Date.now() - 7_200_000),
      signer,
    );
    const subject = await subjectFromSupportSession(token, {
      ...options,
      clockTolerance: 86_400,
    });
    expect(subject.principal).toBeNull();
    expect(causes).toEqual(["expired"]);
  });

  it("reports the actor unavailable when the principal source throws", async () => {
    const { options, causes } = setup();
    const token = await signSupportSession(sessionFrom(), signer);
    const subject = await subjectFromSupportSession(token, {
      ...options,
      principals: {
        principal: (): never => {
          throw new Error("directory down");
        },
      },
    });
    expect(subject.principal).toBeNull();
    expect(causes).toEqual(["actor-unavailable"]);
  });

  it("refuses a session naming a permission the tree does not have", async () => {
    const { options, causes } = setup();
    const token = await signSupportSession(
      { ...sessionFrom(), permissions: ["invoice.read", "invoice.archive"] },
      signer,
    );
    expect(
      (await subjectFromSupportSession(token, options)).principal,
    ).toBeNull();
    expect(causes).toEqual(["invalid-claims"]);
  });
});

describe("decideSupportSession: the session record is validated", () => {
  it("denies with validation when the approver id is empty", async () => {
    const staff = permdockFor(userSubject("u_staff", ["billing"]));
    const request = {
      id: "ss_1",
      principal: "u_customer",
      reason: "Ticket 4411",
    };
    const now = Temporal.Instant.from("2026-10-14T09:00:00Z");
    const pending = await staff.decideSupportSession(request, { now });
    if (pending.outcome !== "approval-required") {
      throw new Error("expected approval-required");
    }
    expect(
      await staff.decideSupportSession(request, {
        now,
        approved: pending.token,
        approvedBy: "",
      }),
    ).toEqual({
      outcome: "denied",
      denials: [{ role: null, reason: "validation" }],
    });
  });
});
