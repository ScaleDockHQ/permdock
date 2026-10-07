import { Check } from "lucide-react";
import { notFound } from "next/navigation";

import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";

import type { Quote } from "../../permissions.ts";

import { approveQuote } from "../../app/actions.ts";
import { quoteAccess } from "../../lib/access.ts";
import { customerName, money } from "./format.ts";
import { StatusBadge } from "./status-badge.tsx";

export function QuoteSkeleton() {
  return (
    <Card aria-busy="true" data-testid="quote-skeleton">
      <CardHeader>
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-4 w-40" />
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-3">
        {["a", "b", "c"].map((cell) => (
          <div key={cell} className="flex flex-col gap-2">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-5 w-28" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

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
  const access = await quoteAccess(org, id);
  const quote = access.quote;
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
      <CardContent>
        <Facts quote={quote} />
      </CardContent>
      <CardFooter
        data-testid="quote-actions"
        className="justify-end gap-2 border-t empty:hidden"
      >
        {access.approve ? (
          <form action={approveQuote.bind(null, org, quote.id)}>
            <Button type="submit" data-action="approve">
              <Check data-icon="inline-start" />
              Approve quote
            </Button>
          </form>
        ) : null}
      </CardFooter>
    </Card>
  );
}
