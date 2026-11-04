import type { Membership } from "./subject.ts";

/** What `permdock.memberships()` narrows to. */
export type MembershipFilter = {
  /** An open `MembershipVia`: `"staff"` matches the memberships written with it. */
  readonly via?: Membership["via"];
  /** A declared scope name, or the resource of an `{ on }` membership. */
  readonly scope?: string;
};

export function filterMemberships(
  memberships: readonly Membership[],
  filter: MembershipFilter | undefined,
): readonly Membership[] {
  if (filter?.via === undefined && filter?.scope === undefined) {
    return memberships;
  }
  return memberships.filter(
    (entry) =>
      (filter.via === undefined || entry.via === filter.via) &&
      (filter.scope === undefined ||
        (entry.scope ?? entry.on?.resource) === filter.scope),
  );
}
