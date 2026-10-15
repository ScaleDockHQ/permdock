import type { Decision } from "./decision.ts";
import type { Permission } from "./permission-types.ts";
import type { Policy } from "./policy-types.ts";
import type { Membership, Principal, Subject } from "./subject.ts";
import type { Role } from "./vocabulary.ts";

import { compact } from "./compact.ts";
import { type EvalEnv, finish } from "./events.ts";
import { freezeDeep } from "./freeze.ts";
import { applyRoleKinds } from "./role-rank.ts";
import { normalizeMemberships, scopeList } from "./scopes.ts";

/** The roles, memberships and tenant `simulate()` previews in place of the subject's. */
export type SimulatePreview = {
  readonly roles?: readonly (string | Role)[];
  readonly memberships?: readonly Membership[];
  readonly tenant?: string;
};

export function previewSubject(
  policy: Policy,
  subject: Subject,
  preview: SimulatePreview,
): Subject {
  const previewRoles = preview.roles?.map((item) =>
    typeof item === "string" ? item : item.key,
  );
  const kinds =
    subject.principal === null
      ? undefined
      : applyRoleKinds(
          policy,
          previewRoles ?? subject.principal.roles,
          preview.memberships === undefined
            ? (subject.principal.memberships ?? [])
            : normalizeMemberships(
                preview.memberships,
                scopeList(policy.scopes),
              ),
        );
  const principal =
    subject.principal === null || kinds === undefined
      ? null
      : freezeDeep(
          compact<Principal>({
            ...subject.principal,
            roles: kinds.roles,
            memberships:
              preview.memberships === undefined &&
              subject.principal.memberships === undefined
                ? undefined
                : kinds.memberships,
            tenant: preview.tenant ?? subject.principal.tenant,
          }),
        );
  return freezeDeep({ ...subject, principal });
}

/** The one `simulate` event for a batch: the worst decision, with the counts. */
export function simulateEvent(
  policy: Policy,
  subject: Subject,
  env: EvalEnv,
  evaluated: readonly (readonly [Permission, unknown, Decision])[],
): void {
  const counts = { granted: 0, denied: 0, approvalRequired: 0 };
  for (const [, , decision] of evaluated) {
    if (decision.outcome === "granted") {
      counts.granted += 1;
    } else if (decision.outcome === "approval-required") {
      counts.approvalRequired += 1;
    } else {
      counts.denied += 1;
    }
  }
  const worst =
    evaluated.find(([, , decision]) => decision.outcome === "denied") ??
    evaluated.find(
      ([, , decision]) => decision.outcome === "approval-required",
    ) ??
    evaluated[0];
  if (worst === undefined) {
    return;
  }
  const [permission, data, decision] = worst;
  finish(
    policy,
    subject,
    permission,
    data,
    decision,
    { call: "simulate", trusted: true },
    { ...env, emit: true },
    true,
    undefined,
    counts,
  );
}
