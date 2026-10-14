import { describe } from "vitest";
import { z } from "zod";

import type { DecisionProvider } from "../../src/core/interfaces.ts";
import type { Subject } from "../../src/core/subject.ts";
import type { SnapshotStorage } from "../../src/react-native/types.ts";

import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { remotePdp } from "../../src/pdp/index.ts";
import { memorySnapshotStorage } from "../../src/react-native/storage.ts";
import {
  testDecisionProvider,
  testSnapshotStorage,
} from "../../src/testing/conformance/providers.ts";

const permissions = definePermissions({
  post: resource(z.object({ id: z.string() }), {
    id: "id",
    actions: ["read"],
  }),
});

const subject: Subject = Object.freeze({
  principal: Object.freeze({ id: "user-1", roles: ["member"] }),
  context: Object.freeze({}),
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function pdp(fetch: typeof globalThis.fetch): DecisionProvider {
  return remotePdp({
    url: "https://pdp.example",
    endpoints: { evaluation: "https://pdp.example/access/v1/evaluation" },
    fetch,
  });
}

describe("testDecisionProvider over remotePdp", () => {
  testDecisionProvider(
    pdp(async () => jsonResponse({ decision: true })),
    {
      permission: permissions.post.read,
      subject,
      data: { id: "p1" },
      unavailable: pdp(async () => {
        throw new TypeError("offline");
      }),
    },
  );
});

describe("testDecisionProvider over a provider that lists ids", () => {
  const listing: DecisionProvider = {
    name: "listing",
    handles: () => true,
    decide: async ({ local }) => local,
    permitted: async () => ["p1", "p2"],
  };
  testDecisionProvider(listing, { permission: permissions.post.read, subject });
});

describe("testSnapshotStorage over memorySnapshotStorage", () => {
  testSnapshotStorage(memorySnapshotStorage());
});

describe("testSnapshotStorage over an async storage", () => {
  const map = new Map<string, string>();
  const storage: SnapshotStorage = {
    getItem: async (key) => map.get(key) ?? null,
    setItem: async (key, value) => {
      map.set(key, value);
    },
    removeItem: async (key) => {
      map.delete(key);
    },
  };
  testSnapshotStorage(storage);
});
