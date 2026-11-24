import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  authorizationHooks,
  authorizer,
} from "../../src/better-supabase/index.ts";
import { warmUp } from "../../src/core/warm.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";
import { warm as warmNext } from "../../src/next/index.ts";

const Quote = z.object({ id: z.string(), organization_id: z.string() });
const permissions = definePermissions({
  quote: resource(Quote, {
    id: "id",
    actions: ["read"],
    relations: {
      organization: { field: "organization_id", memberOf: "organization" },
    },
  }),
});
const policy = definePolicy(permissions, {
  scopes: { organization: { key: "organization_id" } },
  // SAFETY: the resolver always passes a Subject, which this mapper returns unchanged.
  subject: (user: unknown) => user as never,
  roles: [
    role("editor", [allow(permissions.quote.read)], { on: "organization" }),
  ],
});

describe("warm", () => {
  it("builds an instance from the authorizer, the hooks and permdock/next", async () => {
    for (const report of await Promise.all([
      authorizer({ policy }).warm(),
      authorizationHooks({ policy }).warm(),
      warmNext(policy),
    ])) {
      expect(report.ok).toBe(true);
      expect(report.ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("answers ok false instead of rejecting when the instance cannot be built", async () => {
    const report = await warmUp(policy, () => {
      throw new Error("down");
    });
    expect(report.ok).toBe(false);
    expect(report.ms).toBeGreaterThanOrEqual(0);
  });
});
