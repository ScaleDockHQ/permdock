import { expectTenantShare } from "better-supabase/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { authorizationHooks } from "../../src/better-supabase/index.ts";
import { grantFingerprint } from "../../src/core/grant-fingerprint.ts";
import { compactMemberships } from "../../src/core/membership-claim.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
  getPermDock,
  resource,
  role,
} from "../../src/index.ts";
import { defined } from "../support/defined.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";

const Doc = z.object({ id: z.string(), organization_id: z.string() });
const permissions = definePermissions({
  doc: resource(Doc, {
    id: "id",
    actions: ["read", "update"],
    relations: {
      organization: { field: "organization_id", memberOf: "organization" },
    },
  }),
});
const { doc } = permissions;
const roles = defineRoles({
  editor: { on: "organization" },
  viewer: { on: "organization" },
  stranger: { on: "organization" },
});
const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { organization: { key: "organization_id" } },
    // SAFETY: the hooks always pass a Subject, which this resolver returns unchanged.
    subject: (subject: unknown) => subject as never,
    roles: [
      role(roles.editor, [allow([doc.read, doc.update])], {
        on: "organization",
      }),
      role(roles.viewer, [allow(doc.read)], { on: "organization" }),
      role(roles.stranger, [], { on: "organization" }),
    ],
  },
);

const claims = (sub: string, roleName: string, tenant = ORG) => ({
  sub,
  role: "authenticated",
  tenant_id: tenant,
  memberships: [{ scope: "organization", id: tenant, roles: [roleName] }],
});
const caller = (userId: string, roleName: string) => ({
  userId,
  claims: claims(userId, roleName),
  read: () => Promise.resolve([{ id: "1" }]),
});

const hooks = authorizationHooks({ policy });
const shareKey = defined(hooks.shareKey);
const keyOf = (
  sub: string,
  roleName: string,
  keys: readonly string[],
  tenant: string | null = ORG,
  extra: Record<string, unknown> = {},
) =>
  shareKey(undefined, keys, {
    subject: {
      type: "user",
      id: sub,
      properties: { claims: { ...claims(sub, roleName), ...extra } },
    },
    context: tenant === null ? {} : { tenant },
  });

describe("shareKey", () => {
  it("gives callers with the same grants one key and others none", async () => {
    await expectTenantShare({
      hooks,
      tenant: ORG,
      permissions: [doc.read.key],
      holders: [caller("u1", "editor"), caller("u2", "viewer")],
      outsider: caller("u3", "stranger"),
    });
  });

  it("separates callers whose grants for the listed permissions differ", async () => {
    const keys = [doc.read.key, doc.update.key];
    const [editor, viewer] = await Promise.all([
      keyOf("u1", "editor", keys),
      keyOf("u2", "viewer", keys),
    ]);
    expect(editor).toMatch(/^gf1:/u);
    expect(viewer).toMatch(/^gf1:/u);
    expect(editor).not.toBe(viewer);
  });

  it("answers null without a tenant and for a stranger", async () => {
    expect(await keyOf("u1", "editor", [doc.read.key], null)).toBeNull();
    expect(await keyOf("u3", "stranger", [doc.read.key])).toBeNull();
    expect(await keyOf("u1", "editor", ["doc.nope"])).toBeNull();
    expect(await keyOf("u1", "editor", [doc.read.key], OTHER)).toBeNull();
  });

  it("answers for the active tenant of a truncated token only when the cut passed it", async () => {
    const keys = [doc.read.key];
    const whole = await keyOf("u1", "editor", keys);
    const entry = (id: string) => ({
      scope: "organization",
      id,
      roles: ["editor"],
    });
    const cut = (memberships: readonly unknown[]) =>
      keyOf("u1", "editor", keys, ORG, {
        memberships,
        memberships_truncated: true,
      });
    // the active tenant's entries come first: one entry of another tenant proves they are all kept
    expect(await cut([entry(ORG), entry(OTHER)])).toBe(whole);
    // only the active tenant's entries, or none, may have been cut inside them
    expect(await cut([entry(ORG)])).toBeNull();
    expect(await cut([])).toBeNull();
    // the compact claim reads the same way
    expect(
      await cut(
        // SAFETY: compactMemberships returns the claim object, which `cut` passes through as a claim value.
        compactMemberships([entry(ORG), entry(OTHER)]) as never,
      ),
    ).toBe(whole);
    // a token cut elsewhere stays unanswered
    expect(
      await keyOf("u1", "editor", keys, ORG, {
        memberships: [entry(ORG), entry(OTHER)],
        permissions_truncated: true,
      }),
    ).toBeNull();
  });

  it("answers null for a token behind the live version", async () => {
    const stale = await shareKey(undefined, [doc.read.key], {
      subject: {
        type: "user",
        id: "u1",
        properties: { claims: { ...claims("u1", "editor"), authz_ver: 1 } },
      },
      context: { tenant: ORG },
      // SAFETY: the hook reads `get` when the runtime's version cache has one, which the contract type omits.
      runtime: { versions: { evict: () => undefined, get: () => 2 } as never },
    });
    expect(stale).toBeNull();
  });
});

describe("shareKey with widened keys", () => {
  const widened = defined(
    authorizationHooks({ policy, widened: [doc.update.key] }).shareKey,
  );
  const keyFor = (sub: string, roleName: string, keys: readonly string[]) =>
    widened(undefined, keys, {
      subject: {
        type: "user",
        id: sub,
        properties: { claims: claims(sub, roleName) },
      },
      context: { tenant: ORG },
    });

  it("shares among holders of a widening key and keeps everyone else per user", async () => {
    const keys = [doc.update.key];
    const [one, two, viewer] = await Promise.all([
      keyFor("u1", "editor", keys),
      keyFor("u2", "editor", keys),
      keyFor("u3", "viewer", keys),
    ]);
    expect(one).toMatch(/^gf1:/u);
    expect(one).toBe(two);
    expect(viewer).toBeNull();
  });

  it("leaves a loader with no widened key as before", async () => {
    expect(await keyFor("u3", "viewer", [doc.read.key])).toMatch(/^gf1:/u);
  });
});

describe("grant fingerprint", () => {
  it("is stable per grant set and ignores the user", async () => {
    const make = (sub: string, roleName: string) =>
      getPermDock(policy, {
        id: sub,
        kind: "user",
        tenant: ORG,
        memberships: [{ scope: "organization", id: ORG, roles: [roleName] }],
      });
    const [a, b, c] = await Promise.all([
      make("u1", "editor"),
      make("u2", "editor"),
      make("u3", "viewer"),
    ]);
    const keys = [doc.read, doc.update];
    expect(grantFingerprint(a, keys)).toBe(grantFingerprint(b, keys));
    expect(grantFingerprint(a, keys)).not.toBe(grantFingerprint(c, keys));
    expect(grantFingerprint(a, [])).toBeNull();
  });
});
