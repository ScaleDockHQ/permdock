import { Check } from "lucide-react";
import { notFound } from "next/navigation";

import { DataSource } from "@/components/data-source.tsx";
import { SubmitButton } from "@/components/submit-button.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";

import type { Quote } from "../../permissions.ts";

import { approveQuote } from "../../app/actions.ts";
import { quoteAccess } from "../../lib/access.ts";
import { customerName, money } from "./format.ts";
import { StatusBadge } from "./status-badge.tsx";

function Facts(props: { readonly quote: Quote }) {
  const facts = [
    { label: "Customer", value: customerName(props.quote) },
    { label: "Total", value: money.format(props.quote.total) },
    { label: "Reference", value: props.quote.id },
  ];
  return (
    <dl className="grid gap-4 sm:grid-cols-3">
      {facts.map((fact) => (
        <div key={fact.label} className="flex flex-col gap-1">
          <dt className="text-muted-foreground text-xs font-medium">
            {fact.label}
          </dt>
          <dd className="text-sm font-medium tabular-nums">{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export async function QuoteView(props: {
  readonly params: Promise<{ readonly org: string; readonly id: string }>;
}) {
  const { org, id } = await props.params;
  const loaded = await quoteAccess(org, id);
  const { quote, approve } = loaded.value;
  if (quote === null) {
    notFound();
  }
  return (
    <Card data-testid="quote" data-quote={quote.id}>
      <CardHeader>
        <CardTitle className="text-lg">
          <h2>{quote.title}</h2>
        </CardTitle>
        <CardDescription>Quote for {customerName(quote)}</CardDescription>
        <CardAction>
          <StatusBadge status={quote.status} testId="quote-status" />
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Facts quote={quote} />
        <DataSource name="Quote" loaded={loaded} />
      </CardContent>
      <CardFooter
        data-testid="quote-actions"
        className="justify-end gap-2 border-t empty:hidden"
      >
        {approve ? (
          <form action={approveQuote.bind(null, org, quote.id)}>
            <SubmitButton
              data-action="approve"
              icon={<Check data-icon="inline-start" />}
            >
              Approve quote
            </SubmitButton>
          </form>
        ) : null}
      </CardFooter>
    </Card>
  );
}
