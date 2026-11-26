import { notFound } from "next/navigation";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";

import { recentAudit } from "../../../../../features/audit/audit-queries.ts";
import { AuditPanel } from "../../../../../features/audit/components/audit-panel.tsx";
import { organizationBySlug } from "../../../../../features/organization/organization-queries.ts";
import { OrgFrame } from "../../../../../features/shell/org-frame.tsx";

export const instant = true;

async function AuditBody(props: { readonly orgSlug: string }) {
  const organization = await organizationBySlug(props.orgSlug);
  if (organization === null) {
    notFound();
  }
  const rows = await recentAudit(organization.id);
  return (
    <OrgFrame title="Audit">
      <AuditPanel organizationId={organization.id} rows={rows} />
    </OrgFrame>
  );
}

export default function AuditPage(
  props: PageProps<"/[locale]/[orgSlug]/audit">,
) {
  return (
    <Suspense fallback={<Skeleton className="h-24 w-full" />}>
      {props.params.then(({ orgSlug }) => (
        <AuditBody orgSlug={orgSlug} />
      ))}
    </Suspense>
  );
}
