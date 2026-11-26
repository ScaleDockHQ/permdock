import { notFound } from "next/navigation";
import { whoCan } from "permdock";

import { Badge } from "@/components/reui/badge";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/reui/frame";

import { getPermDock } from "../../../permdock/server.ts";
import { permissions } from "../../../policy.ts";
import { organizationBySlug } from "../../organization/organization-queries.ts";
import { quoteById } from "../quote-store.ts";
import { QuoteActions } from "./quote-actions.tsx";

/** One quote, who may read it, and the writes the caller may run. */
export async function QuoteDetail(props: {
  readonly orgSlug: string;
  readonly id: string;
}) {
  const organization = await organizationBySlug(props.orgSlug);
  const quote = organization === null ? null : await quoteById(props.id);
  if (
    organization === null ||
    quote === null ||
    quote.organization_id !== organization.id
  ) {
    notFound();
  }
  const holders = await whoCan(
    await getPermDock({ tenant: organization.id, intent: "read" }),
    permissions.quotes.read,
    quote,
  );
  return (
    <Frame spacing="sm">
      <FramePanel>
        <FrameHeader>
          <FrameTitle data-testid="page-title">{quote.title}</FrameTitle>
          <FrameDescription>
            {holders.holders.length} people can read this quote.
          </FrameDescription>
        </FrameHeader>
        <Badge variant="outline" size="sm">
          {quote.status}
        </Badge>
        <QuoteActions quote={quote} />
      </FramePanel>
    </Frame>
  );
}
