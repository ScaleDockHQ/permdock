import { Suspense } from "react";

import {
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/reui/frame";
import { Skeleton } from "@/components/ui/skeleton";

import { BillingGate } from "../../../../../features/billing/components/billing-gate.tsx";

export const instant = true;

export default function BillingPage(
  _props: PageProps<"/[locale]/[orgSlug]/billing">,
) {
  return (
    <Suspense fallback={<Skeleton className="h-24 w-full" />}>
      <Frame spacing="sm">
        <FramePanel>
          <FrameHeader>
            <FrameTitle data-testid="page-title">Billing</FrameTitle>
          </FrameHeader>
          <BillingGate />
        </FramePanel>
      </Frame>
    </Suspense>
  );
}
