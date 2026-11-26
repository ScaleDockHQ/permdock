import { Suspense } from "react";

import { Skeleton } from "@/components/ui/skeleton";

import { AccessPanel } from "../../../../../features/access/components/access-panel.tsx";
import { snapshotForSlug } from "../../../../../features/organization/organization-queries.ts";
import { OrgFrame } from "../../../../../features/shell/org-frame.tsx";
import { PermDockProvider } from "../../../../../permdock/server.ts";
import { permissions } from "../../../../../permissions.ts";

export const instant = true;

export default function AccessPage(
  props: PageProps<"/[locale]/[orgSlug]/access">,
) {
  const snapshot = props.params
    .then(({ orgSlug }) => orgSlug)
    .then(snapshotForSlug);
  return (
    <OrgFrame title="Access">
      <ul data-testid="access-hooks">
        <AccessPanel label="snapshot" />
        <PermDockProvider include={[permissions.quotes.list]} evaluator="lazy">
          <AccessPanel label="include" />
        </PermDockProvider>
        <Suspense fallback={<Skeleton className="h-8 w-full" />}>
          <PermDockProvider snapshot={snapshot} suspend>
            <AccessPanel label="suspend" />
          </PermDockProvider>
        </Suspense>
        <PermDockProvider omitStatic>
          <AccessPanel label="omit-static" />
        </PermDockProvider>
      </ul>
    </OrgFrame>
  );
}
