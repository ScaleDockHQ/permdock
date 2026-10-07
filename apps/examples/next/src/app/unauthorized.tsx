import { LogIn } from "lucide-react";
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

export default function Unauthorized() {
  return (
    <main
      data-testid="unauthorized"
      className="flex min-h-svh items-center justify-center px-4"
    >
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LogIn />
          </EmptyMedia>
          <EmptyTitle>
            <h1>Sign in to continue</h1>
          </EmptyTitle>
          <EmptyDescription>
            This page needs a signed-in account.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Link href="/" className={buttonVariants()}>
            Choose a demo account
          </Link>
        </EmptyContent>
      </Empty>
    </main>
  );
}
