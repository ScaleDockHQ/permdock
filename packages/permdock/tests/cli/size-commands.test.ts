import { describe, expect, it } from "vitest";

import { claimsSize } from "../../src/cli/claims-size.ts";

describe("claims size", () => {
  it("keeps every membership under the budget", () => {
    const report = claimsSize({
      memberships: 3,
      roles: 1,
      scope: "organization",
      budget: 1024,
    });
    expect(report.truncated).toBe(false);
    expect(report.kept).toBe(3);
  });

  it("truncates to the entries that fit the budget", () => {
    const report = claimsSize({
      memberships: 60,
      roles: 1,
      scope: "organization",
      budget: 1024,
    });
    expect(report.truncated).toBe(true);
    expect(report.kept).toBe(report.fits);
    expect(report.claimBytes).toBeGreaterThan(report.budget);
  });
});
