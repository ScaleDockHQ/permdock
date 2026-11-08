import { describe, expect, it } from "vitest";

import { extraClaimsPlan } from "../../src/cli/supabase-hook/claims.ts";
import { REGISTERED_CLAIMS } from "../../src/supabase/subject.ts";

function refused(claim: string): boolean {
  return (
    extraClaimsPlan({ [claim]: "billing.fn" }, "tenant_id").errors.length > 0
  );
}

describe("supabase.hook.claims reserved names", () => {
  it.each([
    "jti",
    "nbf",
    "acr",
    "act",
    "client_id",
    "scope",
    "custom_roles_ver",
  ])("refuses to write %s", (claim) => {
    expect(refused(claim)).toBe(true);
  });

  it("reserves every claim the subject reader treats as registered", () => {
    for (const claim of REGISTERED_CLAIMS) {
      expect([claim, refused(claim)]).toStrictEqual([claim, true]);
    }
  });

  it("still accepts a claim another package owns", () => {
    expect(refused("features")).toBe(false);
  });
});
