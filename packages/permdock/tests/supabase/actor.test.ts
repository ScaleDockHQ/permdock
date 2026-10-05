import { describe, expect, it } from "vitest";

import {
  actorOf,
  delegationOf,
  subjectFromSupabase,
} from "../../src/supabase/index.ts";
import { supabaseClaimFixtures } from "../../src/testing/supabase-fixtures.ts";

const sub = "6f1c2c1e-5d0a-4d9e-9a51-6b1f0e7c2a10";

describe("actorOf and delegationOf", () => {
  for (const [name, fixture] of Object.entries(supabaseClaimFixtures)) {
    it(`agree with subjectFromSupabase on ${name}`, () => {
      const subject = subjectFromSupabase(fixture.claims, fixture.options);
      if (subject.principal === null) {
        expect(subject.actor).toBeUndefined();
        return;
      }
      const result = actorOf(fixture.claims);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }
      const actor = result.actor;
      expect(subject.actor).toEqual(fixture.expect.actor);
      expect(subject.actor?.kind).toBe(actor?.kind);
      expect(subject.delegation).toEqual(fixture.expect.delegation);
      const scopes = delegationOf(fixture.claims)?.scopes;
      const expected =
        actor?.kind !== "oauth-client" ||
        (scopes === undefined && actor.chain === undefined)
          ? undefined
          : {
              ...(scopes === undefined ? {} : { scopes }),
              ...(actor.chain === undefined ? {} : { chain: actor.chain }),
            };
      expect(subject.delegation).toEqual(expected);
    });
  }

  it("reads the outermost sub of an act chain, the current actor, over client_id", () => {
    const result = actorOf({
      sub,
      client_id: "app-1",
      act: { sub: "runner", act: { sub: "client-9", iss: "x" } },
    });
    expect(result).toEqual({
      ok: true,
      actor: {
        id: "runner",
        kind: "oauth-client",
        chain: { sub: "runner", act: { sub: "client-9", iss: "x" } },
      },
    });
  });

  it("reads a support session from act.kind, with its session, read-only flag (true when absent, as better-supabase reads it) and reason", () => {
    const act = {
      kind: "support",
      sub: "admin-1",
      session_id: "s-1",
      read_only: true,
      reason: "ticket 42",
    };
    expect(actorOf({ sub, act })).toEqual({
      ok: true,
      actor: {
        id: "admin-1",
        kind: "support",
        sessionId: "s-1",
        readOnly: true,
        reason: "ticket 42",
        chain: act,
      },
    });
    const { read_only: _, ...unmarked } = act;
    expect(actorOf({ sub, act: unmarked })).toMatchObject({
      ok: true,
      actor: { kind: "support", readOnly: true },
    });
    expect(actorOf({ sub, act: { ...act, read_only: false } })).toMatchObject({
      ok: true,
      actor: { kind: "support", readOnly: false },
    });
  });

  it("reads an impersonation from act.kind and gives it no delegation", () => {
    const act = { kind: "impersonation", sub: "admin-1", reason: "ticket 42" };
    expect(actorOf({ sub, act })).toEqual({
      ok: true,
      actor: {
        id: "admin-1",
        kind: "impersonation",
        reason: "ticket 42",
        chain: act,
      },
    });
    const subject = subjectFromSupabase({ sub, act, scope: "posts:read" });
    expect(subject.actor).toEqual({ id: "admin-1", kind: "impersonation" });
    expect(subject.delegation).toBeUndefined();
  });

  it("reads a 0.5.0 support token (session_id without kind) as support, as better-supabase does", () => {
    const subject = subjectFromSupabase({
      sub,
      act: { sub: "admin-1", session_id: "s-1", read_only: true },
    });
    expect(subject.actor).toEqual({
      id: "admin-1",
      kind: "support",
      sessionId: "s-1",
      readOnly: true,
    });
    expect(subject.delegation).toBeUndefined();
  });

  it.each([
    ["an unknown kind", { kind: "delegate", sub: "admin-1" }],
    ["a non-string kind", { kind: 1, sub: "admin-1" }],
    ["support without session_id", { kind: "support", sub: "admin-1" }],
    [
      "support with an empty session_id",
      { kind: "support", sub: "admin-1", session_id: "" },
    ],
    [
      "support with a non-boolean read_only",
      { kind: "support", sub: "admin-1", session_id: "s-1", read_only: "yes" },
    ],
  ])("rejects %s as invalid-chain", (_, act) => {
    expect(actorOf({ sub, act })).toEqual({
      ok: false,
      reason: "invalid-chain",
    });
    expect(subjectFromSupabase({ sub, act }).principal).toBeNull();
  });

  it("maps an anonymous sign-in to anonymous only with anonymousSignIns: 'deny'", () => {
    const claims = { sub, role: "authenticated", is_anonymous: true };
    expect(subjectFromSupabase(claims).principal?.id).toBe(sub);
    expect(
      subjectFromSupabase(claims, { anonymousSignIns: "deny" }).principal,
    ).toBeNull();
    expect(
      subjectFromSupabase(
        { ...claims, is_anonymous: false },
        { anonymousSignIns: "deny" },
      ).principal?.id,
    ).toBe(sub);
  });

  it("reads client_id when there is no act", () => {
    expect(actorOf({ sub, client_id: "app-1" })).toEqual({
      ok: true,
      actor: { id: "app-1", kind: "oauth-client" },
    });
  });

  it("has no actor without act or client_id, or for a non-object", () => {
    expect(actorOf({ sub })).toEqual({ ok: true });
    expect(actorOf({ sub, client_id: "" })).toEqual({ ok: true });
    expect(actorOf(null)).toEqual({ ok: true });
    expect(actorOf("token")).toEqual({ ok: true });
  });

  it.each([
    ["a string act", "runner"],
    ["an array act", [{ sub: "runner" }]],
    ["a null act", null],
    ["an act without sub", { iss: "x" }],
    ["an empty nested sub", { sub: "runner", act: { sub: "" } }],
    ["a nested act without sub", { sub: "runner", act: { iss: "x" } }],
    ["a nested act that is not an object", { sub: "runner", act: "client" }],
  ])("rejects %s as invalid-chain", (_, act) => {
    expect(actorOf({ sub, act })).toEqual({
      ok: false,
      reason: "invalid-chain",
    });
    expect(subjectFromSupabase({ sub, act }).principal).toBeNull();
  });

  it("fails closed when reading the claims throws", () => {
    const claims = {
      sub,
      get act(): unknown {
        throw new Error("boom");
      },
    };
    expect(actorOf(claims)).toEqual({ ok: false, reason: "invalid-chain" });
    expect(delegationOf(claims)).toBeUndefined();
  });

  it("returns a frozen copy that does not alias the claims", () => {
    const act = { sub: "runner", act: { sub: "client-9" } };
    const result = actorOf({ sub, act });
    expect(Object.isFrozen(result)).toBe(true);
    if (!result.ok || result.actor === undefined) {
      throw new Error("expected an actor");
    }
    expect(Object.isFrozen(result.actor.chain)).toBe(true);
    expect(result.actor.chain).not.toBe(act);
    expect(Object.isFrozen(act)).toBe(false);
  });

  it("keeps __proto__ as an own key of the copied chain", () => {
    const act = JSON.parse('{"sub":"runner","__proto__":{"polluted":true}}');
    const result = actorOf({ sub, act });
    if (!result.ok || result.actor === undefined) {
      throw new Error("expected an actor");
    }
    expect(Object.getPrototypeOf(result.actor.chain)).toBe(Object.prototype);
    expect(Object.hasOwn(result.actor.chain ?? {}, "__proto__")).toBe(true);
    expect(Reflect.get({}, "polluted")).toBeUndefined();
  });

  it("splits a scope string and keeps the strings of a scope list", () => {
    expect(delegationOf({ scope: " openid  posts:read " })).toEqual({
      scopes: ["posts:read"],
    });
    expect(delegationOf({ scope: ["posts:read", 3] })).toEqual({
      scopes: ["posts:read"],
    });
    expect(Object.isFrozen(delegationOf({ scope: "posts:read" }))).toBe(true);
  });

  it("leaves out the OpenID Connect identity scopes", () => {
    expect(
      delegationOf({
        scope: "openid profile email address phone offline_access",
      }),
    ).toBeUndefined();
    expect(delegationOf({ scope: ["email", "posts:read"] })).toEqual({
      scopes: ["posts:read"],
    });
  });

  it("has no delegation for an empty, missing or malformed scope", () => {
    expect(delegationOf({ scope: "" })).toBeUndefined();
    expect(delegationOf({ scope: [] })).toBeUndefined();
    expect(delegationOf({ scope: 4 })).toBeUndefined();
    expect(delegationOf({ sub })).toBeUndefined();
    expect(delegationOf(undefined)).toBeUndefined();
  });

  it("never gives anon or service_role an actor through subjectFromSupabase", () => {
    for (const role of ["anon", "service_role"]) {
      const subject = subjectFromSupabase({
        sub,
        role,
        client_id: "app-1",
        scope: "posts:read",
      });
      expect(subject.principal).toBeNull();
      expect(subject.actor).toBeUndefined();
      expect(subject.delegation).toBeUndefined();
    }
  });
});
