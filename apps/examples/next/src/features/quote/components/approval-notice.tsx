"use client";

import type { PermissionBoundaryState } from "permdock/next/client";

import { Clock } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";

export function ApprovalNotice(props: {
  readonly state: PermissionBoundaryState;
}) {
  const { state } = props;
  return (
    <Alert data-testid="delete-approval" data-permission={state.permission}>
      <Clock />
      <AlertTitle>Deleting needs approval</AlertTitle>
      <AlertDescription>
        Deleting a quote needs an admin&apos;s approval. Ask an admin, then try
        again.
      </AlertDescription>
      <div className="col-start-2 mt-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="delete-retry"
          onClick={() => {
            state.retry();
          }}
        >
          I have approval, try again
        </Button>
      </div>
    </Alert>
  );
}
