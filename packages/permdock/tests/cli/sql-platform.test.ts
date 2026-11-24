import { describe, expect, it } from "vitest";

import {
  isPlatformSchema,
  isStripeDataPipelineSchema,
} from "../../src/cli/sql/platform.ts";

describe(isPlatformSchema, () => {
  it.each(["auth", "storage", "pg_temp_3", "stripe_sdp", "stripe_sdp_acct_1"])(
    "treats %s as a platform schema",
    (schema) => {
      expect(isPlatformSchema(schema)).toBe(true);
    },
  );

  it.each(["public", "permdock", "stripe", "billing"])(
    "leaves %s to the app",
    (schema) => {
      expect(isPlatformSchema(schema)).toBe(false);
    },
  );

  it("tells Stripe Data Pipeline schemas apart", () => {
    expect(isStripeDataPipelineSchema("stripe_sdp_acct_1")).toBe(true);
    expect(isStripeDataPipelineSchema("storage")).toBe(false);
  });
});
