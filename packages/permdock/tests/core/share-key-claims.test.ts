import { describe, expect, it } from "vitest";

import { scopeList } from "../../src/core/scopes.ts";
import { shareKeyClaimsEligible } from "../../src/core/share-key-claims.ts";
import { policy } from "../fixtures/saas.ts";

const scopes = scopeList(policy.scopes);
const root = scopes[0]?.name ?? "tenant";
const entry = (id: string) => ({ scope: root, id, roles: ["member"] });

describe(shareKeyClaimsEligible, () => {
  it("accepts a whole token", () => {
    expect(
      shareKeyClaimsEligible({ memberships: [entry("a")] }, "a", scopes),
    ).toBe(true);
  });

  it("refuses a token whose other lists are cut", () => {
    expect(
      shareKeyClaimsEligible(
        { memberships: [entry("a")], team_ids_truncated: true },
        "a",
        scopes,
      ),
    ).toBe(false);
  });

  it("accepts a truncated token that kept an entry outside the tenant", () => {
    expect(
      shareKeyClaimsEligible(
        { memberships: [entry("a"), entry("b")], memberships_truncated: true },
        "a",
        scopes,
      ),
    ).toBe(true);
  });

  it("refuses a truncated token that kept only the tenant's entries", () => {
    expect(
      shareKeyClaimsEligible(
        { memberships: [entry("a")], memberships_truncated: true },
        "a",
        scopes,
      ),
    ).toBe(false);
  });
});
