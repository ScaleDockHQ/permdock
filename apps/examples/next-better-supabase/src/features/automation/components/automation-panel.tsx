"use client";

import { Button } from "@/components/ui/button";

import { publishAutomation } from "../automation-actions.ts";

export function AutomationPanel(props: { readonly organizationId: string }) {
  return (
    <Button
      size="sm"
      onClick={() => {
        void publishAutomation({ organizationId: props.organizationId });
      }}
    >
      Publish
    </Button>
  );
}
