import type * as Vitest from "vitest";

import { type TestContext, describe, vi } from "vitest";

import type { CatalogDocument } from "../../src/catalog/types.ts";

import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";
import { testCloudApi } from "../../src/testing/cloud-api/index.ts";
import {
  type ReferenceCloudMutation,
  referenceCloud,
} from "./fixtures/reference-cloud.ts";

const rejecting = vi.hoisted(() => {
  const state: { pattern: RegExp | undefined } = { pattern: undefined };
  return state;
});

vi.mock("vitest", async (importOriginal) => {
  const actual = await importOriginal<typeof Vitest>();
  const it = Object.assign(
    (
      name: string,
      fn: (context: TestContext) => unknown,
      timeout?: number,
    ): void => {
      const pattern = rejecting.pattern;
      if (pattern === undefined || !pattern.test(name)) {
        actual.it(name, fn, timeout);
        return;
      }
      actual.it(
        `rejects the broken Cloud: ${name}`,
        async (context) => {
          await actual
            .expect(Promise.resolve().then(() => fn(context)))
            .rejects.toThrow();
        },
        timeout,
      );
    },
    actual.it,
    { skipIf: (condition: unknown) => actual.it.skipIf(condition) },
  );
  return { ...actual, it };
});

const permissions = definePermissions({
  post: resource({ actions: ["read", "delete"] }),
});

const policy = definePolicy(permissions, {
  roles: [
    role("admin", [
      allow(permissions.post.read),
      allow(permissions.post.delete),
    ]),
    role("member", [allow(permissions.post.read)]),
  ],
  hostable: [permissions.post.read],
  subject: () => null,
});

const catalog: CatalogDocument = {
  $schema: "https://permdock.com/schemas/catalog-v1.json",
  version: 1,
  generatedAt: "2026-10-16T10:00:00.000Z",
  generator: "permdock@0.4.0",
  resources: { post: { id: "id", schema: { type: "object" } } },
  permissions: ["read", "delete"].map((action) => ({
    key: `post.${action}`,
    resource: "post",
    action,
    scope: `post:${action}`,
    arity: "instance" as const,
    meta: {},
    usages: [],
    rowConditions: false,
  })),
};

async function register(mutation?: ReferenceCloudMutation): Promise<void> {
  const reference = await referenceCloud(policy, catalog, mutation);
  testCloudApi(reference.url, reference.keys, {
    environment: reference.environment,
    fetch: reference.fetch,
    approver: reference.approver,
    subject: reference.subject,
    verifier: reference.verifier,
    platform: {
      token: reference.platform.token,
      unpublished: {
        project: reference.platform.unpublished,
        token: reference.platform.login,
      },
      registration: true,
    },
  });
}

describe("testCloudApi passes the reference Cloud", async () => {
  await register();
});

const MUTATIONS: readonly (readonly [ReferenceCloudMutation, RegExp])[] = [
  ["no-auth", /401 Problem Details without a key/u],
  ["any-key-kind", /403 to a key of another kind/u],
  ["no-etag", /sends an ETag/u],
  ["ignore-etag", /sends an ETag/u],
  ["signs-own-types", /refuses to sign/u],
  ["no-idempotency", /Idempotency-Key/u],
  ["replay-subject", /fresh subject token/u],
  [
    "json-errors",
    /shapes cloud-api-v1.json documents|401 Problem Details without a key/u,
  ],
  ["drops-reason", /422 with a reason/u],
  ["catalog-always-new", /answers unchanged/u],
  ["no-ratelimit", /RateLimit fields/u],
  ["token-writes", /read-only token/u],
  [
    "policy-404-plain",
    /policy-not-published|shapes cloud-api-v1.json documents/u,
  ],
];

for (const [mutation, pattern] of MUTATIONS) {
  describe(`testCloudApi rejects a Cloud with ${mutation}`, async () => {
    rejecting.pattern = pattern;
    try {
      await register(mutation);
    } finally {
      rejecting.pattern = undefined;
    }
  });
}
