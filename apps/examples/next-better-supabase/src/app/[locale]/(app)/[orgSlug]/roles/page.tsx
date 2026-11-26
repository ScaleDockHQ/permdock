import { notFound } from "next/navigation";
import { customRoleRecord, fromSnapshot } from "permdock";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";

import {
  loadSnapshot,
  organizationBySlug,
} from "../../../../../features/organization/organization-queries.ts";
import { RolePanel } from "../../../../../features/role/components/role-panel.tsx";
import { OrgFrame } from "../../../../../features/shell/org-frame.tsx";
import { compiledRoles } from "../../../../../permdock/request.ts";
import { appPolicy } from "../../../../../policy.ts";

export const instant = true;

async function RolesBody(props: { readonly orgSlug: string }) {
  const organization = await organizationBySlug(props.orgSlug);
  if (organization === null) {
    notFound();
  }
  const roles = await compiledRoles.rolesFor(organization.id);
  const record = customRoleRecord(appPolicy, roles, organization.id);
  const snapshot = await loadSnapshot(organization.id);
  const merged = fromSnapshot(snapshot, {
    tenant: organization.id,
    customRoles: [record],
  });
  return (
    <OrgFrame title="Roles">
      <p className="text-sm" data-testid="merged-roles">
        {merged.assignableRoles().length}
      </p>
      <RolePanel organizationId={organization.id} />
    </OrgFrame>
  );
}

export default function RolesPage(
  props: PageProps<"/[locale]/[orgSlug]/roles">,
) {
  return (
    <Suspense fallback={<Skeleton className="h-24 w-full" />}>
      {props.params.then(({ orgSlug }) => (
        <RolesBody orgSlug={orgSlug} />
      ))}
    </Suspense>
  );
}
