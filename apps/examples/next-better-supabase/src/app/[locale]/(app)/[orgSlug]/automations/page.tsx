import { notFound } from "next/navigation";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";

import { AutomationPanel } from "../../../../../features/automation/components/automation-panel.tsx";
import { organizationBySlug } from "../../../../../features/organization/organization-queries.ts";
import { OrgFrame } from "../../../../../features/shell/org-frame.tsx";

export const instant = true;

async function AutomationsBody(props: { readonly orgSlug: string }) {
  const organization = await organizationBySlug(props.orgSlug);
  if (organization === null) {
    notFound();
  }
  return (
    <OrgFrame title="Automations">
      <AutomationPanel organizationId={organization.id} />
    </OrgFrame>
  );
}

export default function AutomationsPage(
  props: PageProps<"/[locale]/[orgSlug]/automations">,
) {
  return (
    <Suspense fallback={<Skeleton className="h-24 w-full" />}>
      {props.params.then(({ orgSlug }) => (
        <AutomationsBody orgSlug={orgSlug} />
      ))}
    </Suspense>
  );
}
