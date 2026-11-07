import { Protected } from "permdock/react";
import { Suspense } from "react";

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
    <section>
      <h1 data-testid="page-title">Staff</h1>
      <Protected
        permission={permissions.staff.list}
        pending={<StaffListSkeleton />}
        denied={<p>Only staff can see the staff list.</p>}
      >
        <Suspense fallback={<StaffListSkeleton />}>
          {props.params.then(({ orgSlug }) => (
            <StaffList orgSlug={orgSlug} />
          ))}
        </Suspense>
      </Protected>
    </section>
  );
}
