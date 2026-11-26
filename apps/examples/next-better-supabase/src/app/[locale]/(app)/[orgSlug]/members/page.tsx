import { notFound } from "next/navigation";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";

import { MemberPanel } from "../../../../../features/member/components/member-panel.tsx";
import { membersOf } from "../../../../../features/member/member-queries.ts";
import { organizationBySlug } from "../../../../../features/organization/organization-queries.ts";
import { OrgFrame } from "../../../../../features/shell/org-frame.tsx";

export const instant = true;

async function MembersBody(props: { readonly orgSlug: string }) {
  const organization = await organizationBySlug(props.orgSlug);
  if (organization === null) {
    notFound();
  }
  const members = await membersOf(organization.id);
  return (
    <OrgFrame title="Members">
      <MemberPanel organizationId={organization.id} members={members} />
    </OrgFrame>
  );
}

export default function MembersPage(
  props: PageProps<"/[locale]/[orgSlug]/members">,
) {
  return (
    <Suspense fallback={<Skeleton className="h-24 w-full" />}>
      {props.params.then(({ orgSlug }) => (
        <MembersBody orgSlug={orgSlug} />
      ))}
    </Suspense>
  );
}
