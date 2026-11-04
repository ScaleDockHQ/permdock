import type {
  AuthorizationRequest,
  AuthorizerRuntime,
} from "better-supabase/contract";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { AnyVersionCache } from "../../src/better-supabase/version-cache.ts";
import type { Permission } from "../../src/core/permission-types.ts";
import type { SupabaseRpcClient } from "../../src/supabase/index.ts";

import { authorizer, permdockFor } from "../../src/better-supabase/index.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
  memorySubjectCache,
  resource,
  role,
} from "../../src/index.ts";
import { postgrestSources } from "../../src/supabase/index.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

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
const roles = defineRoles({ editor: { on: "organization" } });
const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { organization: { key: "organization_id" } },
    // SAFETY: the authorizer always passes a Subject, which this resolver returns unchanged.
    subject: (user: unknown) => user as never,
    roles: [
      role(roles.editor, [allow(permissions.quote.read)], {
        on: "organization",
      }),
    ],
  },
);

const record = (version: number, id: string = USER) => ({
  id,
  active: true,
  roles: [],
  memberships: [{ scope: "organization", id: ORG, roles: ["editor"] }],
  customRoles: [],
  authzVersion: version,
});

/** A token one version behind the database, with no memberships left in it. */
const staleClaims = { sub: USER, role: "authenticated", authz_ver: 2 };

const request = (): AuthorizationRequest<Permission> => ({
  subject: { type: "user", id: USER, properties: { claims: staleClaims } },
  action: permissions.quote.read,
  resource: { type: "quotes", properties: { id: "q1", organization_id: ORG } },
  context: { tenant: ORG },
});

function setup(): {
  readonly calls: string[];
  readonly check: (seed?: unknown) => Promise<string>;
} {
  const calls: string[] = [];
  const client: SupabaseRpcClient = {
    schema: () => ({
      rpc: (fn, args) => {
        calls.push(fn);
        const data =
          fn === "authz_version_for" ? 3 : record(3, String(args["p_user"]));
        return Promise.resolve({ data, error: null });
      },
    }),
  };
  const subjects = memorySubjectCache();
  const sources = postgrestSources(client, { subjects });
  const resolve = permdockFor({
    policy,
    memberships: sources.memberships,
    subjects,
  });
  const checked = authorizer({ policy, permdockFor: resolve });
  return {
    calls,
    check: async (seed) => {
      // better-supabase 0.52 adds `seed` to the runtime; the floor release's type has none.
      const withSeed = {
        versions: { get: () => undefined, evict: () => undefined },
        seed,
      };
      const runtime: AuthorizerRuntime<AnyVersionCache> | undefined =
        seed === undefined ? undefined : withSeed;
      const outcome = await checked.evaluate(request(), runtime);
      return outcome.outcome;
    },
  };
}

const reads = (calls: readonly string[]): number =>
  calls.filter((name) => name === "subject_for").length;

describe("authorizer with a bootstrap seed", () => {
  it("reads subject_for once for a stale token without a seed", async () => {
    const { calls, check } = setup();
    expect(await check()).toBe("granted");
    expect(reads(calls)).toBe(1);
  });

  it("reads no subject_for when the seed names the user at the live version", async () => {
    const { calls, check } = setup();
    expect(await check({ userId: USER, version: 3, subject: record(3) })).toBe(
      "granted",
    );
    expect(reads(calls)).toBe(0);
    expect(calls).toStrictEqual([]);
  });

  it("ignores a seed for another user", async () => {
    const { calls, check } = setup();
    expect(
      await check({ userId: OTHER, version: 3, subject: record(3, OTHER) }),
    ).toBe("granted");
    expect(reads(calls)).toBe(1);
  });

  it("ignores a seed record at another version than the seed's", async () => {
    const { calls, check } = setup();
    expect(await check({ userId: USER, version: 3, subject: record(2) })).toBe(
      "granted",
    );
    expect(reads(calls)).toBe(1);
  });

  it("ignores a seed whose record is another user's", async () => {
    const { calls, check } = setup();
    expect(
      await check({ userId: USER, version: 3, subject: record(3, OTHER) }),
    ).toBe("granted");
    expect(reads(calls)).toBe(1);
  });
});

describe("permdockFor with a bootstrap result subject", () => {
  it("seeds the subjects cache so the instance reads no subject_for", async () => {
    const calls: string[] = [];
    const client: SupabaseRpcClient = {
      schema: () => ({
        rpc: (fn) => {
          calls.push(fn);
          return Promise.resolve({ data: null, error: null });
        },
      }),
    };
    const subjects = memorySubjectCache();
    const sources = postgrestSources(client, { subjects });
    const resolve = permdockFor({
      policy,
      memberships: sources.memberships,
      subjects,
    });
    const permdock = await resolve(
      {
        session: { kind: "user", claims: staleClaims },
        tenant: ORG,
        authzVersion: 3,
        subject: record(3),
      },
      { tenant: ORG },
    );
    expect(
      permdock.decide(permissions.quote.read, {
        id: "q1",
        organization_id: ORG,
      }).outcome,
    ).toBe("granted");
    expect(calls).toStrictEqual([]);
  });
});
