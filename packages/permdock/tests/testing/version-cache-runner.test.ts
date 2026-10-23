import { describe } from "vitest";

import { memoryVersionCache } from "../../src/index.ts";
import { testVersionCache } from "../../src/testing/index.ts";

describe("testVersionCache: memoryVersionCache", () => {
  testVersionCache(memoryVersionCache({ maxStaleMs: 5000 }));
});

describe("testVersionCache: memoryVersionCache with no staleness", () => {
  testVersionCache(memoryVersionCache({ maxStaleMs: 0 }));
});
