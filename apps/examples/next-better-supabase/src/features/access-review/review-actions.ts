"use server";

import { accessReviewApplier } from "permdock/better-supabase";
import { z } from "zod";

import { bsb } from "../../lib/supabase/server.ts";
import { protectAction } from "../../permdock/server.ts";
import { appPolicy, permissions } from "../../policy.ts";
import { reviewStore } from "./review-store.ts";

const input = z.object({ organizationId: z.uuid(), reviewId: z.uuid() });

export const applyReview = protectAction(permissions.members.remove, {
  input,
  tenant: (value) => value.organizationId,
})(async (value) => {
  const { supabase } = await bsb.cached();
  const apply = accessReviewApplier({
    client: supabase,
    reviews: reviewStore,
    policy: appPolicy,
    demoteTo: "member",
  });
  try {
    const result = await apply(value.reviewId);
    return { applied: result.applied.length, failed: result.failed.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : "apply failed";
    return { applied: 0, failed: 0, message };
  }
});
