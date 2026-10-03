import { describe, expect, it } from "vitest";

import { snapshotTag } from "../../src/next/index.ts";

describe("snapshotTag", () => {
  it("names one subject, or anon without one", () => {
    expect(snapshotTag("u1")).toBe("permdock:u1");
    expect(snapshotTag(undefined)).toBe("permdock:anon");
    expect(snapshotTag(null)).toBe("permdock:anon");
    expect(snapshotTag("")).toBe("permdock:anon");
    expect(snapshotTag()).toBe("permdock:anon");
  });
});
