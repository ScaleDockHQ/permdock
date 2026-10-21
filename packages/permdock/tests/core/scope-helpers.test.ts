import { describe, expect, it } from "vitest";

import {
  normalizeMembership,
  normalizeMemberships,
  resolveScope,
} from "../../src/index.ts";

const scopes = [
  { name: "org", key: "orgId" },
  { name: "project", key: "projectId", within: "org" },
];

describe("scope helpers", () => {
  it("normalise a legacy tenant and team membership onto catalog scopes", () => {
    expect(
      normalizeMembership(
        { tenant: "o_1", team: "p_1", roles: ["dev"] },
        scopes,
      ),
    ).toStrictEqual({
      scope: "project",
      id: "p_1",
      within: { org: "o_1" },
      roles: ["dev"],
    });
  });

  it("use the implicit tenant and team pair without scopes", () => {
    expect(
      normalizeMembership({ tenant: "o_1", roles: ["admin"] }),
    ).toStrictEqual({ scope: "tenant", id: "o_1", roles: ["admin"] });
  });

  it("drop malformed memberships", () => {
    expect(
      normalizeMembership({ scope: "project", id: "p_1", roles: [] }, scopes),
    ).toBeUndefined();
    expect(
      normalizeMemberships(
        [
          { scope: "org", id: "o_1", roles: ["admin"] },
          { roles: "admin" },
          null,
        ],
        scopes,
      ),
    ).toStrictEqual([{ scope: "org", id: "o_1", roles: ["admin"] }]);
  });

  it("resolve declared names and aliases", () => {
    expect(resolveScope(scopes, "project")).toBe("project");
    expect(resolveScope(scopes, "tenant")).toBe("org");
    expect(resolveScope(scopes, "team")).toBe("project");
    expect(resolveScope(scopes, "resource")).toBeUndefined();
    expect(resolveScope(undefined, "team")).toBe("team");
  });
});
