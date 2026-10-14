import { describe, expect, it } from "vitest";

import type { PrincipalIdentity } from "../../src/index.ts";

import {
  type BetterSupabaseIdentityLink,
  principalSource,
} from "../../src/better-supabase/index.ts";
import { testPrincipalSource } from "../../src/testing/index.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const CONTACT = "66666666-6666-4666-8666-666666666666";

const claimsOf = (id: string) => ({
  sub: id,
  role: "authenticated",
  tenant_id: ORG,
  memberships: [{ scope: "organization", id: ORG, roles: ["member"] }],
});

const links = (
  identity: PrincipalIdentity,
): BetterSupabaseIdentityLink | null => {
  if (identity.kind === "email" && identity.value === "ada@example.com") {
    return { user: USER };
  }
  if (
    identity.kind === "chat" &&
    identity.provider === "slack" &&
    identity.workspace === "T1" &&
    identity.value === "U1"
  ) {
    return { user: USER };
  }
  if (identity.kind === "email" && identity.value === "buyer@customer.test") {
    return {
      contact: {
        id: CONTACT,
        kind: "contact",
        memberships: [{ on: { resource: "quote", id: "q1" }, roles: [] }],
      },
    };
  }
  if (identity.kind === "email" && identity.value === "fake@customer.test") {
    // SAFETY: a link that names a non-contact principal, which the source refuses.
    return { contact: { id: USER, kind: "user" } } as never;
  }
  if (identity.kind === "email" && identity.value === "ghost@example.com") {
    return { user: "77777777-7777-4777-8777-777777777777" };
  }
  return null;
};

const source = principalSource({
  claims: (id) => (id === USER ? claimsOf(id) : null),
  identities: links,
});

describe("principalSource", () => {
  testPrincipalSource(source, {
    principals: [
      { id: USER, tenant: ORG },
      { id: "77777777-7777-4777-8777-777777777777", expect: null },
    ],
    identities: [
      { identity: { kind: "email", value: "ada@example.com" }, expect: USER },
      {
        identity: {
          kind: "chat",
          provider: "slack",
          workspace: "T1",
          value: "U1",
        },
        expect: USER,
      },
      {
        identity: { kind: "email", value: "buyer@customer.test" },
        expect: CONTACT,
      },
      {
        identity: { kind: "email", value: "fake@customer.test" },
        expect: null,
      },
      { identity: { kind: "email", value: "ghost@example.com" }, expect: null },
      {
        identity: { kind: "email", value: "nobody@example.com" },
        expect: null,
      },
    ],
  });

  it("maps the claims the way subjectFromBetterSupabase does", async () => {
    expect(await source.principal(USER, { tenant: ORG })).toMatchObject({
      id: USER,
      tenant: ORG,
      memberships: [
        expect.objectContaining({ scope: "organization", id: ORG }),
      ],
    });
  });

  it("passes the tenant to claims and refuses claims for another user", async () => {
    const asked: unknown[] = [];
    const wrong = principalSource({
      claims: (id, options) => {
        asked.push([id, options]);
        return claimsOf(CONTACT);
      },
    });
    expect(await wrong.principal(USER, { tenant: ORG })).toBeNull();
    expect(asked).toEqual([[USER, { tenant: ORG }]]);
  });

  it("has no principalByIdentity without identities", () => {
    const bare = principalSource({ claims: () => null });
    expect("principalByIdentity" in bare).toBe(false);
  });
});
