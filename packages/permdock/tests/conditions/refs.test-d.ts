import { describe, expectTypeOf, it } from "vitest";

import type { SubjectRef } from "../../src/conditions/refs.ts";

import {
  allow,
  claim,
  definePermissions,
  definePolicy,
  principal,
  resource,
  role,
} from "../../src/index.ts";

describe("claim refs under noUncheckedIndexedAccess", () => {
  it("types principal.claims and claim() as SubjectRef", () => {
    expectTypeOf(principal.claims).toEqualTypeOf<SubjectRef>();
    expectTypeOf(claim("team_ids")).toEqualTypeOf<SubjectRef>();
    expectTypeOf(claim("attrs.region")).toEqualTypeOf<SubjectRef>();
  });

  it("accepts claim() in a where condition", () => {
    const permissions = definePermissions({
      job: resource({ id: "id", actions: ["read"] }),
    });
    definePolicy(permissions, {
      roles: [
        role("manager", [
          allow(permissions.job.read, {
            where: { teamId: { in: claim("team_ids") } },
          }),
        ]),
      ],
      subject: () => null,
    });
  });
});
