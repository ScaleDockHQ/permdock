import type { StartedTestContainer } from "testcontainers";

import {
  allow,
  definePermissions,
  definePolicy,
  deny,
  resource,
  role,
} from "permdock";
import { createPermDock, openfga, spicedb } from "permdock/pdp";
import { GenericContainer, Wait } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const permissions = definePermissions({
  doc: resource(z.object({ id: z.string(), archived: z.boolean() }), {
    id: "id",
    actions: ["read", "delete"],
  }),
});

const docs = [
  { id: "d1", archived: false },
  { id: "d2", archived: false },
  { id: "d3", archived: true },
  { id: "d4", archived: false },
];

// Anne views d1 and d3 directly and d2 through team eng; Bob owns d4.
// Locally, nobody deletes an archived document.
function policyFor(provider: ReturnType<typeof openfga>) {
  return definePolicy(permissions, {
    roles: [
      role("member", [
        allow(permissions.doc.delete),
        deny(permissions.doc.delete, { where: { archived: true } }),
      ]),
    ],
    subject: (user: { readonly id: string }) => ({
      id: user.id,
      roles: ["member"],
    }),
    providers: [provider],
  });
}

async function post(url: string, body: unknown, token?: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `${url}: ${String(response.status)} ${await response.text()}`,
    );
  }
  // SAFETY: every PDP route in this test answers a JSON object on success
  return (await response.json()) as Record<string, unknown>;
}

function sortedIds(condition: unknown): string[] {
  // SAFETY: every field stays unknown and is checked before use
  const { op, field, value } = condition as {
    readonly op?: unknown;
    readonly field?: unknown;
    readonly value?: unknown;
  };
  if (op !== "in" || field !== "id" || !Array.isArray(value)) {
    throw new Error("expected an in over the listed ids");
  }
  return value.map(String).toSorted((a, b) => a.localeCompare(b));
}

function scenarios(
  name: string,
  provider: (url?: string) => ReturnType<typeof openfga>,
  revoke: () => Promise<void>,
) {
  describe(name, () => {
    it("decides one row with check", async () => {
      const anne = await createPermDock(policyFor(provider()), { id: "anne" });
      expect((await anne.decide(permissions.doc.read, docs[0])).outcome).toBe(
        "granted",
      );
      expect((await anne.decide(permissions.doc.read, docs[3])).outcome).toBe(
        "denied",
      );
    });

    it("filters and compiles where from the listed ids, including a userset", async () => {
      const anne = await createPermDock(policyFor(provider()), { id: "anne" });
      expect(
        (await anne.filter(permissions.doc.read, docs)).map((row) => row.id),
      ).toEqual(["d1", "d2", "d3"]);
      const where = await anne.where(permissions.doc.read);
      expect(where.partial).toBe(true);
      expect(sortedIds(where.condition)).toEqual(["d1", "d2", "d3"]);
    });

    it("intersects the remote answer with local grants and denies", async () => {
      const bob = await createPermDock(policyFor(provider()), { id: "bob" });
      expect(
        (await bob.filter(permissions.doc.delete, docs)).map((row) => row.id),
      ).toEqual(["d4"]);
      const where = await bob.where(permissions.doc.delete);
      if (where.condition.op !== "and") {
        throw new Error(`expected an and, got ${where.condition.op}`);
      }
      const [local, remote] = where.condition.conditions;
      expect(local).toBeDefined();
      expect(sortedIds(remote)).toEqual(["d3", "d4"]);
      const anne = await createPermDock(policyFor(provider()), { id: "anne" });
      expect(await anne.filter(permissions.doc.delete, docs)).toEqual([]);
    });

    it("denies after the relation is removed", async () => {
      await revoke();
      const anne = await createPermDock(policyFor(provider()), { id: "anne" });
      expect((await anne.decide(permissions.doc.read, docs[0])).outcome).toBe(
        "denied",
      );
      expect(
        (await anne.filter(permissions.doc.read, docs)).map((row) => row.id),
      ).toEqual(["d2", "d3"]);
    });

    it("fails closed when the server is unreachable", async () => {
      const anne = await createPermDock(
        policyFor(provider("http://127.0.0.1:9")),
        { id: "anne" },
      );
      const decision = await anne.decide(permissions.doc.read, docs[1]);
      expect(decision.outcome === "denied" && decision.denials[0]?.reason).toBe(
        "pdp-unavailable",
      );
      expect(await anne.filter(permissions.doc.read, docs)).toEqual([]);
      expect(await anne.where(permissions.doc.read)).toEqual({
        condition: { op: "or", conditions: [] },
        partial: false,
      });
    });
  });
}

describe("permdock/pdp relation presets", () => {
  let fga: StartedTestContainer;
  let spice: StartedTestContainer;
  let fgaUrl = "";
  let storeId = "";
  let spiceUrl = "";
  const key = "permdock-test-key";

  const anneViewsD1 = {
    user: "user:anne",
    relation: "viewer",
    object: "document:d1",
  };

  beforeAll(async () => {
    [fga, spice] = await Promise.all([
      new GenericContainer("openfga/openfga:v1.21.0")
        .withCommand(["run"])
        .withExposedPorts(8080)
        .withWaitStrategy(Wait.forHttp("/healthz", 8080))
        .start(),
      new GenericContainer("authzed/spicedb:v1.56.2")
        .withCommand([
          "serve",
          "--grpc-preshared-key",
          key,
          "--datastore-engine",
          "memory",
          "--http-enabled",
        ])
        .withExposedPorts(8443, 50051)
        .withWaitStrategy(Wait.forLogMessage(/http server started serving/iu))
        .start(),
    ]);

    fgaUrl = `http://${fga.getHost()}:${String(fga.getMappedPort(8080))}`;
    storeId = String(
      (await post(`${fgaUrl}/stores`, { name: "permdock" }))["id"],
    );
    await post(`${fgaUrl}/stores/${storeId}/authorization-models`, {
      schema_version: "1.1",
      type_definitions: [
        { type: "user" },
        {
          type: "team",
          relations: { member: { this: {} } },
          metadata: {
            relations: {
              member: { directly_related_user_types: [{ type: "user" }] },
            },
          },
        },
        {
          type: "document",
          relations: {
            owner: { this: {} },
            viewer: { this: {} },
          },
          metadata: {
            relations: {
              owner: { directly_related_user_types: [{ type: "user" }] },
              viewer: {
                directly_related_user_types: [
                  { type: "user" },
                  { type: "team", relation: "member" },
                ],
              },
            },
          },
        },
      ],
    });
    await post(`${fgaUrl}/stores/${storeId}/write`, {
      writes: {
        tuple_keys: [
          anneViewsD1,
          { user: "user:anne", relation: "viewer", object: "document:d3" },
          { user: "user:anne", relation: "member", object: "team:eng" },
          {
            user: "team:eng#member",
            relation: "viewer",
            object: "document:d2",
          },
          { user: "user:bob", relation: "owner", object: "document:d4" },
          { user: "user:bob", relation: "owner", object: "document:d3" },
        ],
      },
    });

    spiceUrl = `http://${spice.getHost()}:${String(spice.getMappedPort(8443))}`;
    await post(
      `${spiceUrl}/v1/schema/write`,
      {
        schema: `definition user {}
definition team {
  relation member: user
}
definition document {
  relation owner: user
  relation viewer: user | team#member
  permission view = viewer
  permission delete = owner
}`,
      },
      key,
    );
    const touch = (
      objectId: string,
      relation: string,
      subject: {
        readonly type: string;
        readonly id: string;
        readonly relation?: string;
      },
    ) => ({
      operation: "OPERATION_TOUCH",
      relationship: {
        resource: { objectType: "document", objectId },
        relation,
        subject: {
          object: { objectType: subject.type, objectId: subject.id },
          ...(subject.relation === undefined
            ? {}
            : { optionalRelation: subject.relation }),
        },
      },
    });
    await post(
      `${spiceUrl}/v1/relationships/write`,
      {
        updates: [
          touch("d1", "viewer", { type: "user", id: "anne" }),
          touch("d3", "viewer", { type: "user", id: "anne" }),
          touch("d2", "viewer", {
            type: "team",
            id: "eng",
            relation: "member",
          }),
          touch("d4", "owner", { type: "user", id: "bob" }),
          touch("d3", "owner", { type: "user", id: "bob" }),
          {
            operation: "OPERATION_TOUCH",
            relationship: {
              resource: { objectType: "team", objectId: "eng" },
              relation: "member",
              subject: { object: { objectType: "user", objectId: "anne" } },
            },
          },
        ],
      },
      key,
    );
  }, 180_000);

  afterAll(async () => {
    await Promise.all([fga?.stop(), spice?.stop()]);
  });

  const id = (data: unknown): { readonly id?: string } => {
    // SAFETY: the tool input is an object or undefined; `id` is a string when present
    const value = (data as { readonly id?: string } | undefined)?.id;
    return value === undefined ? {} : { id: value };
  };

  scenarios(
    "OpenFGA",
    (url = fgaUrl) =>
      openfga({
        url,
        storeId,
        timeout: 5000,
        map: [
          [
            permissions.doc.read,
            (subject, data) => ({
              user: `user:${subject.principal?.id ?? ""}`,
              relation: "viewer",
              type: "document",
              ...id(data),
            }),
          ],
          [
            permissions.doc.delete,
            (subject, data) => ({
              user: `user:${subject.principal?.id ?? ""}`,
              relation: "owner",
              type: "document",
              ...id(data),
            }),
          ],
        ],
      }),
    async () => {
      await post(`${fgaUrl}/stores/${storeId}/write`, {
        deletes: { tuple_keys: [anneViewsD1] },
      });
    },
  );

  scenarios(
    "SpiceDB",
    (url = spiceUrl) =>
      spicedb({
        url,
        token: key,
        timeout: 5000,
        consistency: "fully-consistent",
        map: [
          [
            permissions.doc.read,
            (subject, data) => ({
              subject: { type: "user", id: subject.principal?.id ?? "" },
              permission: "view",
              resource: { type: "document", ...id(data) },
            }),
          ],
          [
            permissions.doc.delete,
            (subject, data) => ({
              subject: { type: "user", id: subject.principal?.id ?? "" },
              permission: "delete",
              resource: { type: "document", ...id(data) },
            }),
          ],
        ],
      }),
    async () => {
      await post(
        `${spiceUrl}/v1/relationships/write`,
        {
          updates: [
            {
              operation: "OPERATION_DELETE",
              relationship: {
                resource: { objectType: "document", objectId: "d1" },
                relation: "viewer",
                subject: { object: { objectType: "user", objectId: "anne" } },
              },
            },
          ],
        },
        key,
      );
    },
  );
});
