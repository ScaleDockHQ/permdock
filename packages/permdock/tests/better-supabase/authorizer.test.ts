import type {
  AuthorizationOutcome,
  AuthorizationRequest,
} from "better-supabase/server";

import { testAuthorizer } from "better-supabase/testing";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { Permission } from "../../src/core/permission-types.ts";

import { authorizer } from "../../src/better-supabase/index.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
  deny,
  resource,
  role,
} from "../../src/index.ts";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "33333333-3333-4333-8333-333333333333";
const USER = "22222222-2222-4222-8222-222222222222";

const Quote = z.object({ id: z.string(), organization_id: z.string() });

const relations = {
  organization: { field: "organization_id", memberOf: "organization" },
} as const;

const permissions = definePermissions({
  quote: resource(Quote, {
    id: "id",
    actions: ["read", "update", "delete"],
    collection: ["list"],
    relations,
  }),
  export: resource(Quote, {
    id: "id",
    actions: [],
    collection: ["run"],
    relations,
  }),
});
const { quote } = permissions;

const roles = defineRoles({ editor: { on: "organization" } });
const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { organization: { key: "organization_id" } },
    // SAFETY: the authorizer always passes a Subject, which this resolver returns unchanged.
    subject: (user: unknown) => user as never,
    roles: [
      role(
        roles.editor,
        [
          allow([quote.read, quote.update, quote.delete, quote.list]),
          deny(quote.delete),
          allow(permissions.export.run, { approval: "human" }),
        ],
        { on: "organization" },
      ),
    ],
  },
);

const claims = (tenant: string = ORG, memberships = [ORG]) => ({
  sub: USER,
  role: "authenticated",
  tenant_id: tenant,
  memberships: memberships.map((id) => ({
    scope: "organization",
    id,
    roles: ["editor"],
  })),
});

const request = (
  action: Permission,
  overrides: {
    type?: string;
    claims?: Record<string, unknown>;
    tenant?: string;
    properties?: Record<string, unknown>;
  } = {},
): AuthorizationRequest<Permission> => ({
  subject: {
    type: overrides.type ?? "user",
    id: USER,
    ...(overrides.claims === undefined
      ? {}
      : { properties: { claims: overrides.claims } }),
  },
  action,
  resource: {
    type: "quotes",
    ...(overrides.properties === undefined
      ? {}
      : { properties: overrides.properties }),
  },
  context: overrides.tenant === undefined ? {} : { tenant: overrides.tenant },
});

const pd = authorizer({ policy });
const row = { id: "q1", organization_id: ORG };

describe(authorizer, () => {
  it("conforms to better-supabase's authorizer contract", async () => {
    await testAuthorizer(pd, {
      permissions: [quote.read, quote.update],
      unknown: { ...quote.read, key: "nothing.here" },
      granted: {
        permission: quote.read,
        context: {
          actor: { kind: "user", id: USER },
          tenant: ORG,
          claims: claims(),
        },
      },
    });
  });

  it("names itself and keys a permission", () => {
    expect(pd).toMatchObject({ apiVersion: 1, name: "PermDock" });
    expect(pd.key(quote.read)).toBe("quote.read");
    // SAFETY: a value that is not a PermDock permission, to prove key() refuses it.
    expect(() => pd.key({ key: "x" } as never)).toThrow(TypeError);
  });

  it("grants a held permission for the claims' memberships", async () => {
    expect(
      await pd.evaluate(
        request(quote.read, { claims: claims(), tenant: ORG, properties: row }),
      ),
    ).toStrictEqual({ outcome: "granted" });
  });

  it("denies a permission a deny overrides", async () => {
    expect(
      await pd.evaluate(
        request(quote.delete, {
          claims: claims(),
          tenant: ORG,
          properties: row,
        }),
      ),
    ).toMatchObject({
      outcome: "denied",
      reason: expect.stringContaining("quote.delete"),
    });
  });

  it("returns the approval token for an approval-required grant", async () => {
    const outcome = await pd.evaluate(
      request(permissions.export.run, { claims: claims(), tenant: ORG }),
    );
    expect(outcome).toMatchObject({
      outcome: "approval-required",
      approval: { id: expect.any(String) },
    });
  });

  it("denies a tenant the claims hold no membership in", async () => {
    expect(
      await pd.evaluate(
        request(quote.list, { claims: claims(), tenant: OTHER }),
      ),
    ).toMatchObject({ outcome: "denied" });
  });

  it("denies without claims and for non-user subjects", async () => {
    for (const type of ["anon", "service"]) {
      expect(
        await pd.evaluate(
          request(quote.list, { type, claims: claims(), tenant: ORG }),
        ),
      ).toMatchObject({ outcome: "denied" });
    }
    expect(
      await pd.evaluate(request(quote.list, { tenant: ORG })),
    ).toMatchObject({ outcome: "denied" });
  });

  it("ignores forged memberships in the resource properties", async () => {
    expect(
      await pd.evaluate(
        request(quote.read, {
          tenant: ORG,
          properties: {
            ...row,
            claims: claims(),
            memberships: claims().memberships,
          },
        }),
      ),
    ).toMatchObject({ outcome: "denied" });
  });

  it("keeps an agent's act chain", async () => {
    const outcome = await pd.evaluate(
      request(quote.list, {
        type: "agent",
        tenant: ORG,
        claims: { ...claims(), act: { sub: "agent-1" } },
      }),
    );
    // An actor with no delegation denies (invariant 1).
    expect(outcome).toMatchObject({ outcome: "denied" });
  });

  it("denies an unknown permission and a throwing source", async () => {
    expect(
      // SAFETY: a value that is not a PermDock permission, to prove evaluate refuses it.
      await pd.evaluate(request({ key: "x" } as never, { claims: claims() })),
    ).toMatchObject({ outcome: "denied" });
    const throwing = authorizer({
      policy,
      options: {
        // SAFETY: a deliberately broken source; only its throw matters.
        memberships: {
          async load() {
            throw new Error("down");
          },
        } as never,
      },
    });
    expect(
      await throwing.evaluate(
        request(quote.list, { claims: claims(), tenant: ORG }),
      ),
    ).toMatchObject({ outcome: "denied" });
  });

  it("answers a batch in order with one instance per caller", async () => {
    const outcomes = await pd.evaluations?.([
      request(quote.read, { claims: claims(), tenant: ORG, properties: row }),
      request(quote.delete, { claims: claims(), tenant: ORG, properties: row }),
      request(quote.read, { tenant: ORG, properties: row }),
    ]);
    expect(outcomes?.map((o) => o.outcome)).toStrictEqual([
      "granted",
      "denied",
      "denied",
    ]);
  });

  it("shares one instance per claims, tenant and intent through better-supabase 0.15's runtime memo", async () => {
    const answers = new Map<string, Promise<unknown>>();
    let loads = 0;
    const memo = {
      once<T>(key: string, load: () => Promise<T>): Promise<T> {
        if (!answers.has(key)) {
          loads += 1;
          answers.set(key, load());
        }
        // SAFETY: every key is written once above with the promise of a load of the same T.
        return answers.get(key) as Promise<T>;
      },
    };
    // 0.13 types `evaluate` with one parameter; 0.15 passes the runtime second.
    const evaluate: (
      request: AuthorizationRequest<Permission>,
      runtime: { readonly memo: typeof memo },
    ) => AuthorizationOutcome | Promise<AuthorizationOutcome> =
      pd.evaluate.bind(pd);
    const outcomes = [
      await evaluate(
        request(quote.read, { claims: claims(), tenant: ORG, properties: row }),
        { memo },
      ),
      await evaluate(
        request(quote.delete, {
          claims: claims(),
          tenant: ORG,
          properties: row,
        }),
        { memo },
      ),
      await evaluate(
        request(quote.read, {
          claims: claims(OTHER, [ORG, OTHER]),
          tenant: OTHER,
          properties: { id: "q2", organization_id: OTHER },
        }),
        { memo },
      ),
    ];
    expect(outcomes.map((o) => o.outcome)).toStrictEqual([
      "granted",
      "denied",
      "granted",
    ]);
    // A read and a delete in ORG, and a read in OTHER.
    expect(loads).toBe(3);
  });

  describe("intent and versions", () => {
    const tracked = () => {
      const live: boolean[] = [];
      const versions = {
        maxStaleMs: 5_000,
        current: (
          _principal: unknown,
          read: () => number | undefined | Promise<number | undefined>,
          options: { readonly live: boolean },
        ) => {
          live.push(options.live);
          return read();
        },
        evict: () => undefined,
        stats: () => ({ reads: 0, shared: 0, hits: 0, evictions: 0, size: 0 }),
      };
      return { live, versions };
    };
    const source = { membershipsFor: () => [], version: () => 1 };
    const versioned = { ...claims(), authz_ver: 1 };
    // 0.13 types `evaluate` and `evaluations` with one parameter; 0.15 passes the runtime second.
    type Runtime = { readonly versions?: unknown };
    const evaluateOf =
      (checked: ReturnType<typeof authorizer>) =>
      (r: AuthorizationRequest<Permission>, runtime: Runtime) =>
        // SAFETY: 0.15 calls evaluate with the runtime second; the 0.13 type omits it
        (
          checked.evaluate as (
            r: AuthorizationRequest<Permission>,
            runtime: Runtime,
          ) => Promise<AuthorizationOutcome>
        )(r, runtime);

    it("reads from better-supabase's runtime versions for a read and live for a write", async () => {
      const { live, versions } = tracked();
      const evaluate = evaluateOf(authorizer({ policy, memberships: source }));
      const read = await evaluate(
        request(quote.read, {
          claims: versioned,
          tenant: ORG,
          properties: row,
        }),
        { versions },
      );
      const write = await evaluate(
        request(quote.update, {
          claims: versioned,
          tenant: ORG,
          properties: row,
        }),
        { versions },
      );
      expect([read.outcome, write.outcome]).toStrictEqual([
        "granted",
        "granted",
      ]);
      expect(live).toStrictEqual([false, true]);
    });

    it("treats a batch as a read and falls back to the versions option", async () => {
      const { live, versions } = tracked();
      const checked = authorizer({ policy, memberships: source, versions });
      await checked.evaluations?.([
        request(quote.update, {
          claims: versioned,
          tenant: ORG,
          properties: row,
        }),
      ]);
      expect(live).toStrictEqual([false]);
    });

    it("reads the version from the version option", async () => {
      const { live, versions } = tracked();
      let reads = 0;
      const checked = authorizer({
        policy,
        memberships: { membershipsFor: () => [] },
        version: () => {
          reads += 1;
          return 1;
        },
        versions,
      });
      await checked.evaluate(
        request(quote.update, {
          claims: versioned,
          tenant: ORG,
          properties: row,
        }),
      );
      expect([live, reads]).toStrictEqual([[true], 1]);
    });

    it("takes the intent from the intent option", async () => {
      const { live, versions } = tracked();
      const evaluate = evaluateOf(
        authorizer({ policy, memberships: source, intent: () => "write" }),
      );
      await evaluate(
        request(quote.read, {
          claims: versioned,
          tenant: ORG,
          properties: row,
        }),
        { versions },
      );
      expect(live).toStrictEqual([true]);
    });
  });

  it("reports a thrown check to onError and still denies", async () => {
    const seen: unknown[] = [];
    const failing = authorizer({
      // SAFETY: not a policy, so getPermDock throws; only that throw matters.
      policy: {} as never,
      onError: (error, context) => {
        seen.push(error instanceof Error, context);
        throw new Error("sink down");
      },
    });
    expect(
      await failing.evaluate(
        request(quote.list, { claims: claims(), tenant: ORG }),
      ),
    ).toStrictEqual({
      outcome: "denied",
      reason: "The permission check failed.",
    });
    expect(
      await failing.evaluations?.([request(quote.read, { claims: claims() })]),
    ).toMatchObject([{ outcome: "denied" }]);
    expect(seen).toStrictEqual([
      true,
      { permission: "quote.list", tenant: ORG },
      true,
      { permission: "quote.read", tenant: null },
    ]);
  });

  it("resolves forOperation only when operations are given", () => {
    expect("forOperation" in pd).toBe(false);
    const withOperations = authorizer({
      policy,
      operations: { quotes: { list: quote.list } },
    });
    expect(withOperations.forOperation?.("quotes", "list")).toBe(quote.list);
    expect(withOperations.forOperation?.("quotes", "get")).toBeUndefined();
    expect(withOperations.forOperation?.("quotes", "drop")).toBeUndefined();
    expect(
      withOperations.forOperation?.("constructor", "list"),
    ).toBeUndefined();
  });
});
