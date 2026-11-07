import { describe, expect, it } from "vitest";

import { brandGuard } from "../src/lib/brand-guard.ts";

describe("brand guard", () => {
  it("accepts the product brands and refuses any other slug", () => {
    expect(brandGuard("acme")).toBe("acme");
    expect(brandGuard("globex")).toBe("globex");
    expect(brandGuard("other")).toBeNull();
  });
});
