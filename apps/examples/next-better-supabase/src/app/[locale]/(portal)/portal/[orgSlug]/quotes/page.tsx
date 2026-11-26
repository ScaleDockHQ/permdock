import { Protected } from "permdock/react";
import { Suspense } from "react";

import { Alert, AlertDescription } from "@/components/reui/alert";
import {
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/reui/frame";

import {
  QuoteList,
  QuoteListSkeleton,
} from "../../../../../../features/quote/components/quote-list.tsx";
import { permissions } from "../../../../../../policy.ts";

export const instant = true;

export default function PortalQuotes(
  props: PageProps<"/[locale]/portal/[orgSlug]/quotes">,
) {
  return (
    <Frame spacing="sm">
      <FramePanel>
        <FrameHeader>
          <FrameTitle data-testid="page-title">Your quotes</FrameTitle>
        </FrameHeader>
        <Protected
          permission={permissions.quotes.list}
          pending={<QuoteListSkeleton />}
          denied={
            <Alert variant="warning">
              <AlertDescription>
                Sign in as a customer contact to see quotes.
              </AlertDescription>
            </Alert>
          }
        >
          <Suspense fallback={<QuoteListSkeleton />}>
            {props.params.then(({ orgSlug }) => (
              <QuoteList orgSlug={orgSlug} />
            ))}
          </Suspense>
        </Protected>
      </FramePanel>
    </Frame>
  );
}
