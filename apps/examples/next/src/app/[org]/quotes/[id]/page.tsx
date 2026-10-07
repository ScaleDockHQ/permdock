import { ShieldAlert } from "lucide-react";
import { PermissionBoundary } from "permdock/next/client";
import { Suspense } from "react";

import { PageHeader } from "@/components/page-header.tsx";
import { QuoteSkeleton, QuoteView } from "@/components/quotes/quote-view.tsx";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.tsx";

import { ApprovalNotice } from "./approval-notice.tsx";
import { DeleteZone } from "./delete-zone.tsx";

export const instant = true;

export default function QuotePage(props: {
  readonly params: Promise<{ readonly org: string; readonly id: string }>;
}) {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Quote"
        description="The approve button and the delete zone each come from their own access check."
      />
      <Suspense fallback={<QuoteSkeleton />}>
        <QuoteView params={props.params} />
      </Suspense>
      <PermissionBoundary
        denied={
          <Alert data-testid="delete-denied">
            <ShieldAlert />
            <AlertTitle>Deleting is not available</AlertTitle>
            <AlertDescription>Only staff can delete quotes.</AlertDescription>
          </Alert>
        }
        approval={<ApprovalNotice />}
      >
        <Suspense fallback={null}>
          <DeleteZone params={props.params} />
        </Suspense>
      </PermissionBoundary>
    </div>
  );
}
