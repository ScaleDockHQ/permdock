import { notFound } from "next/navigation";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";

import { organizationBySlug } from "../../../../../features/organization/organization-queries.ts";
import { OrgFrame } from "../../../../../features/shell/org-frame.tsx";
import { SupportPanel } from "../../../../../features/support/components/support-panel.tsx";

export const instant = true;

const target = "00000000-0000-4000-8000-0000000000a1";

async function SupportBody(props: { readonly orgSlug: string }) {
  const organization = await organizationBySlug(props.orgSlug);
  if (organization === null) {
    notFound();
  }
  return (
    <OrgFrame title="Support">
      <p className="text-sm">Read-only. The actor cannot change records.</p>
      <SupportPanel organizationId={organization.id} principal={target} />
    </OrgFrame>
  );
}

export default function SupportPage(
  props: PageProps<"/[locale]/[orgSlug]/support">,
) {
  return (
    <Suspense fallback={<Skeleton className="h-24 w-full" />}>
      {props.params.then(({ orgSlug }) => (
        <SupportBody orgSlug={orgSlug} />
      ))}
    </Suspense>
  );
}
