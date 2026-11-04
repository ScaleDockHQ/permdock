import { describe } from "vitest";

import type { VersionStore } from "../../src/index.ts";

import { testVersionStore } from "../../src/testing/index.ts";

function mapStore(): VersionStore {
  const versions = new Map<string, number>();
  return {
    get: (id) => versions.get(id),
    set: (id, version) => {
      versions.set(id, version);
    },
    delete: (id) => {
      versions.delete(id);
    },
  };
}

describe("testVersionStore: a Map-backed store", () => {
  testVersionStore(mapStore());
});
