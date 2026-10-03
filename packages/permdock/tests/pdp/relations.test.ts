import { describe, expect, it } from "vitest";
import { z } from "zod";

import { definePermissions, resource } from "../../src/core/permissions.ts";
import { definePolicy, deny, role } from "../../src/core/policy.ts";
import { createPermDock, openfga, spicedb } from "../../src/pdp/index.ts";

const permissions = definePermissions({
  doc: resource(z.object({ id: z.string() }), {
    id: "id",
    actions: ["read", "delete"],
  }),
});

type Call = { readonly url: string; readonly body: Record<string, unknown> };

function recorder(answer: (call: Call) => Response): {
  readonly calls: Call[];
  readonly fetch: typeof fetch;
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      // SAFETY: the provider under test posts a JSON object body on every call.
      const call = {
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      calls.push(call);
      return answer(call);
    },
  };
}

function docId(data: unknown): { readonly id?: string } {
  // SAFETY: data is a doc row from rows below, or undefined for a type-level check.
  const id = (data as { readonly id?: string } | undefined)?.id;
  return id === undefined ? {} : { id };
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function policyWith(provider: ReturnType<typeof openfga>) {
  return definePolicy(permissions, {
    roles: [role("member", [deny(permissions.doc.delete)])],
    subject: (user: { readonly id: string }) => ({
      id: user.id,
      roles: ["member"],
    }),
    providers: [provider],
  });
}

const rows = [{ id: "d1" }, { id: "d2" }, { id: "d3" }];

describe("openfga", () => {
  const map = [
    [
      permissions.doc.read,
      (subject, data) => ({
        user: `user:${subject.principal?.id ?? ""}`,
        relation: "viewer",
        type: "document",
        ...docId(data),
      }),
    ],
    [
      permissions.doc.delete,
      (subject, data) => ({
        user: `user:${subject.principal?.id ?? ""}`,
        relation: "owner",
        type: "document",
        ...docId(data),
      }),
    ],
  ] as const satisfies Parameters<typeof openfga>[0]["map"];

  it("checks one tuple and lists objects for filter and where", async () => {
    const fga = recorder((call) =>
      call.url.endsWith("/check")
        ? json({ allowed: true })
        : json({ objects: ["document:d1", "document:d3"] }),
    );
    const permdock = await createPermDock(
      policyWith(
        openfga({
          url: "http://fga.test",
          storeId: "s1",
          authorizationModelId: "m1",
          map,
          fetch: fga.fetch,
        }),
      ),
      { id: "anne" },
    );
    expect((await permdock.decide(permissions.doc.read, rows[0])).outcome).toBe(
      "granted",
    );
    expect(fga.calls[0]).toEqual({
      url: "http://fga.test/stores/s1/check",
      body: {
        authorization_model_id: "m1",
        tuple_key: {
          user: "user:anne",
          relation: "viewer",
          object: "document:d1",
        },
      },
    });
    expect(
      (await permdock.filter(permissions.doc.read, rows)).map((row) => row.id),
    ).toEqual(["d1", "d3"]);
    expect(fga.calls[1]).toEqual({
      url: "http://fga.test/stores/s1/list-objects",
      body: {
        authorization_model_id: "m1",
        type: "document",
        relation: "viewer",
        user: "user:anne",
      },
    });
    expect(await permdock.where(permissions.doc.read)).toEqual({
      condition: { op: "in", field: "id", value: ["d1", "d3"] },
      partial: true,
    });
  });

  it("keeps a local deny over a remote allow", async () => {
    const fga = recorder(() =>
      json({ allowed: true, objects: ["document:d1"] }),
    );
    const permdock = await createPermDock(
      policyWith(
        openfga({
          url: "http://fga.test",
          storeId: "s1",
          map,
          fetch: fga.fetch,
        }),
      ),
      { id: "anne" },
    );
    expect(
      (await permdock.decide(permissions.doc.delete, rows[0])).outcome,
    ).toBe("denied");
    expect(await permdock.filter(permissions.doc.delete, rows)).toEqual([]);
    expect(fga.calls.every((call) => !call.url.endsWith("/check"))).toBe(true);
  });

  it("fails closed on errors, unknown shapes and foreign object types", async () => {
    const cases: readonly [Response, string][] = [
      [json({}, 500), "pdp-unavailable"],
      [json({ allowed: "yes" }), "pdp-invalid-response"],
    ];
    for (const [response, reason] of cases) {
      const permdock = await createPermDock(
        policyWith(
          openfga({
            url: "http://fga.test",
            storeId: "s1",
            map,
            fetch: async () => response.clone(),
          }),
        ),
        { id: "anne" },
      );
      const decision = await permdock.decide(permissions.doc.read, rows[0]);
      expect(decision.outcome === "denied" && decision.denials[0]?.reason).toBe(
        reason,
      );
    }
    const permdock = await createPermDock(
      policyWith(
        openfga({
          url: "http://fga.test",
          storeId: "s1",
          map,
          fetch: async () => json({ objects: ["folder:d1"] }),
        }),
      ),
      { id: "anne" },
    );
    expect(await permdock.filter(permissions.doc.read, rows)).toEqual([]);
  });

  it("denies with pdp-invalid-response when the tuple callback throws", async () => {
    const permdock = await createPermDock(
      policyWith(
        openfga({
          url: "http://fga.test",
          storeId: "s1",
          map: [
            [
              permissions.doc.read,
              () => {
                throw new Error("boom");
              },
            ],
          ],
          fetch: async () => json({ allowed: true }),
        }),
      ),
      { id: "anne" },
    );
    const decision = await permdock.decide(permissions.doc.read, rows[0]);
    expect(decision.outcome === "denied" && decision.denials[0]?.reason).toBe(
      "pdp-invalid-response",
    );
  });
});

describe("spicedb", () => {
  const map = [
    [
      permissions.doc.read,
      (subject, data) => ({
        subject: { type: "user", id: subject.principal?.id ?? "" },
        permission: "view",
        resource: {
          type: "document",
          ...docId(data),
        },
      }),
    ],
  ] as const satisfies Parameters<typeof spicedb>[0]["map"];

  it("checks a permission and reads the LookupResources stream", async () => {
    const authorizations: (string | null)[] = [];
    const calls: Call[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization"));
      // SAFETY: the provider under test posts a JSON object body on every call.
      const call = {
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      calls.push(call);
      if (call.url.endsWith("/check")) {
        return json({ permissionship: "PERMISSIONSHIP_HAS_PERMISSION" });
      }
      return new Response(
        [
          {
            result: {
              resourceObjectId: "d2",
              permissionship: "LOOKUP_PERMISSIONSHIP_HAS_PERMISSION",
            },
          },
          {
            result: {
              resourceObjectId: "d3",
              permissionship: "LOOKUP_PERMISSIONSHIP_CONDITIONAL_PERMISSION",
            },
          },
        ]
          .map((line) => JSON.stringify(line))
          .join("\n"),
      );
    };
    const permdock = await createPermDock(
      policyWith(
        spicedb({
          url: "http://spicedb.test",
          token: "key",
          map,
          fetch: fetcher,
        }),
      ),
      { id: "anne" },
    );
    expect((await permdock.decide(permissions.doc.read, rows[0])).outcome).toBe(
      "granted",
    );
    expect(calls[0]).toEqual({
      url: "http://spicedb.test/v1/permissions/check",
      body: {
        consistency: { minimizeLatency: true },
        resource: { objectType: "document", objectId: "d1" },
        permission: "view",
        subject: { object: { objectType: "user", objectId: "anne" } },
      },
    });
    expect(
      (await permdock.filter(permissions.doc.read, rows)).map((row) => row.id),
    ).toEqual(["d2"]);
    expect(calls[1]?.body).toEqual({
      consistency: { minimizeLatency: true },
      resourceObjectType: "document",
      permission: "view",
      subject: { object: { objectType: "user", objectId: "anne" } },
    });
    expect(authorizations).toEqual(["Bearer key", "Bearer key"]);
  });

  it("treats a conditional check as a denial and an unknown one as invalid", async () => {
    for (const [permissionship, reason] of [
      ["PERMISSIONSHIP_CONDITIONAL_PERMISSION", "pdp-denied"],
      ["PERMISSIONSHIP_UNSPECIFIED", "pdp-invalid-response"],
    ] as const) {
      const permdock = await createPermDock(
        policyWith(
          spicedb({
            url: "http://spicedb.test",
            token: "key",
            map,
            fetch: async () => json({ permissionship }),
          }),
        ),
        { id: "anne" },
      );
      const decision = await permdock.decide(permissions.doc.read, rows[0]);
      expect(decision.outcome === "denied" && decision.denials[0]?.reason).toBe(
        reason,
      );
    }
  });

  it("denies every row when the stream carries an error", async () => {
    const permdock = await createPermDock(
      policyWith(
        spicedb({
          url: "http://spicedb.test",
          token: "key",
          map,
          fetch: async () =>
            new Response(JSON.stringify({ error: { code: 7, message: "no" } })),
        }),
      ),
      { id: "anne" },
    );
    expect(await permdock.filter(permissions.doc.read, rows)).toEqual([]);
  });
});
