"use client";

import { Button } from "@/components/ui/button";

import { applyReview } from "../review-actions.ts";

const missing = "00000000-0000-4000-8000-0000000000e1";

export function ReviewPanel(props: { readonly organizationId: string }) {
  return (
    <Button
      size="sm"
      onClick={() => {
        void applyReview({
          organizationId: props.organizationId,
          reviewId: missing,
        });
      }}
    >
      Apply
    </Button>
  );
}
