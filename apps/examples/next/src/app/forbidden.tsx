import { ShieldAlert } from "lucide-react";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button.tsx";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty.tsx";

export default function Forbidden() {
  return (
    <main
      data-testid="forbidden"
      className="flex min-h-svh items-center justify-center px-4"
    >
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldAlert />
          </EmptyMedia>
          <EmptyTitle>
            <h1>You do not have access to this page</h1>
          </EmptyTitle>
          <EmptyDescription>
            Ask an organization admin for the role that grants it.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Link href="/" className={buttonVariants({ variant: "outline" })}>
            Back to the start page
          </Link>
        </EmptyContent>
      </Empty>
    </main>
  );
}
