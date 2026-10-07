import { PageHeader } from "@/components/page-header.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";

import { organizations } from "../../../lib/store.ts";
import { requireAccess } from "../../../permdock/server.ts";
import { permissions } from "../../../permissions.ts";

// A rarely visited admin page: never prefetched, and allowed to block, because
// it checks access at request time before rendering anything.
export const prefetch = "force-disabled";
export const instant = false;

export default async function Settings(props: {
  readonly params: Promise<{ readonly org: string }>;
}) {
  const { org } = await props.params;
  await requireAccess({ permission: permissions.member.manage, tenant: org });
  const organization = organizations.find((item) => item.id === org);
  return (
    <div data-testid="settings" className="flex flex-col gap-6">
      <PageHeader
        title="Settings"
        description="Only organization admins reach this page."
      />
      <Card>
        <CardHeader>
          <CardTitle>Organization</CardTitle>
          <CardDescription>
            This page is never prefetched and checks access with requireAccess
            before it renders.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <dt className="text-muted-foreground text-xs font-medium">
                Name
              </dt>
              <dd className="text-sm font-medium">
                {organization?.name ?? org}
              </dd>
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
    </div>
  );
}
