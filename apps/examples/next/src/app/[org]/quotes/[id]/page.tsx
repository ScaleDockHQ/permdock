import { PermissionBoundary } from "permdock/next/client";
import { Suspense } from "react";

import { QuoteSkeleton, QuoteView } from "../../../quotes.tsx";
import { ApprovalNotice } from "./approval-notice.tsx";
import { DeleteZone } from "./delete-zone.tsx";

export const instant = true;

export default function QuotePage(props: {
  readonly params: Promise<{ readonly org: string; readonly id: string }>;
}) {
  return (
    <section>
      <h1>Quote</h1>
      <Suspense fallback={<QuoteSkeleton />}>
        <QuoteView params={props.params} />
      </Suspense>
      <PermissionBoundary
        denied={
          <p data-testid="delete-denied">Only staff can delete quotes.</p>
        }
        approval={<ApprovalNotice />}
      >
        <Suspense fallback={null}>
          <DeleteZone params={props.params} />
        </Suspense>
      </PermissionBoundary>
    </section>
  );
}
