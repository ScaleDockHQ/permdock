import { Protected } from "permdock/react";
import { Suspense } from "react";

import { Alert, AlertDescription } from "@/components/reui/alert";
import {
  Frame,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@/components/reui/frame";

import {
  StaffList,
  StaffListSkeleton,
} from "../../../../../features/staff/components/staff-list.tsx";
import { permissions } from "../../../../../policy.ts";

export const instant = true;

export default function StaffPage(
  props: PageProps<"/[locale]/[orgSlug]/staff">,
) {
  return (
    <Frame spacing="sm">
      <FramePanel>
        <FrameHeader>
          <FrameTitle data-testid="page-title">Staff</FrameTitle>
        </FrameHeader>
        <Protected
          permission={permissions.staff.list}
          pending={<StaffListSkeleton />}
          denied={
            <Alert variant="warning">
              <AlertDescription>
                Only staff can see the staff list.
              </AlertDescription>
            </Alert>
          }
        >
          <Suspense fallback={<StaffListSkeleton />}>
            {props.params.then(({ orgSlug }) => (
              <StaffList orgSlug={orgSlug} />
            ))}
          </Suspense>
        </Protected>
      </FramePanel>
    </Frame>
  );
}
