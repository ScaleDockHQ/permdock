import { FileText } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty.tsx";

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
