import { notFound } from "next/navigation";
import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";

import { organizationBySlug } from "../../../../../features/organization/organization-queries.ts";
import { OrgFrame } from "../../../../../features/shell/org-frame.tsx";
import { TeamPanel } from "../../../../../features/team/components/team-panel.tsx";
import { teamsOf } from "../../../../../features/team/team-queries.ts";

export const instant = true;

async function TeamsBody(props: { readonly orgSlug: string }) {
  const organization = await organizationBySlug(props.orgSlug);
  if (organization === null) {
    notFound();
  }
  const teams = await teamsOf(organization.id);
  return (
    <OrgFrame title="Teams">
      <TeamPanel teams={teams} />
    </OrgFrame>
  );
}

export default function TeamsPage(
  props: PageProps<"/[locale]/[orgSlug]/teams">,
) {
  return (
    <Suspense fallback={<Skeleton className="h-24 w-full" />}>
      {props.params.then(({ orgSlug }) => (
        <TeamsBody orgSlug={orgSlug} />
      ))}
    </Suspense>
  );
}
