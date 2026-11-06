import { prefetch } from "next/cache";
import { notFound } from "next/navigation";

import { DataSource } from "../../../components/data-source.tsx";
import { organizationBySlug } from "../../organization/organization-queries.ts";
import { visibleStaff } from "../staff-queries.ts";

/**
 * `prefetch()` keeps the RLS read out of the App Shell every link loads; the
 * Staff link's own prefetch still carries the rows.
 */
export async function StaffList(props: { readonly orgSlug: string }) {
  await prefetch();
  const organization = await organizationBySlug(props.orgSlug);
  if (organization === null) {
    notFound();
  }
  const staff = await visibleStaff(organization.id);
  return (
    <>
      <ul data-testid="staff">
        {staff.value.map((row) => (
          <li key={row.id} data-staff={row.id}>
            {row.name}, {row.title}
          </li>
        ))}
      </ul>
      <DataSource name="Staff" loaded={staff} />
    </>
  );
}

export function StaffListSkeleton() {
  return (
    <ul aria-busy="true" data-testid="staff-skeleton">
      <li>&nbsp;</li>
      <li>&nbsp;</li>
    </ul>
  );
}
