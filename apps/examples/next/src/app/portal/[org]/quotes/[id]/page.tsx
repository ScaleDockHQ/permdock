import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";

import { QuoteSkeleton, QuoteView } from "@/components/quotes/quote-view.tsx";
import { buttonVariants } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";

export const instant = true;

async function Back(props: {
  readonly params: Promise<{ readonly org: string }>;
}) {
  const { org } = await props.params;
  return (
    <Link
      href={`/portal/${org}`}
      prefetch
      className={buttonVariants({
        variant: "ghost",
        size: "sm",
        className: "-ml-2.5 self-start",
      })}
    >
      <ArrowLeft data-icon="inline-start" />
      All quotes
    </Link>
  );
}

export default function PortalQuote(props: {
  readonly params: Promise<{ readonly org: string; readonly id: string }>;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Suspense fallback={<Skeleton className="h-8 w-28" />}>
        <Back params={props.params} />
      </Suspense>
      <Suspense fallback={<QuoteSkeleton />}>
        <QuoteView params={props.params} />
      </Suspense>
    </div>
  );
}
