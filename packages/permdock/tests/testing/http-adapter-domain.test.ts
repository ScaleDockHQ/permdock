import { describe, expect, it } from "vitest";

import {
  createDomain,
  project,
} from "../../src/testing/http-adapter/domain.ts";
import { signSaasToken } from "../../src/testing/saas/tokens.ts";

describe("the HTTP scenario domain", () => {
  it("drops a demoted user's org and team memberships in that org", async () => {
    const domain = createDomain();
    const authorization = `Bearer ${await signSaasToken("gina")}`;
    const before = await domain.subject(authorization, "/acme/projects");
    expect(before?.memberships?.length).toBeGreaterThan(0);
    const restore = domain.demote("gina", "acme");
    const after = await domain.subject(authorization, "/acme/projects");
    expect(after?.memberships).toStrictEqual([]);
    restore();
    expect(
      (await domain.subject(authorization, "/acme/projects"))?.memberships,
    ).toStrictEqual(before?.memberships);
  });

  it("answers null for an unknown project and throws for a missing seed row", () => {
    const domain = createDomain();
    expect(domain.project(undefined)).toBeNull();
    expect(domain.project("missing")).toBeNull();
    expect(domain.project("p1")?.id).toBe("p1");
    expect(() => project("missing")).toThrow("no seed project missing");
  });
});
