import { notFound } from "next/navigation";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";

import { DeveloperPanel } from "../../../../../features/developer/components/developer-panel.tsx";
import { organizationBySlug } from "../../../../../features/organization/organization-queries.ts";
import { OrgFrame } from "../../../../../features/shell/org-frame.tsx";

export const instant = true;

async function DevelopersBody(props: { readonly orgSlug: string }) {
  const organization = await organizationBySlug(props.orgSlug);
  if (organization === null) {
    notFound();
  }
  return (
    <OrgFrame title="Developers">
      <DeveloperPanel organizationId={organization.id} />
    </OrgFrame>
  );
}

export default function DevelopersPage(
  props: PageProps<"/[locale]/[orgSlug]/developers">,
) {
  return (
    <Suspense fallback={<Skeleton className="h-24 w-full" />}>
      {props.params.then(({ orgSlug }) => (
        <DevelopersBody orgSlug={orgSlug} />
      ))}
    </Suspense>
  );
}
