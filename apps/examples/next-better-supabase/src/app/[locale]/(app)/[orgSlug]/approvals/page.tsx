import { notFound } from "next/navigation";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";

import { pendingApprovals } from "../../../../../features/approval/approval-queries.ts";
import { organizationBySlug } from "../../../../../features/organization/organization-queries.ts";
import { OrgFrame } from "../../../../../features/shell/org-frame.tsx";

export const instant = true;

async function ApprovalsBody(props: { readonly orgSlug: string }) {
  const organization = await organizationBySlug(props.orgSlug);
  if (organization === null) {
    notFound();
  }
  const items = await pendingApprovals(organization.id);
  return (
    <OrgFrame title="Approvals">
      <ul data-testid="approvals">
        {items.map((item) => (
          <li key={item.id} data-approval={item.id}>
            {item.status}
          </li>
        ))}
      </ul>
    </OrgFrame>
  );
}

export default function ApprovalsPage(
  props: PageProps<"/[locale]/[orgSlug]/approvals">,
) {
  return (
    <Suspense fallback={<Skeleton className="h-24 w-full" />}>
      {props.params.then(({ orgSlug }) => (
        <ApprovalsBody orgSlug={orgSlug} />
      ))}
    </Suspense>
  );
}
