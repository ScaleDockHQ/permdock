import Link from "next/link";

import { DataSource } from "@/components/data-source.tsx";
import { Card, CardFooter } from "@/components/ui/card.tsx";
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
import { NoQuotes } from "./quote-states.tsx";
import { StatusBadge } from "./status-badge.tsx";

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
  const loaded = await visibleQuotes(org);
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
              href={`${props.prefix}/${org}/quotes/${quote.id}`}
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
