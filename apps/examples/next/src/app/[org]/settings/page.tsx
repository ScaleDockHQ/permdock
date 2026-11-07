import { Suspense } from "react";

import { PageHeader } from "@/components/page-header.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";

import { organizations } from "../../../lib/store.ts";
import { requirePermission } from "../../../permdock/server.ts";
import { permissions } from "../../../permissions.ts";

// A rarely visited admin page: never prefetched, and allowed to block, because
// it checks access at request time before rendering anything.
export const prefetch = "force-disabled";
export const instant = false;

/**
 * Control flow only: it renders nothing, and a denial throws `forbidden()` or
 * `unauthorized()`.
 */
async function RequireAdmin(props: { readonly organization: string }) {
  await requirePermission(permissions.member.manage, undefined, {
    tenant: props.organization,
  });
  return null;
}

function OrganizationCard(props: { readonly organization: string }) {
  const org = props.organization;
  const organization = organizations.find((item) => item.id === org);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Organization</CardTitle>
        <CardDescription>
          This page is never prefetched and checks access with requirePermission
          before it renders.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground text-xs font-medium">Name</dt>
            <dd className="text-sm font-medium">{organization?.name ?? org}</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="text-muted-foreground text-xs font-medium">
              Tenant
            </dt>
            <dd className="font-mono text-sm">{org}</dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

export default function Settings(props: PageProps<"/[org]/settings">) {
  return (
    <div data-testid="settings" className="flex flex-col gap-6">
      <PageHeader
        title="Settings"
        description="Only organization admins reach this page."
      />
      <Suspense fallback={<Skeleton className="h-40 w-full" />}>
        {props.params.then(({ org }) => (
          <>
            <RequireAdmin organization={org} />
            <OrganizationCard organization={org} />
          </>
        ))}
      </Suspense>
    </div>
  );
}
