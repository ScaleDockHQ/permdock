import { describe, expect, it } from "vitest";

import type { Principal } from "../../src/core/subject.ts";
import type { SupportSession } from "../../src/core/support-session.ts";

import { assertApprover } from "../../src/approvals/store.ts";
import { parseSinkEvent } from "../../src/core/parse-sink-events.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { memoryDecisionSink } from "../../src/core/sink.ts";
import { joseTokenSigner } from "../../src/jwt/signer.ts";
import { joseTokenVerifier } from "../../src/jwt/verifier.ts";
import {
  signRunTicket,
  signSupportSession,
  subjectFromSupportSession,
} from "../../src/server/index.ts";
import {
  invoice,
  permdockFor,
  permissions,
  person,
  policy,
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
    approvedBy: "u_lead",
    reference: "4411",
  };
}

function setup(people: readonly Principal[]) {
  const directory = new Map(people.map((entry) => [entry.id, entry]));
  return {
    directory,
    options: {
      verifier,
      principals: { principal: (id: string) => directory.get(id) ?? null },
      permissions,
      audience: AUDIENCE,
      issuer: ISSUER,
    },
  };
}

describe("support session tokens", () => {
  it("resolve to the viewed principal with a support actor and a read-only delegation", async () => {
    const { options } = setup([
      person("u_customer", ["owner"]),
      person("u_staff", ["billing"]),
    ]);
    const token = await signSupportSession(sessionFrom(), signer);
    const subject = await subjectFromSupportSession(token, options);
    expect(subject.principal?.id).toBe("u_customer");
    expect(subject.actor).toEqual({
      id: "u_staff",
      kind: "support",
      readOnly: true,
    });
    expect(subject.context["supportSession"]).toEqual({
      id: "ss_1",
      reason: "Ticket 4411",
      approvedBy: "u_lead",
      reference: "4411",
    });
    const viewing = permdockFor(subject);
    expect(viewing.can(permissions.invoice.read, invoice)).toBe(true);
    expect(viewing.can(permissions.invoice.send, invoice)).toBe(false);
    expect(viewing.can(permissions.invoice.delete, invoice)).toBe(false);
  });

  it("stamp every decision of the session with its id", async () => {
    const { options } = setup([
      person("u_customer", ["owner"]),
      person("u_staff", ["billing"]),
    ]);
    const token = await signSupportSession(sessionFrom(), signer);
    const subject = await subjectFromSupportSession(token, options);
    const sink = memoryDecisionSink();
    const viewing = await createPermDock(policy, subject, { sink });
    viewing.can(permissions.invoice.read, invoice);
    viewing.can(permissions.invoice.delete, invoice);
    const events = sink.events();
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.type === "decision" && event.subject.supportSession).toEqual(
        { id: "ss_1" },
      );
      expect(parseSinkEvent(event)).not.toBeNull();
    }
  });

  it("leave decisions without a support actor unstamped", async () => {
    const sink = memoryDecisionSink();
    const forged = await createPermDock(
      policy,
      userSubject("u_customer", ["owner"], {
        context: { supportSession: { id: "ss_1" } },
      }),
      { sink },
    );
    forged.can(permissions.invoice.read, invoice);
    const [event] = sink.events();
    expect(event?.type === "decision" && event.subject).not.toHaveProperty(
      "supportSession",
    );
  });

  it("deny once the customer, the staff member or the session is gone", async () => {
    const causes: unknown[] = [];
    const { directory, options } = setup([
      person("u_customer", ["owner"]),
      person("u_staff", ["billing"]),
    ]);
    const onAuth = (event: { readonly cause?: string }): void => {
      causes.push(event.cause);
    };
    const token = await signSupportSession(sessionFrom(), signer);
    const ended = await subjectFromSupportSession(token, {
      ...options,
      onAuth,
      sessions: { session: (id: string) => ({ id, ended: true }) },
    });
    expect(ended.principal).toBeNull();
    const throwing = await subjectFromSupportSession(token, {
      ...options,
      onAuth,
      sessions: {
        session(): never {
          throw new Error("down");
        },
      },
    });
    expect(throwing.principal).toBeNull();
    directory.delete("u_staff");
    expect(
      (await subjectFromSupportSession(token, { ...options, onAuth }))
        .principal,
    ).toBeNull();
    directory.set("u_staff", person("u_staff", ["billing"]));
    directory.delete("u_customer");
    expect(
      (await subjectFromSupportSession(token, { ...options, onAuth }))
        .principal,
    ).toBeNull();
    expect(causes).toEqual([
      "session-ended",
      "session-ended",
      "actor-unavailable",
      "principal-unavailable",
    ]);
  });

  it("refuse other token types, expired sessions and empty input", async () => {
    const causes: unknown[] = [];
    const { options } = setup([
      person("u_customer", ["owner"]),
      person("u_staff", ["billing"]),
    ]);
    const onAuth = (event: { readonly cause?: string }): void => {
      causes.push(event.cause);
    };
    const run = await signRunTicket(
      {
        principal: "u_customer",
        kind: "caller",
        delegation: { scopes: ["invoice:read"] },
        expiresIn: 60,
      },
      signer,
    );
    expect(
      (await subjectFromSupportSession(run, { ...options, onAuth })).principal,
    ).toBeNull();
    const old = await signSupportSession(
      sessionFrom(Date.now() - 7_200_000),
      signer,
    );
    expect(
      (await subjectFromSupportSession(old, { ...options, onAuth })).principal,
    ).toBeNull();
    expect((await subjectFromSupportSession("", options)).principal).toBeNull();
    expect(causes).toHaveLength(2);
    expect(() =>
      signSupportSession({ ...sessionFrom(), reason: "" }, signer),
    ).toThrow(TypeError);
  });

  it("never lets the actor approve their own session request", () => {
    const request = {
      v: 1 as const,
      id: "req_1",
      token: "sha-256:abc",
      permission: "support.start",
      scope: "support:start",
      resource: { type: "support" },
      subject: { principal: { id: "u_staff", roles: [] } },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "pending" as const,
      detail: "Start a support session",
    };
    expect(() =>
      assertApprover(request, userSubject("u_staff", ["owner"]), true),
    ).toThrow("approver is the principal of this request");
    expect(() =>
      assertApprover(request, userSubject("u_lead", ["owner"]), true),
    ).not.toThrow();
  });

  it("never lets a support session approve as the person it views", async () => {
    const { options } = setup([
      person("u_customer", ["owner"]),
      person("u_staff", ["billing"]),
    ]);
    const subject = await subjectFromSupportSession(
      await signSupportSession(sessionFrom(), signer),
      options,
    );
    const request = {
      v: 1 as const,
      id: "req_2",
      token: "sha-256:def",
      permission: "invoice.send",
      scope: "invoice:send",
      resource: { type: "invoice" },
      subject: { principal: { id: "u_other", roles: [] } },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "pending" as const,
      detail: "Start a support session",
    };
    expect(() => assertApprover(request, subject, true)).toThrow(
      "a support session cannot approve",
    );
  });
});
