import { describe, expect, it } from "vitest";

import type {
  PrincipalIdentity,
  PrincipalSource,
} from "../../src/core/principal-source.ts";

import {
  loadPrincipal,
  loadPrincipalByIdentity,
  memoryPrincipalSource,
  normalizeIdentity,
} from "../../src/core/principal-source.ts";
import { testPrincipalSource } from "../../src/testing/conformance/principals.ts";

const alice = {
  id: "u_alice",
  kind: "user" as const,
  memberships: [{ tenant: "acme", roles: ["admin"] }],
};
const carol = {
  id: "c_carol",
  kind: "contact" as const,
  memberships: [{ on: { resource: "ticket", id: "t1" }, roles: ["requester"] }],
};

const source = memoryPrincipalSource({
  principals: [alice, carol],
  identities: [
    {
      identity: { kind: "email", value: " Alice@Example.com " },
      principal: "u_alice",
    },
    {
      identity: {
        kind: "chat",
        provider: "slack",
        value: "U123",
        workspace: "T9",
      },
      principal: "u_alice",
    },
    {
      identity: { kind: "email", value: "carol@customer.test" },
      principal: "c_carol",
    },
    {
      identity: { kind: "email", value: "ghost@example.com" },
      principal: "u_ghost",
    },
  ],
});

describe("memoryPrincipalSource conformance", () => {
  testPrincipalSource(source, {
    principals: [
      { id: "u_alice", expect: alice },
      { id: "c_carol", tenant: "acme", expect: carol },
      { id: "nobody", expect: null },
    ],
    identities: [
      {
        identity: { kind: "email", value: "ALICE@example.com" },
        expect: "u_alice",
      },
      {
        identity: {
          kind: "chat",
          provider: "slack",
          value: "U123",
          workspace: "T9",
        },
        expect: "u_alice",
      },
      {
        identity: { kind: "chat", provider: "slack", value: "U123" },
        expect: null,
      },
      {
        identity: {
          kind: "chat",
          provider: "teams",
          value: "U123",
          workspace: "T9",
        },
        expect: null,
      },
      {
        identity: { kind: "email", value: "nobody@example.com" },
        expect: null,
      },
    ],
  });
});

describe("memoryPrincipalSource", () => {
  it("returns a frozen copy each time", async () => {
    const first = await source.principal("u_alice");
    const second = await source.principal("u_alice");
    expect(first).toEqual(alice);
    expect(first).not.toBe(alice);
    expect(first).not.toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.memberships)).toBe(true);
    expect(Object.isFrozen(alice)).toBe(false);
  });

  it("links an identity to a principal it does not hold as null", async () => {
    expect(
      await source.principalByIdentity?.({
        kind: "email",
        value: "ghost@example.com",
      }),
    ).toBeNull();
  });

  it("works without identities", async () => {
    const bare = memoryPrincipalSource({ principals: [alice] });
    expect(
      await bare.principalByIdentity?.({ kind: "email", value: "a@b.c" }),
    ).toBeNull();
  });

  it("refuses a principal without an id and a duplicate id", () => {
    expect(() => memoryPrincipalSource({ principals: [{ id: "" }] })).toThrow(
      TypeError,
    );
    expect(() => memoryPrincipalSource({ principals: [alice, alice] })).toThrow(
      TypeError,
    );
  });

  it("refuses an invalid identity link", () => {
    expect(() =>
      memoryPrincipalSource({
        principals: [alice],
        identities: [
          // SAFETY: an invalid kind on purpose, to check the definition-time refusal.
          {
            identity: { kind: "phone", value: "1" } as never,
            principal: "u_alice",
          },
        ],
      }),
    ).toThrow(TypeError);
  });
});

describe("normalizeIdentity", () => {
  it("trims and lower-cases an email and drops provider and workspace", () => {
    expect(
      normalizeIdentity({
        kind: "email",
        value: "  Bob@Example.COM ",
        provider: "x",
        workspace: "y",
      }),
    ).toEqual({ kind: "email", value: "bob@example.com" });
  });

  it("keeps a chat identity as given and needs a provider", () => {
    expect(
      normalizeIdentity({ kind: "chat", provider: "slack", value: "U1" }),
    ).toEqual({ kind: "chat", provider: "slack", value: "U1" });
    expect(normalizeIdentity({ kind: "chat", value: "U1" })).toBeUndefined();
  });

  it("refuses anything that is not an identity", () => {
    for (const value of [
      null,
      "a@b.c",
      [],
      { kind: "email", value: "" },
      { kind: "email", value: "   " },
      { kind: "email" },
      { kind: "sms", value: "1" },
      { kind: "chat", provider: "", value: "U1" },
      { kind: "chat", provider: "slack", value: "U1", workspace: 3 },
      JSON.parse('{"__proto__":{"kind":"email","value":"a@b.c"}}'),
    ]) {
      expect(normalizeIdentity(value)).toBeUndefined();
    }
  });

  it("reads only own properties", () => {
    const inherited = Object.create({ kind: "email", value: "a@b.c" });
    expect(normalizeIdentity(inherited)).toBeUndefined();
  });
});

describe("loadPrincipal", () => {
  const throwing: PrincipalSource = {
    principal() {
      throw new Error("db down");
    },
    principalByIdentity() {
      throw new Error("db down");
    },
  };
  const rejecting: PrincipalSource = {
    principal: () => Promise.reject(new Error("db down")),
    principalByIdentity: () => Promise.reject(new Error("db down")),
  };

  it("passes the tenant and returns the principal", async () => {
    const seen: unknown[] = [];
    const recording: PrincipalSource = {
      principal(id, options) {
        seen.push(options);
        return { id };
      },
    };
    expect(await loadPrincipal(recording, "u_1", "acme")).toEqual({
      id: "u_1",
    });
    expect(await loadPrincipal(recording, "u_1")).toEqual({ id: "u_1" });
    expect(seen).toEqual([{ tenant: "acme" }, {}]);
  });

  it("is null for a missing source, a throw, a rejection or a wrong id", async () => {
    expect(await loadPrincipal(undefined, "u_1")).toBeNull();
    expect(await loadPrincipal(throwing, "u_1")).toBeNull();
    expect(await loadPrincipal(rejecting, "u_1")).toBeNull();
    expect(
      await loadPrincipal({ principal: () => ({ id: "u_2" }) }, "u_1"),
    ).toBeNull();
    expect(
      // SAFETY: a source that breaks its contract on purpose.
      await loadPrincipal({ principal: () => "u_1" as never }, "u_1"),
    ).toBeNull();
    expect(
      // SAFETY: a source that breaks its contract on purpose.
      await loadPrincipal({ principal: () => undefined as never }, "u_1"),
    ).toBeNull();
    expect(await loadPrincipal(source, "")).toBeNull();
  });

  it("is null for an identity lookup that cannot answer", async () => {
    const email: PrincipalIdentity = { kind: "email", value: "a@b.c" };
    expect(await loadPrincipalByIdentity(undefined, email)).toBeNull();
    expect(
      await loadPrincipalByIdentity({ principal: () => null }, email),
    ).toBeNull();
    expect(await loadPrincipalByIdentity(throwing, email)).toBeNull();
    expect(await loadPrincipalByIdentity(rejecting, email)).toBeNull();
    expect(
      await loadPrincipalByIdentity(source, { kind: "chat", value: "U1" }),
    ).toBeNull();
    expect(
      await loadPrincipalByIdentity(
        // SAFETY: a source that breaks its contract on purpose.
        {
          principal: () => null,
          principalByIdentity: () => ({ id: 3 }) as never,
        },
        email,
      ),
    ).toBeNull();
  });

  it("normalises an email before the lookup", async () => {
    const seen: PrincipalIdentity[] = [];
    const recording: PrincipalSource = {
      principal: () => null,
      principalByIdentity(identity) {
        seen.push(identity);
        return { id: "u_1" };
      },
    };
    expect(
      await loadPrincipalByIdentity(recording, {
        kind: "email",
        value: " A@B.C ",
      }),
    ).toEqual({ id: "u_1" });
    expect(seen).toEqual([{ kind: "email", value: "a@b.c" }]);
  });
});
