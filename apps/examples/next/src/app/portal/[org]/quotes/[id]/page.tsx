import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";

import { buttonVariants } from "@/components/ui/button.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";

import {
  QuoteView,
  QuoteViewSkeleton,
} from "../../../../../features/quote/components/quote-view.tsx";

export const instant = true;

function Back(props: { readonly organization: string }) {
  return (
    <Link
      href={`/portal/${props.organization}`}
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

export default function PortalQuote(
  props: PageProps<"/portal/[org]/quotes/[id]">,
) {
  return (
    <div className="flex flex-col gap-4">
      <Suspense fallback={<Skeleton className="h-8 w-28" />}>
        {props.params.then(({ org }) => (
          <Back organization={org} />
        ))}
      </Suspense>
      <Suspense fallback={<QuoteViewSkeleton />}>
        {props.params.then(({ org, id }) => (
          <QuoteView organization={org} id={id} />
        ))}
      </Suspense>
    </div>
  );
}
