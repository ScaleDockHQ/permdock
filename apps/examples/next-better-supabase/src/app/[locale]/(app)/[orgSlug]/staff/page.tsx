import { notFound } from "next/navigation";
import { Protected } from "permdock/react";
import { Suspense } from "react";

import { organizationBySlug, visibleStaff } from "../../../../../lib/access.ts";
import { permissions } from "../../../../../policy.ts";

export const instant = true;

function StaffSkeleton() {
  return (
    <ul aria-busy="true" data-testid="staff-skeleton">
      <li>&nbsp;</li>
      <li>&nbsp;</li>
    </ul>
  );
}

async function StaffList(props: {
  readonly params: Promise<{ readonly orgSlug: string }>;
}) {
  const { orgSlug } = await props.params;
  const organization = await organizationBySlug(orgSlug);
  if (organization === null) {
    notFound();
  }
  const staff = await visibleStaff(organization.id);
  return (
    <ul data-testid="staff">
      {staff.map((row) => (
        <li key={row.id} data-staff={row.id}>
          {row.name}, {row.title}
        </li>
      ))}
    </ul>
  );
}

export default function StaffPage(props: {
  readonly params: Promise<{ readonly orgSlug: string }>;
}) {
  return (
    <section>
      <h1 data-testid="page-title">Staff</h1>
      <Protected
        permission={permissions.staff.list}
        pending={<StaffSkeleton />}
        fallback={<p>Only staff can see the staff list.</p>}
      >
        <Suspense fallback={<StaffSkeleton />}>
          <StaffList params={props.params} />
        </Suspense>
      </Protected>
    </section>
  );
}
