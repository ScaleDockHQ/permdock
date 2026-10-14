import type { Decision, DenialReason, DeniedDecision } from "./decision.ts";
import type { DecideOptions, PermDock } from "./permdock.ts";
import type { Permission } from "./permission-types.ts";
import type { PrincipalSource } from "./principal-source.ts";
import type { Principal, Subject } from "./subject.ts";

import { freezeDeep } from "./freeze.ts";
import { loadPrincipal } from "./principal-source.ts";

/** Builds the target's instance in `tenant` from the caller's sources, with no sink, actor or delegation. */
export type TargetFactory = (
  principal: Principal,
  tenant: string | undefined,
) => PermDock | Promise<PermDock>;

export function deniedFor(
  permission: Permission,
  reason: DenialReason,
): DeniedDecision {
  return freezeDeep({
    outcome: "denied",
    permission: permission.key,
    denials: [{ role: null, reason }],
    alternatives: [],
  });
}

/** Rows are checked like `decide`; `call: 'can'` keeps every limit unconsumed. */
const PEEK: DecideOptions = Object.freeze({ call: "can" });

/**
 * What `permission` on `row` decides for the principal `principalId` in the
 * caller's active tenant. Never throws, never consumes a limit, and grants
 * the caller nothing: the target is a separate instance with its own caches.
 */
export async function decideForTarget(
  caller: Subject,
  principals: PrincipalSource | undefined,
  create: TargetFactory,
  principalId: string,
  permission: Permission,
  row: unknown,
): Promise<Decision> {
  if (caller.principal === null) {
    return deniedFor(permission, "anonymous");
  }
  const tenant = caller.principal.tenant;
  try {
    const principal = await loadPrincipal(principals, principalId, tenant);
    if (principal === null) {
      return deniedFor(permission, "anonymous");
    }
    const target = await create(principal, tenant);
    const outside =
      tenant !== undefined &&
      target.subject.principal?.tenant !== tenant &&
      (principal.kind !== "contact" || target.tenants().length > 0);
    if (outside) {
      return deniedFor(permission, "tenant-mismatch");
    }
    if (row !== undefined) {
      await target.loadRelations(permission, [row]);
    }
    return target.decide(permission, row, PEEK);
  } catch {
    return deniedFor(permission, "anonymous");
  }
}
