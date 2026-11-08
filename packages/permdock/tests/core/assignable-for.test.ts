import { describe, expect, it } from "vitest";

import { assignableFor, snapshotFor } from "../../src/index.ts";
import { alice, policy } from "../fixtures/saas.ts";

describe(assignableFor, () => {
  it("matches the assignable entry a full snapshot carries for the tenant", () => {
    const snapshot = snapshotFor(policy, alice, {
      tenant: "acme",
      tenants: "all",
    });
    const entry = snapshot.assignable?.find((item) => item.tenant === "acme");
    expect(assignableFor(policy, alice, { tenant: "acme" })).toStrictEqual(
      entry,
    );
  });

  it("answers nothing for a tenant the subject does not hold", () => {
    expect(assignableFor(policy, alice, { tenant: "nowhere" })).toStrictEqual({
      tenant: "nowhere",
      roles: [],
      permissions: [],
    });
  });

  it("answers nothing for an anonymous subject", () => {
    expect(assignableFor(policy, null, { tenant: "acme" }).roles).toStrictEqual(
      [],
    );
  });
});
