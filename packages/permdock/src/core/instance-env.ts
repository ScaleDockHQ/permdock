import type { LoadedApprovalPolicies } from "./approval-policies.ts";
import type { TargetFactory } from "./decide-for.ts";
import type { AuthEvent } from "./event-types.ts";
import type {
  DecisionSink,
  MembershipSource,
  RelationSource,
  CustomRoleSource,
  SettingsSource,
} from "./interfaces.ts";
import type { Limits } from "./limits.ts";
import type { DeriveOptions } from "./permdock.ts";
import type { Policy } from "./policy-types.ts";
import type { PrincipalSource } from "./principal-source.ts";
import type { RelationCache } from "./relations.ts";
import type { CustomRole, Subject } from "./subject.ts";

import { compact } from "./compact.ts";
import {
  assignableNamesFor,
  customRolesFor,
  roleSourceFor,
} from "./role-loading.ts";
import { scopeList } from "./scopes.ts";
import { heldRoleNamesIn, tenantsOf } from "./tenancy.ts";
import { isThenable } from "./thenable.ts";

/**
 * What an instance reads besides the policy and subject; `tenant()`, `team()`,
 * `simulate()` and `derive()` pass it on.
 */
export type InstanceEnv = {
  readonly customRoles: readonly CustomRole[];
  readonly sink: DecisionSink | undefined;
  readonly limits: Limits | undefined;
  readonly limitCache: Map<string, number>;
  readonly simulated: boolean;
  readonly roleSource: CustomRoleSource | undefined;
  /** `CustomRoleSource.assignable` per tenant, loaded with the custom roles. */
  readonly assignable?: ReadonlyMap<string, readonly string[]>;
  readonly queuedAuth: readonly AuthEvent[];
  /**
   * Errors from building the instance (a dropped hosted grant), replayed to
   * `on('error')`.
   */
  readonly queuedErrors?: readonly unknown[];
  readonly relations?: RelationSource;
  /**
   * Relation facts read so far; shared by the instances `tenant()`, `team()`
   * and `simulate()` derive.
   */
  readonly relationCache?: RelationCache;
  /** The membership source, for `whoCan`'s member lists. */
  readonly memberships?: MembershipSource;
  /** `ApprovalPolicySource` entries, loaded once with the instance. */
  readonly approvalPolicies?: LoadedApprovalPolicies;
  /** The source `decideFor` loads other principals from. */
  readonly principals?: PrincipalSource;
  /** Tenant settings `decideCredential` reads when a call passes none. */
  readonly settings?: SettingsSource;
  /** Builds a `decideFor` target from the options the instance was created with. */
  readonly targets: TargetFactory;
};

/**
 * The environment `derive(options)` builds on: `base` with the sources
 * `options` replaces loaded again.
 */
export function deriveEnv(
  policy: Policy,
  subject: Subject,
  base: InstanceEnv,
  relationCache: RelationCache,
  options: DeriveOptions,
): InstanceEnv | Promise<InstanceEnv> {
  const scopes = scopeList(policy.scopes);
  const tenants = tenantsOf(subject.principal, scopes);
  const auth: AuthEvent[] = [];
  const named =
    options.customRoles === undefined
      ? undefined
      : roleSourceFor(options.customRoles, subject, auth);
  const roleSource =
    options.customRoles === undefined ? base.roleSource : named;
  const roles =
    options.customRoles === undefined
      ? base.customRoles
      : customRolesFor(
          named,
          tenants,
          auth,
          subject.principal === null
            ? undefined
            : (subject.principal.roles ?? []),
          (tenant) => heldRoleNamesIn(subject.principal, scopes, tenant),
        );
  const names =
    options.customRoles === undefined
      ? base.assignable
      : assignableNamesFor(named, tenants, auth);
  const approvals =
    options.approvalPolicies === undefined
      ? base.approvalPolicies
      : options.approvalPolicies.load(policy, tenants, auth);
  const envWith = (
    loadedRoles: readonly CustomRole[],
    loadedNames: ReadonlyMap<string, readonly string[]> | undefined,
    loadedApprovals: LoadedApprovalPolicies | undefined,
  ): InstanceEnv =>
    compact<InstanceEnv>({
      ...base,
      customRoles: loadedRoles,
      roleSource,
      assignable: loadedNames,
      approvalPolicies: loadedApprovals,
      relations: options.relations ?? base.relations,
      principals: options.principals ?? base.principals,
      relationCache:
        options.relations === undefined ? relationCache : undefined,
      queuedAuth: auth,
      queuedErrors: [],
    });
  if (isThenable(roles) || isThenable(names) || isThenable(approvals)) {
    return Promise.all([roles, names, approvals]).then(
      ([loadedRoles, loadedNames, loadedApprovals]) =>
        envWith(loadedRoles, loadedNames, loadedApprovals),
    );
  }
  return envWith(roles, names, approvals);
}
