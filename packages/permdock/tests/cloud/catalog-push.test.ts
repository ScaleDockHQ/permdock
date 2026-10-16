import { describe, expect, it } from "vitest";

import type { CatalogDocument } from "../../src/catalog/types.ts";

import { cloud } from "../../src/cloud/create.ts";
import { catalogFingerprint } from "../../src/core/catalog-fingerprint.ts";

const CLOUD_URL = "https://cloud.permdock.test";
const KEY = "env-key";

const document: CatalogDocument = {
  $schema: "https://permdock.com/schemas/catalog-v1.json",
  version: 1,
  generatedAt: "2026-10-14T10:00:00.000Z",
  generator: "permdock@0.1.0",
  resources: { invoice: { id: "id", schema: { type: "object" } } },
  permissions: [
    {
      key: "invoice.read",
      resource: "invoice",
      action: "read",
      scope: "invoice:read",
      arity: "instance",
      meta: {},
      usages: [],
      rowConditions: false,
    },
  ],
  operations: [{ name: "getInvoice", permission: "invoice.read", meta: {} }],
};

describe("cloud().catalog.push", () => {
  it("posts the catalog with its operations and fingerprint", async () => {
    const posted: unknown[] = [];
    const client = cloud({
      url: CLOUD_URL,
      key: KEY,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        expect(request.url).toBe(
          `${CLOUD_URL}/v1/environments/production/catalog`,
        );
        expect(request.method).toBe("POST");
        expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
        posted.push(await request.json());
        return Response.json(
          {
            version: 2,
            fingerprint: catalogFingerprint(document),
            findings: [
              {
                code: "permission-removed",
                permission: "invoice.void",
                grant: "g_1",
              },
            ],
          },
          { status: 201 },
        );
      },
    });
    const fingerprint = catalogFingerprint(document);
    expect(await client.catalog.push(document)).toEqual({
      version: 2,
      fingerprint,
      findings: [
        {
          code: "permission-removed",
          permission: "invoice.void",
          grant: "g_1",
        },
      ],
    });
    expect(posted).toEqual([{ fingerprint, catalog: document }]);
  });

  it("returns unchanged for a fingerprint already published", async () => {
    const client = cloud({
      url: CLOUD_URL,
      key: KEY,
      fetch: () =>
        Promise.resolve(
          Response.json({ version: 1, fingerprint: "f", unchanged: true }),
        ),
    });
    expect(await client.catalog.push(document)).toEqual({
      version: 1,
      fingerprint: "f",
      unchanged: true,
    });
  });

  it.each([
    [{ fingerprint: "f", findings: [] }],
    [{ version: 1, findings: [] }],
    [{ version: 1, fingerprint: "f" }],
    [{ version: 1, fingerprint: "f", findings: [{ code: "made-up" }] }],
    [[]],
  ])("throws on an unknown answer %j", async (body) => {
    const client = cloud({
      url: CLOUD_URL,
      key: KEY,
      fetch: () => Promise.resolve(Response.json(body)),
    });
    await expect(client.catalog.push(document)).rejects.toThrow(
      "unknown shape",
    );
  });

  it("throws when the Cloud rejects the catalog", async () => {
    const client = cloud({
      url: CLOUD_URL,
      key: KEY,
      fetch: () => Promise.resolve(new Response(null, { status: 422 })),
    });
    await expect(client.catalog.push(document)).rejects.toThrow(
      "PermDock Cloud rejected the catalog: HTTP 422",
    );
  });
});
