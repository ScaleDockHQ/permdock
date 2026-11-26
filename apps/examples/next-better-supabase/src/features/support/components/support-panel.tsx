"use client";

import { Button } from "@/components/ui/button";

import { startSupport } from "../support-actions.ts";

export function SupportPanel(props: {
  readonly organizationId: string;
  readonly principal: string;
}) {
  return (
    <Button
      size="sm"
      onClick={() => {
        void startSupport({
          organizationId: props.organizationId,
          principal: props.principal,
          reason: "Investigate a quote the customer cannot open",
        });
      }}
    >
      Start read-only session
    </Button>
  );
}
