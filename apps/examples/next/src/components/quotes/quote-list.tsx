import { FileText } from "lucide-react";
import Link from "next/link";

import { Card, CardContent } from "@/components/ui/card.tsx";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.tsx";

import type { Quote } from "../../permissions.ts";

import { visibleQuotes } from "../../lib/access.ts";
import { customerName, money } from "./format.ts";
import { StatusBadge } from "./status-badge.tsx";

export function ListSkeleton() {
  return (
    <Card aria-busy="true" data-testid="quotes-skeleton" className="py-2">
      <CardContent className="flex flex-col divide-y px-4">
        {["a", "b", "c"].map((row) => (
          <div key={row} className="flex items-center gap-4 py-3">
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="hidden h-4 w-28 sm:block" />
            <Skeleton className="h-5 w-16 rounded-4xl" />
            <Skeleton className="h-4 w-14" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function NoQuotes() {
  return (
    <Empty data-testid="quotes-empty" className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FileText />
        </EmptyMedia>
        <EmptyTitle>No quotes yet</EmptyTitle>
        <EmptyDescription>Quotes you may read show up here.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function QuoteRow(props: { readonly quote: Quote; readonly href: string }) {
  const { quote } = props;
  return (
    <TableRow className="relative">
      <TableCell className="pl-4 whitespace-normal">
        <Link
          href={props.href}
          prefetch={true}
          data-quote={quote.id}
          className="font-medium after:absolute after:inset-0 hover:underline"
        >
          {quote.title}
        </Link>
        <div className="text-muted-foreground font-mono text-xs">
          {quote.id}
          <span className="font-sans sm:hidden"> · {customerName(quote)}</span>
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground hidden sm:table-cell">
        {customerName(quote)}
      </TableCell>
      <TableCell>
        <StatusBadge status={quote.status} />
      </TableCell>
      <TableCell className="pr-4 text-right font-medium tabular-nums">
        {money.format(quote.total)}
      </TableCell>
    </TableRow>
  );
}

/** Links use `prefetch={true}`: the prefetch resolves the quote's params and its private access check. */
export async function QuoteList(props: {
  readonly params: Promise<{ readonly org: string }>;
  readonly prefix: "" | "/portal";
}) {
  const { org } = await props.params;
  const quotes = await visibleQuotes(org);
  if (quotes.length === 0) {
    return <NoQuotes />;
  }
  return (
    <Card className="py-0">
      <Table data-testid="quotes">
        <TableHeader>
          <TableRow>
            <TableHead className="pl-4">Quote</TableHead>
            <TableHead className="hidden sm:table-cell">Customer</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="pr-4 text-right">Total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {quotes.map((quote) => (
            <QuoteRow
              key={quote.id}
              quote={quote}
              href={`${props.prefix}/${org}/quotes/${quote.id}`}
            />
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
