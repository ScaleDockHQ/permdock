import type { Project } from "../project/project.ts";
import type { DoctorFinding } from "../shared/doctor-types.ts";

import {
  mostPrivilegedRole,
  snapshotSize,
  SNAPSHOT_BUDGET_BYTES,
} from "../snapshot-size.ts";

/** Memberships of the probe subject: a tenant admin with a handful of tenants. */
const PROBE_TENANTS = 3;

/**
 * PD112: the compact snapshot of the most privileged role is over 64 KB of
 * JSON. A Next.js page that renders `PermDockProvider` serialises it into the
 * Flight stream once per provider, so the size is paid on every navigation.
 */
export async function pd112(
  project: Pick<Project, "policy">,
): Promise<readonly DoctorFinding[]> {
  const policy = await project.policy();
  if (policy === undefined) {
    return [];
  }
  const role = mostPrivilegedRole(policy);
  if (role === undefined) {
    return [];
  }
  const report = snapshotSize({
    policy,
    role,
    tenants: PROBE_TENANTS,
    omitAssignable: false,
  });
  if (
    typeof report === "string" ||
    report.total.bytes <= SNAPSHOT_BUDGET_BYTES
  ) {
    return [];
  }
  return [
    {
      code: "PD112",
      severity: "warning",
      target: role,
      message: `the snapshot of role '${role}' is ${String(report.total.bytes)} bytes (${String(report.total.gzip)} gzip), over ${String(SNAPSHOT_BUDGET_BYTES)}; the largest part is ${report.largest}`,
      fix: "pass omitStatic with the generated bundle (`permdock gen --kind bundle`), omitAssignable when the page has no role editor, or narrow the role's grants; `permdock snapshot size` lists the parts",
    },
  ];
}
