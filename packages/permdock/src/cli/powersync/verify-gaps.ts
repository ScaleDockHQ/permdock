import type { CustomRole } from "../../core/subject.ts";
import type { RlsFixture } from "../fixtures.ts";
import type { PowerSyncGap } from "./streams.ts";

import { CUSTOM_ROLE } from "./names.ts";

function heldRoles(subject: RlsFixture["subject"]): ReadonlySet<string> {
  return new Set([
    ...(subject.roles ?? []),
    ...(subject.memberships ?? []).flatMap((membership) => membership.roles),
  ]);
}

function customGap(gap: PowerSyncGap, roles: readonly CustomRole[]): boolean {
  if (gap.composed === true) {
    return roles.some(
      (role) =>
        (role.includes ?? []).length > 0 ||
        role.shared === true ||
        role.scope === "global",
    );
  }
  return roles.some((role) =>
    (role.grants ?? []).some(
      (grant) =>
        grant.permission === gap.permission &&
        (grant.effect ?? "allow") === "allow" &&
        (gap.level === undefined || (grant.level ?? null) === gap.level),
    ),
  );
}

/**
 * Whether `generate` warned for a grant the fixture's subject holds of
 * `permission`: a declared role it holds, `anyone` or `authenticated`, or a
 * custom role it holds at the warned level.
 */
export function warnedFor(
  unsynced: readonly PowerSyncGap[],
  permission: string,
  subject: RlsFixture["subject"],
  customRoles: readonly CustomRole[],
): boolean {
  const held = heldRoles(subject);
  const custom = customRoles.filter((role) => held.has(role.name));
  return unsynced.some((gap) => {
    if (gap.permission !== permission) {
      return false;
    }
    if (gap.role === CUSTOM_ROLE) {
      return customGap(gap, custom);
    }
    return (
      gap.role === "anyone" ||
      gap.role === "authenticated" ||
      held.has(gap.role)
    );
  });
}
