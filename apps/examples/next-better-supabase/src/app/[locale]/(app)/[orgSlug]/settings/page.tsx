import { notFound } from "next/navigation";
import { Suspense } from "react";

import {
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/reui/frame";
import { Skeleton } from "@/components/ui/skeleton";

import { organizationBySlug } from "../../../../../features/organization/organization-queries.ts";
import { requirePermission } from "../../../../../permdock/server.ts";
import { permissions } from "../../../../../policy.ts";

export const prefetch = "force-disabled";
export const instant = false;

async function SettingsBody(props: { readonly orgSlug: string }) {
  const organization = await organizationBySlug(props.orgSlug);
  if (organization === null) {
    notFound();
  }
  await requirePermission(permissions.settings.read, undefined, {
    tenant: organization.id,
  });
  return (
    <Frame spacing="sm">
      <FramePanel>
        <FrameHeader>
          <FrameTitle data-testid="page-title">Settings</FrameTitle>
        </FrameHeader>
        <p className="text-sm">{organization.name}</p>
      </FramePanel>
    </Frame>
  );
}

export default function SettingsPage(
  props: PageProps<"/[locale]/[orgSlug]/settings">,
) {
  return (
    <Suspense fallback={<Skeleton className="h-24 w-full" />}>
      {props.params.then(({ orgSlug }) => (
        <SettingsBody orgSlug={orgSlug} />
      ))}
    </Suspense>
  );
}
