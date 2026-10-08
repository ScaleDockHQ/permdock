"use client";

import type { PermissionBoundaryState } from "permdock/next/client";
import type { ReactNode } from "react";

import { ShieldAlert } from "lucide-react";
import { PermissionBoundary } from "permdock/next/client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";

import { ApprovalNotice } from "./approval-notice.tsx";

function approval(state: PermissionBoundaryState) {
  return <ApprovalNotice state={state} />;
}

/** A Client Component, so the approval fallback can be a function of the boundary state. */
export function DeleteBoundary(props: { readonly children: ReactNode }) {
  return (
    <PermissionBoundary
      denied={
        <Alert data-testid="delete-denied">
          <ShieldAlert />
          <AlertTitle>Deleting is not available</AlertTitle>
          <AlertDescription>Only staff can delete quotes.</AlertDescription>
        </Alert>
      }
      approval={approval}
    >
      {props.children}
    </PermissionBoundary>
  );
}
