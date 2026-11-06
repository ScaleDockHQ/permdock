import { describe, expect, it } from "vitest";

import { orgQuotesTopic, quoteFilesPath } from "../src/generated/constants.ts";

const organization = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

describe("generated names", () => {
  it("builds the Realtime topic the realtime.messages policy reads", () => {
    expect(orgQuotesTopic({ organization })).toBe(`org:${organization}:quotes`);
  });

  it("builds a quote-files object path that starts with the organization id", () => {
    expect(quoteFilesPath({ organization, name: "q1.pdf" })).toBe(
      `${organization}/q1.pdf`,
    );
  });
});
