import Link from "next/link";

import { DataSource } from "@/components/data-source.tsx";
import { Card, CardContent, CardFooter } from "@/components/ui/card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.tsx";

import type { Quote } from "../../../permissions.ts";

import { visibleQuotes } from "../quote-queries.ts";
import { customerName, money } from "./format.ts";
import { NoQuotes } from "./no-quotes.tsx";
import { StatusBadge } from "./status-badge.tsx";

type QuoteHref =
  | `/${string}/quotes/${string}`
  | `/portal/${string}/quotes/${string}`;

function QuoteRow(props: { readonly quote: Quote; readonly href: QuoteHref }) {
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

/**
 * Links use `prefetch={true}`: the prefetch resolves the quote's params and its
 * private access check.
 */
export async function QuoteList(props: {
  readonly organization: string;
  readonly prefix: "" | "/portal";
}) {
  const { organization, prefix } = props;
  const loaded = await visibleQuotes(organization);
  const quotes = loaded.value;
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
              href={`${prefix}/${organization}/quotes/${quote.id}`}
            />
          ))}
        </TableBody>
      </Table>
      <CardFooter className="border-t px-4 py-3">
        <DataSource name="Quotes" loaded={loaded} />
      </CardFooter>
    </Card>
  );
}

/**
 * The list's rows while the private read runs; the card around the rows is the
 * page's.
 */
export function QuoteListSkeleton() {
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
