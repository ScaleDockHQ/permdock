import { notFound } from "next/navigation";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";

import { ReviewPanel } from "../../../../../features/access-review/components/review-panel.tsx";
import { organizationBySlug } from "../../../../../features/organization/organization-queries.ts";
import { OrgFrame } from "../../../../../features/shell/org-frame.tsx";

export const instant = true;

async function ReviewsBody(props: { readonly orgSlug: string }) {
  const organization = await organizationBySlug(props.orgSlug);
  if (organization === null) {
    notFound();
  }
  return (
    <OrgFrame title="Access reviews">
      <p className="text-sm" data-testid="access-reviews">
        Reviews apply through the approvals store.
      </p>
      <ReviewPanel organizationId={organization.id} />
    </OrgFrame>
  );
}

export default function AccessReviewsPage(
  props: PageProps<"/[locale]/[orgSlug]/access-reviews">,
) {
  return (
    <Suspense fallback={<Skeleton className="h-24 w-full" />}>
      {props.params.then(({ orgSlug }) => (
        <ReviewsBody orgSlug={orgSlug} />
      ))}
    </Suspense>
  );
}
