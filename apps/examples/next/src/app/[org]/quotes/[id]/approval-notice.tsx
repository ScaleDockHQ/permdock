"use client";

import { usePermissionBoundary } from "permdock/next/client";

export function ApprovalNotice() {
  const state = usePermissionBoundary();
  if (state?.outcome !== "approval-required") {
    return null;
  }
  return (
    <div data-testid="delete-approval" data-permission={state.permission}>
      <p>Deleting a quote needs an admin&apos;s approval.</p>
      <button
        type="button"
        data-testid="delete-retry"
        onClick={() => {
          state.retry();
        }}
      >
        I have approval, try again
      </button>
    </div>
  );
}
