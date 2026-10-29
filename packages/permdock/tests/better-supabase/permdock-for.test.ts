import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { MembershipSource } from "../../src/core/interfaces.ts";

import {
  authorizationHooks,
  getPermissions,
  permdockFor,
} from "../../src/better-supabase/index.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  instanceCache,
  resource,
  role,
} from "../../src/index.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const Quote = z.object({ id: z.string(), organization_id: z.string() });
const permissions = definePermissions({
  quote: resource(Quote, {
    id: "id",
    actions: ["read"],
    relations: {
      organization: { field: "organization_id", memberOf: "organization" },
    },
  }),
});
const policy = definePolicy(permissions, {
  scopes: { organization: { key: "organization_id" } },
  // SAFETY: permdockFor always passes a Subject, which this resolver returns unchanged.
  subject: (user: unknown) => user as never,
  roles: [
    role("editor", [allow(permissions.quote.read)], { on: "organization" }),
  ],
});

const claims = {
  sub: USER,
  role: "authenticated",
  tenant_id: ORG,
  authz_ver: 3,
  memberships: [{ scope: "organization", id: ORG, roles: ["editor"] }],
};
const row = { id: "q1", organization_id: ORG };

function versions() {
  const state = { reads: 0, version: 3 };
  const source: MembershipSource = {
    membershipsFor: () => [],
    version: () => {
      state.reads += 1;
      return state.version;
    },
  };
  return { state, source };
}

describe("the permdockFor resolver", () => {
  it("resolves a session, a bootstrap result and a subject", async () => {
    const resolve = permdockFor({ policy });
    const session = await resolve({ kind: "user", claims });
    expect(session.can(permissions.quote.read, row)).toBe(true);
    const signedOut = await resolve({
      session: { kind: "user", claims },
      tenant: ORG,
      authzVersion: 3,
      sessionActive: false,
    });
    expect(signedOut.subject.principal).toBeNull();
    const subject = await resolve(session.subject, ORG);
    expect(subject.can(permissions.quote.read, row)).toBe(true);
  });

  it("takes a bootstrap's version as known and reads none", async () => {
    const db = versions();
    const resolve = permdockFor({ policy, memberships: db.source });
    const permdock = await resolve(
      {
        session: { kind: "user", claims },
        tenant: ORG,
        authzVersion: 3,
        sessionActive: true,
      },
      { intent: "write" },
    );
    expect(permdock.can(permissions.quote.read, row)).toBe(true);
    expect(db.state.reads).toBe(0);
  });

  it("shares one instance per subject and version through instances", async () => {
    const db = versions();
    const instances = instanceCache();
    const resolve = permdockFor({ policy, memberships: db.source, instances });
    const first = await resolve({ kind: "user", claims }, { intent: "write" });
    const second = await resolve({ kind: "user", claims }, { intent: "write" });
    expect(second).toBe(first);
    expect(db.state.reads).toBe(2);
    db.state.version = 4;
    const third = await resolve({ kind: "user", claims }, { intent: "write" });
    expect(third).not.toBe(first);
  });
});

describe(getPermissions, () => {
  it("answers frozen states from one instance and denies all when it cannot build", async () => {
    const resolve = permdockFor({ policy });
    const states = await getPermissions(
      resolve,
      { kind: "user", claims },
      { read: [permissions.quote.read, row] },
    );
    expect(states).toStrictEqual({
      read: { allowed: true, outcome: "granted" },
    });
    const failing = await getPermissions(
      () => Promise.reject(new Error("down")),
      null,
      { read: [permissions.quote.read, row] },
    );
    expect(failing.read).toStrictEqual({
      allowed: false,
      outcome: "denied",
      reason: "no-grant",
    });
  });
});

describe(authorizationHooks, () => {
  it("tags a user's sessions with the snapshot tag", () => {
    const hooks = authorizationHooks({ policy, claims: () => null });
    expect(hooks.sessionTags?.(USER)).toStrictEqual([`permdock:${USER}`]);
  });
});
