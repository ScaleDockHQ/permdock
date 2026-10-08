import { FileText } from "lucide-react";

import { Card, CardContent, CardHeader } from "@/components/ui/card.tsx";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";

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

export function NoQuotes() {
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
