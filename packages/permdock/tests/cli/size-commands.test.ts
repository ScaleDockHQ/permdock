import { describe, expect, it } from "vitest";

import { claimsSize, runClaimsSize } from "../../src/cli/claims-size.ts";

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

describe("claims size report", () => {
  it("prints a text report when all memberships fit", () => {
    const result = runClaimsSize({
      memberships: 2,
      roles: 1,
      scope: "organization",
      budget: undefined,
      json: false,
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain("all fit the");
  });

  it("prints the budget cut and JSON when they do not", () => {
    const text = runClaimsSize({
      memberships: 80,
      roles: 2,
      scope: "organization",
      budget: 512,
      json: false,
    });
    expect(text.output).toContain("sets memberships_truncated");
    const json = runClaimsSize({
      memberships: 80,
      roles: 2,
      scope: "organization",
      budget: 512,
      json: true,
    });
    expect(JSON.parse(json.output ?? "{}")).toMatchObject({ truncated: true });
  });

  it("keeps nothing when the budget is smaller than one entry", () => {
    const report = claimsSize({
      memberships: 0,
      roles: 1,
      scope: "organization",
      budget: 1,
    });
    expect(report.fits).toBe(0);
    expect(report.kept).toBe(0);
  });
});
