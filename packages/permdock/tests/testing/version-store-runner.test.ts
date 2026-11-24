import { describe } from "vitest";

import type { VersionStore } from "../../src/index.ts";

import { testVersionStore } from "../../src/testing/index.ts";

function mapStore(): VersionStore {
  const versions = new Map<string, { version: number; at: number }>();
  return {
    get: (id) => versions.get(id),
    set: (id, version, at) => {
      versions.set(id, { version, at });
    },
    delete: (id) => {
      versions.delete(id);
    },
  };
}

describe("testVersionStore: a Map-backed store", () => {
  testVersionStore(mapStore());
});
